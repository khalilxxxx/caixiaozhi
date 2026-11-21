"""同一报销单内的票据核对、费用生成和草稿保存。"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from hashlib import sha256
import json
from uuid import uuid4

from business import ACTIVITY_FIELDS, EXPENSE_FIELDS, BusinessError, draft_type, now
from store import encode
from submission_defaults import apply_submission_defaults


def effective_draft(state, draft_id, *, editable=True):
    submissions = state['data']['submissions']
    saved = submissions['drafts'].get(draft_id)
    if not saved or draft_type(saved) not in ('expense', 'personal'):
        raise BusinessError('INVALID_DRAFT', '请选择一张费用报销单。')
    if saved.get('status') != 'draft':
        if editable:
            raise BusinessError('DRAFT_LOCKED', '报销单已提交，请新建报销单。')
        return saved
    return submissions.get('edits', {}).get(draft_id, saved)


def checked_ids(ids, *, allow_empty=False):
    if (not isinstance(ids, list) or len(ids) > 30 or (not ids and not allow_empty)
            or any(not isinstance(key, str) or not key.strip() or len(key) > 200 for key in ids)
            or len(ids) != len(set(ids))):
        raise BusinessError('INVALID_FILES', '单次最多选择30份不同的材料。')
    return ids


def batch_row(db, draft_id, batch_id):
    row = db.execute('SELECT body FROM reimbursement_batches WHERE id=? AND draft_id=?', (batch_id, draft_id)).fetchone()
    if not row:
        raise BusinessError('BATCH_NOT_FOUND', '当前报销单中没有这批材料。')
    return json.loads(row['body'])


def persist(db, batch):
    db.execute('UPDATE reimbursement_batches SET body=? WHERE id=?', (encode(batch), batch['id']))


def public_batch(batch):
    return {k: v for k, v in batch.items() if k not in ('items', 'assignments', 'originalHeader')}


def reviewable(batch, revision):
    if batch['status'] != 'review' or batch['revision'] != revision:
        raise BusinessError('BATCH_CONFLICT', '分组已有变化，请重新打开核对。')


def file_claims(draft):
    for expense in draft.get('expenses', []):
        if expense.get('sourceFileId'):
            yield expense['sourceFileId']
        for field in ('files', 'attachments'):
            for file in expense.get(field, []):
                if file.get('id'):
                    yield file['id']


class ReimbursementService:
    def __init__(self, store):
        self.store = store
        self.limit = asyncio.Semaphore(3)

    def get(self, draft_id, batch_id=None):
        with self.store.connect() as db:
            if batch_id:
                return public_batch(batch_row(db, draft_id, batch_id))
            row = db.execute('SELECT body FROM reimbursement_batches WHERE draft_id=? ORDER BY rowid DESC LIMIT 1',
                             (draft_id,)).fetchone()
        return public_batch(json.loads(row['body'])) if row else None

    async def recognize(self, ids, draft_id):
        from material_service import extract_materials
        # 检查整个选择与当前单据，避免对无效的请求开始识别。
        effective_draft(self.store.get_state(), draft_id)
        uploaded = {}
        for key in ids:
            row = self.store.get_file(key)
            if not row:
                raise BusinessError('FILE_NOT_FOUND', '所选文件没有可读取的原件，请重新上传。')
            uploaded[key] = row['metadata']

        async def read(key):
            async with self.limit:
                try:
                    result = await extract_materials(self.store, [key], draft_id, reimbursement=True)
                    file = next(f for f in result['files'] if f['id'] == key)
                    return file, result['items']
                except (ValueError, TimeoutError, StopIteration) as exc:
                    message = getattr(exc, 'message', '') or '材料识别未完成，请重试或重新上传。'
                    metadata = {k: v for k, v in uploaded[key].items() if k != 'text'}
                    return {**metadata, 'status': 'failed', 'extractionStatus': 'failed', 'extractionError': message}, []

        results = await asyncio.gather(*(read(key) for key in ids))
        return [file for file, _ in results], [item for _, items in results for item in items]

    def project(self, batch, state, db, *, refresh=False, editing_expense=None):
        from reimbursement_batch import build_reimbursement_batch, identity
        draft = effective_draft(state, batch['draftId'])
        if editing_expense:
            draft = {**draft, 'expenses': [e for e in draft['expenses'] if e.get('id') != editing_expense]}
        # 识别相同原件的重新上传，及同一单内已经生成的费用。
        documents = [draft, *(r.get('snapshot', {}) for r in state['data']['submissions'].get('requests', []))]
        used = {key for document in documents for key in file_claims(document)}
        numbers = {identity(number) for document in documents for expense in document.get('expenses', [])
                   for number in expense.get('receiptInvoiceNumbers', []) if number}
        digests = set()
        for key in used:
            row = db.execute('SELECT metadata FROM files WHERE id=?', (key,)).fetchone()
            if row:
                metadata = json.loads(row['metadata'])
                recognition = metadata.get('materialRecognition', {}).get('recognition') or {}
                if recognition.get('role') == 'invoice':
                    number = identity(recognition.get('facts', {}).get('invoiceNumber'))
                    if number:
                        numbers.add(number)
                digest = metadata.get('sha256')
                if digest:
                    digests.add(digest)
        files = []
        blocked = {}
        for file in batch['files']:
            recognition = file.get('recognition') or {}
            number = identity(recognition.get('facts', {}).get('invoiceNumber'))
            if file['id'] in used or (file.get('sha256') and file['sha256'] in digests):
                blocked[file['id']] = '材料已用于本单费用或已受理的报销单。'
            elif recognition.get('role') in ('invoice', 'unknown') and number and number in numbers:
                blocked[file['id']] = '相同发票号码已用于本单费用或已受理的报销单。'
            else:
                files.append(file)
        assignments = batch.get('assignments')
        if assignments is not None and blocked:
            if refresh:
                assignments = [{**g, **{k: [fid for fid in g[k] if fid not in blocked]
                                         for k in ('invoiceFileIds', 'attachmentFileIds')}} for g in assignments]
                batch['assignments'] = assignments = [g for g in assignments if g['invoiceFileIds']]
            elif any(key in blocked for g in assignments for key in g['invoiceFileIds'] + g['attachmentFileIds']):
                raise BusinessError('MATERIAL_CONFLICT', '所选材料已有对应费用，请重新核对分组。',
                                    {'blockedFileIds': list(blocked)})
        projected = build_reimbursement_batch(files, batch['items'], draft, state['data']['expenseCategories'], assignments)
        projected['unassignedFileIds'] = list(dict.fromkeys([*projected['unassignedFileIds'], *blocked]))
        projected.setdefault('unassignedReasons', {}).update(blocked)
        projected['unavailableFileIds'] = list(dict.fromkeys([*projected.get('unavailableFileIds', []), *blocked]))
        return projected

    async def line_preview(self, draft_id, expense_id, invoices, attachments, category_id):
        """编辑器已经明确了本行范围，只返回建议，实际保存仍走现有草稿事务。"""
        ids = checked_ids(invoices + attachments)
        files, items = await self.recognize(ids, draft_id)
        failed = [f for f in files if not f.get('recognition') or f['recognition'].get('multipleDocuments')]
        if failed:
            return {'expense': None, 'evidence': {}, 'issues': [
                f"{f['name']}：{f.get('extractionError') or '请核对原件后重试。'}" for f in failed]}
        if not invoices:
            return {'expense': None, 'evidence': {}, 'issues': ['附件已识别，请添加本笔费用的发票。']}
        choice = {'invoiceFileIds': invoices, 'attachmentFileIds': attachments, 'categoryId': category_id}
        scoped = {'draftId': draft_id, 'files': files, 'items': items, 'assignments': [choice]}
        state = self.store.get_state()
        with self.store.connect() as db:
            try:
                projection = self.project(scoped, state, db, editing_expense=expense_id)
            except BusinessError as error:
                if error.code != 'VALIDATION_ERROR':
                    raise
                automatic = self.project({**scoped, 'assignments': None}, state, db, editing_expense=expense_id)
                wrong_role = [file['id'] for file in files if (
                    file['id'] in invoices and file['recognition']['role'] in ('payment', 'supporting')
                    or file['id'] in attachments and file['recognition']['role'] == 'invoice')]
                return {'expense': None, 'evidence': {}, 'issues': [error.message],
                        'blockedFileIds': list(dict.fromkeys([*automatic['unavailableFileIds'], *wrong_role]))}
        group, = projection['groups']
        if len(invoices) > 1:
            from reimbursement_batch import conflicting_invoices, receipt_records
            records, _ = receipt_records(files)
            if conflicting_invoices([records[fid] for fid in invoices]):
                group['issues'].append('发票的商户、交易或服务项目有差异，请核对是否需要在“发票转费用”中分笔。')
        group['expense']['receiptInvoiceNumbers'] = [number for file in files if file['id'] in invoices
            if (number := file['recognition']['facts'].get('invoiceNumber'))]
        return {'expense': group['expense'], 'issues': group['issues'], 'evidence': group['evidence']}

    async def create(self, draft_id, ids, previous_batch_id=None):
        checked_ids(ids)
        draft = effective_draft(self.store.get_state(), draft_id)
        signature = sha256(encode(sorted(ids)).encode()).hexdigest()
        def existing(db):
            row = db.execute('SELECT body FROM reimbursement_batches WHERE draft_id=? AND file_set=?',
                             (draft_id, signature)).fetchone()
            return public_batch(json.loads(row['body'])) if row else None
        with self.store.connect() as db:
            if previous_batch_id:
                batch_row(db, draft_id, previous_batch_id)
            cached = existing(db)
        if cached:
            return cached
        files, items = await self.recognize(ids, draft_id)
        def save(state, db):
            repeated = existing(db)
            if repeated:
                return repeated
            batch = {'id': 'rb-' + uuid4().hex, 'draftId': draft_id, 'revision': 1, 'status': 'review',
                     'files': files, 'items': items, 'assignments': None,
                     'originalHeader': {'purpose': draft.get('purpose', ''), 'activities': draft.get('activities', [])}}
            batch.update(self.project(batch, state, db))
            # 追加材料时保留上一批中已人工调整的分组、类型及明确未计入的原件。
            if previous_batch_id:
                earlier = batch_row(db, draft_id, previous_batch_id)
                old_files = {f['id'] for f in earlier['files']}
                if earlier['status'] == 'review' and earlier.get('assignments') is not None and old_files < set(ids):
                    kept = deepcopy(earlier['assignments'])
                    for group in batch['groups']:
                        invoices = [key for key in group['invoiceFileIds'] if key not in old_files]
                        attachments = [key for key in group['attachmentFileIds'] if key not in old_files]
                        old_invoices = set(group['invoiceFileIds']) & old_files
                        matches = [g for g in kept if old_invoices & set(g['invoiceFileIds'])]
                        if len(matches) == 1 and old_invoices <= set(matches[0]['invoiceFileIds']):
                            matches[0]['invoiceFileIds'].extend(invoices)
                            matches[0]['attachmentFileIds'].extend(attachments)
                        elif invoices:
                            kept.append({'invoiceFileIds': invoices, 'attachmentFileIds': attachments if not old_invoices else []})
                    batch['assignments'] = kept
                    batch.update(self.project(batch, state, db, refresh=True))
            db.execute('INSERT INTO reimbursement_batches VALUES(?,?,?,?)', (batch['id'], draft_id, signature, encode(batch)))
            return public_batch(batch)
        return self.store.mutate_with_db(save)

    async def review(self, draft_id, batch_id, revision, assignments=None, retry_ids=None):
        latest = self.get(draft_id, batch_id)
        reviewable(latest, revision)
        retry_ids = checked_ids(retry_ids or [], allow_empty=True)
        retryable = {file['id'] for file in latest['files'] if file.get('extractionStatus') != 'extracted'}
        if set(retry_ids) - retryable:
            raise BusinessError('INVALID_FILES', '仅可重试本批次中识别未完成的材料。')
        files, items = await self.recognize(retry_ids, draft_id) if retry_ids else ([], [])
        def save(state, db):
            batch = batch_row(db, draft_id, batch_id)
            reviewable(batch, revision)
            if files:
                replaced = {file['id']: file for file in files}
                batch['files'] = [replaced.get(file['id'], file) for file in batch['files']]
                batch['items'] = [i for i in batch['items'] if i.get('sourceFileId') not in replaced] + items
            if assignments is not None:
                batch['assignments'] = assignments
            batch.update(self.project(batch, state, db, refresh=assignments is None))
            batch['revision'] += 1
            persist(db, batch)
            return public_batch(batch)
        return self.store.mutate_with_db(save)

    def apply(self, draft_id, batch_id, revision, include_header):
        def save(state, db):
            batch = batch_row(db, draft_id, batch_id)
            if batch['status'] == 'applied':
                return {'batch': public_batch(batch), 'draft': effective_draft(state, draft_id, editable=False)}
            reviewable(batch, revision)
            draft = effective_draft(state, draft_id)
            projection = self.project(batch, state, db)
            # 行程被占用、新的同票费用等变化都会改变本次所见的分组或字段。
            if projection['groups'] != batch['groups']:
                raise BusinessError('BATCH_CONFLICT', '费用依据已变化，请刷新分组后重新生成。')
            if not batch['groups']:
                raise BusinessError('EMPTY_GROUPS', '请先核对材料归属，至少保留一笔费用。')
            candidate = deepcopy(draft)
            source_ids = set()
            invoice_numbers = {file['id']: (file.get('recognition') or {}).get('facts', {}).get('invoiceNumber') for file in batch['files']}
            for group in projection['groups']:
                expense = {**dict.fromkeys(EXPENSE_FIELDS, ''), **group['expense'], 'id': 'expense-' + uuid4().hex,
                           'generated': True, 'sourceBatchId': batch_id, 'reimbursementBatchId': batch_id,
                           'receiptEvidence': group.get('evidence', {}),
                           'receiptInvoiceNumbers': [invoice_numbers[fid] for fid in group['invoiceFileIds'] if invoice_numbers.get(fid)]}
                expense['receiptPrefill'] = {k: expense[k] for k in EXPENSE_FIELDS if k != 'id' and expense.get(k)}
                candidate['expenses'].append(expense)
                source_ids.update(group['invoiceFileIds'] + group['attachmentFileIds'])
            candidate['materialIds'] = list(dict.fromkeys([*candidate.get('materialIds', []),
                                       *(file['id'] for file in batch['files'] if file['id'] in source_ids)]))
            header = projection['header']
            original = batch.get('originalHeader', {})
            if include_header and not draft.get('purpose', '').strip() and not original.get('purpose'):
                candidate['purpose'] = header.get('purpose') or ''
            if include_header and draft.get('activityMode') != 'hidden':
                for activity in header.get('activities', []):
                    previous = candidate['activities']
                    if any((activity.get('activityNumber') and activity['activityNumber'] == row.get('activityNumber'))
                           or (activity.get('oaNumber') and activity['oaNumber'] == row.get('oaNumber'))
                           or (activity.get('description') and activity['description'] == row.get('description')
                               and not (activity.get('activityNumber') or activity.get('oaNumber')))
                           for row in [*previous, *original.get('activities', [])]):
                        continue
                    previous.append({**dict.fromkeys(ACTIVITY_FIELDS, ''), **activity, 'id': 'activity-' + uuid4().hex})
            if any(len(candidate.get(field, [])) > 100 for field in ('expenses', 'activities', 'materialIds')):
                raise BusinessError('DRAFT_LIMIT', '单据的费用、活动或材料数量超过100项，请调整本次选择。')
            submissions = state['data']['submissions']
            saved = submissions['drafts'][draft_id]
            candidate = apply_submission_defaults(candidate, draft)
            candidate.update(version=saved['version'] + 1, savedAt=now())
            submissions['drafts'][draft_id] = candidate
            submissions.setdefault('edits', {}).pop(draft_id, None)
            submissions.setdefault('checks', {}).pop(draft_id, None)
            batch.update(status='applied', revision=revision + 1)
            persist(db, batch)
            return {'batch': public_batch(batch), 'draft': candidate}
        return self.store.mutate_with_db(save)
