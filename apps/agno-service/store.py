"""SQLite is the authoritative state for the local, single-user product."""
from __future__ import annotations
import copy
import json
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from rule_catalog import migrate_rules
from rule_service import validate_semantic_rule
from submission_defaults import apply_submission_defaults, merge_draft_patch, reimbursement_number
from clarification_service import expire_questions, pending_question


def now():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def migrate_reimbursement_numbers(data):
    submissions = data.get('submissions', {})
    accepted = {r.get('draftId'): r.get('businessId') for r in submissions.get('requests', [])}
    changed = False
    for key, draft in submissions.get('drafts', {}).items():
        if (draft.get('type') or key) not in ('personal', 'expense'):
            continue
        if not draft.get('documentNumber'):
            draft['documentNumber'] = accepted.get(key) or reimbursement_number(submissions)
            changed = True
        edit = submissions.get('edits', {}).get(key)
        if edit is not None and edit.get('documentNumber') != draft['documentNumber']:
            edit['documentNumber'] = draft['documentNumber']
            changed = True
    return changed


def run_timing(created, finished=None):
    timing = {'runStartedAt': int(datetime.fromisoformat(created).timestamp() * 1000)} if created else {}
    if finished:
        timing['runFinishedAt'] = int(datetime.fromisoformat(finished).timestamp() * 1000)
    return timing


def finish_message_steps(message, run_status, finished):
    """Close interrupted operations without discarding earlier outcomes/cards."""
    message['runStatus'] = run_status
    changed = []
    for step in message.get('tools', []):
        if step.get('status') != 'running':
            continue
        started = step.get('startedAt')
        step.update(status='cancelled', finishedAt=finished,
                    durationMs=max(0, finished - started) if finished is not None and isinstance(started, (int, float)) else None)
        changed.append(copy.deepcopy(step))
    return changed


def restore_result(task, run_id, message, result, status):
    # Only the matching reply can be restored. Later business activity and the
    # user's answer to a question may have changed since this event was saved.
    snapshot = result.get('workspace', {}).get('state', {})
    archived_task = next((item for item in snapshot.get('tasks', []) if item['id'] == task['id']), {})
    message_id = 'assistant-' + run_id
    archived = archived_task.get('messages', [])
    position = next((i for i, entry in enumerate(archived) if entry.get('id') == message_id), len(archived))
    archive = archived[position] if position < len(archived) else result
    if message is None:
        message = {'id': message_id, 'role': 'assistant', 'runId': run_id}
        messages = task.setdefault('messages', [])
        if position < len(archived):
            before = {entry.get('id') for entry in archived[:position]}
            index = max((i + 1 for i, entry in enumerate(messages) if entry.get('id') in before), default=0)
            messages.insert(index, message)
        else:
            messages.append(message)
    for key in ('text', 'cards', 'tools', 'createdAt', 'capability', 'expertTeamName', 'submissionPhase'):
        if key in archive:
            message[key] = archive[key]
    question = archive.get('question')
    if question and not message.get('question'):
        answered = next((m.get('questionAnswer') for m in task['messages']
                         if (m.get('questionAnswer') or {}).get('questionId') == question['id']), None)
        if answered and answered.get('deferred'):
            question = {**question, 'status': 'deferred'}
        elif answered:
            question = {**question, 'status': 'answered', 'answer': {k: answered[k] for k in ('text', 'optionIds') if k in answered}}
        message['question'] = question
    message['runStatus'] = 'awaiting_input' if archive.get('runStatus') == 'awaiting_input' or message.get('question') else status
    return message


def clear_finished_run(task, run_id, status, result):
    if not task or task.get('activeRunId') != run_id:
        return
    task['activeRunId'] = None
    if task.get('status') not in (None, '处理中'):
        return
    if pending_question(task):
        task['status'] = '待你回答'
    elif status in ('failed', 'cancelled', 'interrupted'):
        task['status'] = '执行失败' if status == 'failed' else '已暂停'
    elif result.get('status') in ('本地已受理', '待我核对', '已完成'):
        task['status'] = result['status']
    else:
        review = task.get('type') in ('submission', 'materials', 'audit') or status == 'awaiting_input'
        task['status'] = '待我核对' if review else '已完成'


def migrate_travel_application_fixture(data, seeded_data):
    """给已有本机演示工作区补入新样例，保留已持久化的单据状态。"""
    key = 'travel/travel_application/TA-20261113-015'
    fixture = next((doc for doc in seeded_data.get('documents', []) if doc.get('key') == key), None)
    if fixture is None:
        return False
    documents = data.get('documents')
    if not isinstance(documents, list) or any(doc.get('key') == key for doc in documents):
        return False
    documents.append(copy.deepcopy(fixture))
    return True


def migrate_expense_progress_fixture(data, seeded_data):
    """只为原始的北京拜访样例补入逐笔费用和影像，已修改或已删除的单据保留原状。"""
    key = 'expense/expense_claim/EX-20261116-018'
    new_fields = ('version', 'expenses', 'files')
    fixture = next((doc for doc in seeded_data.get('documents', []) if doc.get('key') == key), None)
    if not fixture or fixture.get('synthetic') is not True or any(field not in fixture for field in new_fields):
        return False
    documents = data.get('documents')
    if not isinstance(documents, list):
        return False
    originals = [doc for doc in documents if isinstance(doc, dict) and doc.get('key') == key]
    legacy = {field: value for field, value in fixture.items() if field not in new_fields}
    if len(originals) != 1 or originals[0].get('synthetic') is not True or originals[0] != legacy:
        return False
    originals[0].update({field: copy.deepcopy(fixture[field]) for field in new_fields})
    return True


def migrate_work_document_fixtures(data, seeded_data):
    """补齐本地示例的业务事实，并使修改前的审核快照失效。"""
    previous_version = data.get('workDocumentFixtureVersion', 0)
    if previous_version >= 2:
        return False
    fixtures = {doc['id']: doc for doc in seeded_data.get('auditDocuments', [])}
    documents = data.get('auditDocuments')
    if (not isinstance(data.get('rulesSubmission', {}).get('rules'), list)
        or not isinstance(documents, list) or not any(doc.get('id') in fixtures for doc in documents)):
        return False
    scope_original_travel_reminder(data, seeded_data)
    if previous_version == 1:
        data['workDocumentFixtureVersion'] = 2
        return True
    added_ids = {
        'OA-20261119-022', 'OA-20261120-023', 'BX-20261118-007',
        'BX-20261120-008', 'OA-20261119-024',
    }
    existing_ids = {doc.get('id') for doc in documents}
    affected_ids = []
    for doc in documents:
        fixture = fixtures.get(doc.get('id'))
        if not fixture:
            continue
        # 新库数据已完整；历史库只更新仍与原始示例匹配的单据。
        if doc == fixture:
            affected_ids.append(doc['id'])
        elif (doc.get('version') == fixture['version'] - 1
              and all(value == fixture[key] for key, value in doc.items() if key in fixture and key != 'version')):
            doc.update(copy.deepcopy(fixture))
            affected_ids.append(doc['id'])
    for doc_id, fixture in fixtures.items():
        if doc_id in added_ids and doc_id not in existing_ids:
            documents.append(copy.deepcopy(fixture))
            affected_ids.append(doc_id)
    # business 依赖 Store；仅在数据库与工作区都准备好后加载。
    from business import review_work_examples
    review_work_examples(data, affected_ids)
    data['workDocumentFixtureVersion'] = 2
    return True


def scope_original_travel_reminder(data, seeded_data):
    """保留本人的启停和自定义逻辑，给原版出差规则补上差旅申请范围。"""
    centers = ('rulesSubmission', 'srsRuleCenterV1')
    originals = [next((rule for rule in data.get(key, {}).get('rules', []) if rule.get('id') == 'P002'), {})
                 for key in centers]
    old_definition = {
        'name': '长时间出差提醒', 'metric': 'days', 'thresholdDays': 5, 'description': '申请天数超过5天时，审单时提醒我。',
        'system': 'oa', 'scope': 'review', 'origin': 'personal', 'effect': 'warn',
    }
    if any(rule.get('documentTypes') or any(rule.get(key) != value for key, value in old_definition.items())
           for rule in originals):
        return
    old_detail = {
        'logic': 'OA申请天数超过5天时，审单时提醒本人。',
        'output': '每张OA申请输出一条天数检查结果，列明申请天数与阈值。',
        'applicability': ['OA办公系统', '审单场景'],
        'evidence': [{'name': '申请天数', 'source': 'OA申请 · 申请信息', 'purpose': '读取本次申请的天数'}],
    }
    if any(originals[1].get(key) != value for key, value in old_detail.items()):
        return
    for key, rule in zip(centers, originals):
        updated = next(item for item in seeded_data[key]['rules'] if item['id'] == 'P002')
        rule.update(documentTypes=['travel'], version=rule.get('version', 1) + 1, description=updated['description'])
        if key == 'srsRuleCenterV1':
            for field in ('logic', 'output', 'applicability', 'evidence'):
                rule[field] = copy.deepcopy(updated[field])
            rule['updatedAt'] = now()
            rule.setdefault('revisions', []).append({
                'version': rule['version'], 'at': rule['updatedAt'],
                'summary': '将原有出差天数提醒限定于差旅申请。', 'logic': rule['logic'],
            })


def remove_invoice_verification(data):
    """迁移当前规则与缓存，历史申请快照和回执由原事务继续持有。"""
    before = encode(data)
    centers = [data[key] for key in ('rulesSubmission', 'srsRuleCenterV1') if isinstance(data.get(key), dict)]
    removed_ids = {'R003'}
    for center in centers:
        for field in ('rules', 'reviewedRules'):
            removed_ids.update(rule['id'] for rule in center.get(field, [])
                               if rule.get('metric') == 'validInvoice' and rule.get('id'))
        for field in ('drafts', 'ruleForms'):
            forms = center.get(field, {})
            if isinstance(forms, dict):
                removed_ids.update(key for key, value in forms.items()
                                   if isinstance(value, dict) and value.get('metric') == 'validInvoice')

    def obsolete(value):
        return isinstance(value, dict) and (value.get('metric') == 'validInvoice' or value.get('id') in removed_ids)

    def clean(value):
        if isinstance(value, list):
            return [clean(item) for item in value if not obsolete(item)]
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if key not in removed_ids and not obsolete(item)}
        return value

    changed_rules = False
    for center in centers:
        old = encode(center)
        for field in ('rules', 'reviewedRules', 'ruleForms', 'drafts', 'notes'):
            if field in center:
                center[field] = clean(center[field])
        if center.get('editingId') in removed_ids:
            center['editingId'] = None
        if encode(center) != old:
            changed_rules = True
    checks = data.get('submissions', {}).get('checks', {})
    if changed_rules or 'validInvoice' in encode(checks):
        checks.clear()
    if changed_rules and 'rulesSubmission' in data:
        data['rulesSubmission'].setdefault('reviewedAt', {})['expense'] = ''
    for document in data.get('auditDocuments', []):
        document.pop('validInvoice', None)
    for policy in data.get('policies', []):
        for clause in policy.get('clauses', []):
            if isinstance(clause.get('text'), str):
                clause['text'] = clause['text'].replace('查验结果不明确的票据应补充核验。', '提取信息缺失或不明确时，由本人补充并核对。')
    return encode(data) != before


class Conflict(Exception):
    pass


def merge_submissions(current, incoming):
    """浏览器只能编辑草稿，回执、校验和已提交快照由业务事务持有。"""
    result = copy.deepcopy(current)
    editable = {
        'title', 'applicant', 'department', 'paymentCompany', 'travelType',
        'purpose', 'legs', 'activities', 'activityMode', 'companions',
        'applicationId', 'expenses', 'files', 'subsidyCents', 'materialIds',
        'sourceImportKey', 'legacyPeriod', 'returnDatePending',
    }
    if not isinstance(incoming, dict):
        raise Conflict('草稿数据格式无效。')
    incoming_drafts = incoming.get('drafts', {})
    incoming_edits = incoming.get('edits', {})
    if not isinstance(incoming_drafts, dict) or not isinstance(incoming_edits, dict):
        raise Conflict('草稿数据格式无效。')
    for draft_id, original in current.get('drafts', {}).items():
        if original.get('status') != 'draft':
            result.setdefault('edits', {}).pop(draft_id, None)
            continue
        received = incoming_drafts.get(draft_id)
        saved = result['drafts'][draft_id]
        if received is not None:
            if not isinstance(received, dict):
                raise Conflict('草稿字段格式无效。')
            if 'returnDatePending' in received and not isinstance(received['returnDatePending'], bool):
                raise Conflict('返程日期待定标志必须为布尔值。')
            changed = any(key in received and received[key] != original.get(key) for key in editable)
            if changed:
                baseline = current.get('edits', {}).get(draft_id, original)
                try:
                    candidate = merge_draft_patch(baseline, {key: received[key] for key in editable if key in received})
                    saved.update(apply_submission_defaults(candidate, baseline))
                except ValueError as exc:
                    raise Conflict(str(exc)) from None
                saved['version'] = original['version'] + 1
                saved['savedAt'] = now()
                result.setdefault('checks', {}).pop(draft_id, None)
                if 'edits' not in incoming:
                    result.setdefault('edits', {}).pop(draft_id, None)
        if 'edits' in incoming:
            edit = incoming_edits.get(draft_id)
            if edit is None:
                result.setdefault('edits', {}).pop(draft_id, None)
            elif isinstance(edit, dict):
                baseline = current.get('edits', {}).get(draft_id, original)
                try:
                    candidate = merge_draft_patch(baseline, {key: edit[key] for key in editable if key in edit})
                    effective = apply_submission_defaults(candidate, baseline)
                except ValueError as exc:
                    raise Conflict(str(exc)) from None
                effective.update(version=saved['version'], status='draft', id=draft_id)
                result.setdefault('edits', {})[draft_id] = effective
                if any(effective.get(key) != baseline.get(key) for key in editable):
                    result.setdefault('checks', {}).pop(draft_id, None)
            else:
                raise Conflict('草稿编辑内容格式无效。')
    return result


def merge_rule_list(previous, incoming, detailed=False):
    """内置定义不可由客户端改写；本地用户可以显式启停。新规则只能属于个人。"""
    if not isinstance(incoming, list):
        raise Conflict('规则列表格式无效。')
    builtin = {rule['id']: rule for rule in previous if rule.get('origin') == 'builtin'}
    seen = set()
    output = []
    for received in incoming:
        if not isinstance(received, dict) or not isinstance(received.get('id'), str) or received['id'] in seen:
            raise Conflict('规则标识无效或重复。')
        rule_id = received['id']
        seen.add(rule_id)
        if rule_id in builtin:
            value = copy.deepcopy(builtin[rule_id])
            if isinstance(received.get('enabled'), bool):
                value['enabled'] = received['enabled']
            output.append(value)
            continue
        if received.get('metric') not in ('amount', 'meal', 'hotelNight', 'days', 'invoiceUnique', 'attachment', 'semantic') or received.get('system') not in ('oa', 'expense') or received.get('scope') not in ('both', 'submit', 'review'):
            raise Conflict('个人规则条件或范围无效。')
        value = copy.deepcopy(received)
        value['origin'] = 'personal'
        if value.get('effect') != 'warn':
            raise Conflict('个人规则仅可提醒本人，不能阻断提单。')
        try:
            validate_semantic_rule(value)
        except ValueError as error:
            raise Conflict(str(error)) from None
        if detailed:
            value['source'] = '本人维护'
        for key in ('thresholdMinor', 'thresholdDays'):
            if key in value and (isinstance(value[key], bool) or not isinstance(value[key], int) or value[key] < 0):
                raise Conflict('规则阈值须为非负整数。')
        output.append(value)
    output.extend(copy.deepcopy(value) for key, value in builtin.items() if key not in seen)
    return output


class Store:
    def __init__(self, path, seed=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
                CREATE TABLE IF NOT EXISTS business_board_results (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
                    kind TEXT NOT NULL, body TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS board_results_run ON business_board_results(run_id,kind);
                CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, storage_name TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS translations (file_id TEXT PRIMARY KEY REFERENCES files(id), result TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reimbursement_batches (
                    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, file_set TEXT NOT NULL, body TEXT NOT NULL,
                    UNIQUE(draft_id, file_set)
                );
            ''')
            default_seed = seed is None
            if default_seed:
                seed_path = Path(__file__).with_name('seed.json')
                seed = json.loads(seed_path.read_text()) if seed_path.exists() else {'data': {}, 'tasks': [], 'activeTask': None}
            seed = copy.deepcopy(seed)
            remove_invoice_verification(seed.get('data', {}))
            migrate_rules(seed.get('data', {}))
            inserted = db.execute('INSERT OR IGNORE INTO workspace VALUES(1,0,?)', (encode(seed),)).rowcount == 1
            row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
            state = json.loads(row['state'])
            changed = remove_invoice_verification(state.get('data', {}))
            changed = migrate_rules(state.get('data', {})) or changed
            changed = migrate_reimbursement_numbers(state.get('data', {})) or changed
            if default_seed:
                changed = migrate_travel_application_fixture(state.get('data', {}), seed.get('data', {})) or changed
                changed = migrate_expense_progress_fixture(state.get('data', {}), seed.get('data', {})) or changed
                changed = migrate_work_document_fixtures(state.get('data', {}), seed.get('data', {})) or changed
                from work_decisions import migrate_approval_assignments
                changed = migrate_approval_assignments(state.get('data', {}), seed.get('data', {})) or changed
            changed = expire_questions(state) or changed
            if changed:
                # 首次创建和初始演示数据同属一次事务，对外仍从版本 0 开始。
                revision = row['revision'] if inserted else row['revision'] + 1
                db.execute('UPDATE workspace SET revision=?,state=? WHERE id=1', (revision, encode(state)))

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def snapshot(self):
        with self.lock, self.connect() as db:
            row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
            return {'state': json.loads(row['state']), 'revision': row['revision']}

    def get_state(self):
        return self.snapshot()['state']

    def mutate(self, fn, *, only_if_changed=False):
        return self.mutate_with_db(lambda state, db: fn(state), only_if_changed=only_if_changed)

    def mutate_with_db(self, fn, *, only_if_changed=False):
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
            state = json.loads(row['state'])
            result = fn(state, db)
            expire_questions(state)
            updated = encode(state)
            if not only_if_changed or updated != row['state']:
                db.execute('UPDATE workspace SET revision=?,state=? WHERE id=1', (row['revision'] + 1, updated))
            return copy.deepcopy(result)

    def patch(self, patch):
        with self.lock:
            if patch.get('baseRevision') != self.snapshot()['revision']:
                raise Conflict('数据已更新，请同步后重试。')
            def apply(state):
                updates = patch.get('data', {})
                # Receipts and ledgers can only be written by business transactions.
                protected = {'receipts', 'submissionLedger', 'documents', 'analysisRecords', 'auditDocuments',
                             'handledWorkDocuments', 'workDecisionLedger', 'workDecisionFixtureVersion',
                             'workDocumentFixtureVersion', 'expenseCategories', 'policies', 'toolResults', 'ruleMigration', 'publicFinancialReports'}
                for key, value in updates.items():
                    if key == 'submissions' and key in state['data']:
                        state['data'][key] = merge_submissions(state['data'][key], value)
                    elif key in ('rulesSubmission', 'srsRuleCenterV1') and key in state['data']:
                        previous = state['data'][key]
                        merged = copy.deepcopy(previous)
                        if not isinstance(value, dict):
                            raise Conflict('规则配置格式无效。')
                        if 'rules' in value:
                            merged['rules'] = merge_rule_list(previous['rules'], value['rules'], detailed=key == 'srsRuleCenterV1')
                        fields = ('notes', 'schedule', 'ruleForms', 'auditFilter') if key == 'rulesSubmission' else ('drafts', 'editingId')
                        for field in fields:
                            if field in value:
                                merged[field] = copy.deepcopy(value[field])
                        if key == 'rulesSubmission' and merged['rules'] != previous['rules']:
                            state['data'].get('submissions', {}).setdefault('checks', {}).clear()
                        state['data'][key] = merged
                    elif key not in protected:
                        state['data'][key] = value
                remove_invoice_verification(state['data'])
                deleted = set(patch.get('deletedTaskIds', []))
                state['tasks'] = [t for t in state['tasks'] if t['id'] not in deleted or t.get('activeRunId')]
                for incoming in patch.get('tasks', []):
                    current = next((t for t in state['tasks'] if t['id'] == incoming['id']), None)
                    if current is None:
                        fresh = copy.deepcopy(incoming)
                        fresh.pop('activeRunId', None)
                        for message in fresh.get('messages', []):
                            message.pop('question', None)
                            message.pop('questionAnswer', None)
                        if fresh.get('status') == '待你回答':
                            fresh['status'] = '已暂停'
                        state['tasks'].append(fresh)
                        continue
                    for key in ('title', 'input', 'refs', 'capability', 'expertTeamName', 'updated'):
                        if key in incoming:
                            current[key] = incoming[key]
                    known = {m['id'] for m in current.get('messages', [])}
                    for message in incoming.get('messages', []):
                        if message['id'] not in known and not message['id'].startswith('assistant-'):
                            clean = copy.deepcopy(message)
                            clean.pop('question', None)
                            clean.pop('questionAnswer', None)
                            current.setdefault('messages', []).append(clean)
                            known.add(message['id'])
                if 'activeTask' in patch:
                    state['activeTask'] = patch['activeTask']
            self.mutate(apply)
            return self.snapshot()

    def create_run(self, run_id, task_id, request, initialize=None):
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if initialize is not None:
                row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
                state = json.loads(row['state'])
                initialize(state)
                expire_questions(state)
                db.execute('UPDATE workspace SET revision=?,state=? WHERE id=1', (row['revision'] + 1, encode(state)))
            db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?)', (run_id, task_id, 'running', encode(request), now(), now()))

    def run(self, run_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result.update(run_timing(row['created_at'], row['updated_at'] if row['status'] != 'running' else None))
            result['request'] = json.loads(result['request'])
            return result

    def finish_run(self, run_id, status, update=None):
        # The run and its visible reply must publish the same terminal boundary,
        # including when cancellation races a retry or a process exits mid-write.
        def finish(state, db):
            row = db.execute(
                "UPDATE runs SET status=?,updated_at=? WHERE id=? AND status='running' RETURNING created_at,updated_at",
                (status, now(), run_id)).fetchone()
            if row is None:
                return None
            timing = run_timing(row['created_at'], row['updated_at'])
            if update is not None:
                update(state, timing)
            return timing
        return self.mutate_with_db(finish, only_if_changed=True)

    def append_event(self, run_id, kind, data):
        with self.lock, self.connect() as db:
            cur = db.execute('INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)', (run_id, kind, encode(data), now()))
            return cur.lastrowid

    def events(self, run_id, after=0):
        with self.connect() as db:
            rows = db.execute('SELECT id,kind,data FROM events WHERE run_id=? AND id>? ORDER BY id', (run_id, after)).fetchall()
            return [{'id': row['id'], 'kind': row['kind'], 'data': json.loads(row['data'])} for row in rows]

    def recover(self):
        with self.lock:
            with self.connect() as db:
                rows = db.execute("SELECT id,task_id FROM runs WHERE status='running'").fetchall()
            interrupted = {row['id']: row['task_id'] for row in rows}
            for task in self.get_state()['tasks']:
                if task.get('activeRunId'):
                    interrupted.setdefault(task['activeRunId'], task['id'])
            if not interrupted:
                return
            def recover_state(state, db):
                detected = now()
                messages = {
                    'interrupted': '服务已重启，上次任务已暂停，可重新发送继续。',
                    'failed': '上次任务执行失败，已保存的内容仍保留，请重试。',
                    'cancelled': '任务已暂停，已保存内容仍保留。',
                }
                def event(run_id, kind, data):
                    db.execute('INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)',
                               (run_id, kind, encode(data), detected))
                for run_id, task_id in interrupted.items():
                    run = db.execute('SELECT status,created_at,updated_at FROM runs WHERE id=?', (run_id,)).fetchone()
                    task = next((item for item in state['tasks'] if item['id'] == task_id), None)
                    message_id = 'assistant-' + run_id
                    existing = next((m for m in (task or {}).get('messages', []) if m.get('id') == message_id), None)
                    saved = (existing or {}).get('runStatus')
                    result_row = db.execute("SELECT data FROM events WHERE run_id=? AND kind='result' ORDER BY id DESC LIMIT 1",
                                            (run_id,)).fetchone()
                    result = json.loads(result_row['data']) if result_row else {}
                    if run and run['status'] in ('completed', 'awaiting_input') and saved in (None, 'running'):
                        if task is not None:
                            existing = restore_result(task, run_id, existing, result, run['status'])
                            existing.update(run_timing(run['created_at'], run['updated_at']))
                            if not existing.get('text'):
                                existing['text'] = '本轮已结束，完整回复未保存。'
                            saved = existing['runStatus']
                        clear_finished_run(task, run_id, saved, result)
                        continue
                    if saved in ('completed', 'awaiting_input', 'failed', 'cancelled', 'interrupted'):
                        # Earlier versions wrote the reply and the run in separate transactions.
                        # A committed reply is final, even if the process stopped between the two.
                        if run and run['status'] == 'running':
                            status = 'completed' if saved == 'awaiting_input' else saved
                            timestamp = existing.get('runFinishedAt')
                            if timestamp is None and saved in ('completed', 'awaiting_input'):
                                timestamp = existing.get('createdAt')
                            start = run_timing(run['created_at'])
                            # A legacy failure reply's createdAt is the first progress write.
                            # Empty updated_at marks a terminal row whose end time is unknown.
                            finish = ''
                            if type(timestamp) is int and start['runStartedAt'] <= timestamp <= run_timing(detected)['runStartedAt']:
                                finish = datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()
                            existing.update(run_timing(run['created_at'], finish))
                            db.execute('UPDATE runs SET status=?,updated_at=? WHERE id=?', (status, finish, run_id))
                            if not db.execute("SELECT 1 FROM events WHERE run_id=? AND kind='done'", (run_id,)).fetchone():
                                event(run_id, 'done', {})
                        clear_finished_run(task, run_id, saved, result)
                        continue
                    status = run['status'] if run and run['status'] in messages else 'interrupted'
                    finish = run['updated_at'] if run and run['status'] != 'running' else detected
                    timing = run_timing(run['created_at'] if run else None, finish)
                    if run and run['status'] == 'running':
                        db.execute("UPDATE runs SET status='interrupted',updated_at=? WHERE id=?", (finish, run_id))
                    if task is not None:
                        if existing is None:
                            existing = {'id': message_id, 'role': 'assistant',
                                        'createdAt': timing.get('runFinishedAt') or run_timing(detected)['runStartedAt']}
                            task.setdefault('messages', []).append(existing)
                        existing.update(runId=run_id, **timing)
                        for step in finish_message_steps(existing, status, timing.get('runFinishedAt')):
                            event(run_id, 'tool', step)
                        if not existing.get('question'):
                            existing['text'] = messages[status]
                            if any(card.get('kind') == 'submission' for card in existing.get('cards', [])):
                                existing['submissionPhase'] = 'collecting' if pending_question(task) else 'ready'
                        clear_finished_run(task, run_id, status, result)
                    event(run_id, 'error', {'message': messages[status], 'runStatus': status, **timing})
                    event(run_id, 'done', {})
            self.mutate_with_db(recover_state)

    def add_file(self, metadata, storage_name):
        with self.lock, self.connect() as db:
            db.execute('INSERT INTO files VALUES(?,?,?)', (metadata['id'], encode(metadata), storage_name))

    def get_file(self, file_id):
        with self.connect() as db:
            row = db.execute('SELECT metadata,storage_name FROM files WHERE id=?', (file_id,)).fetchone()
            return {'metadata': json.loads(row['metadata']), 'storage_name': row['storage_name']} if row else None

    def save_material_recognition(self, file_id, outcome):
        """识别事实属于上传原件；浏览器对材料工作区的人工修改保持独立。"""
        with self.lock, self.connect() as db:
            row = db.execute('SELECT metadata FROM files WHERE id=?', (file_id,)).fetchone()
            if row is None:
                raise KeyError(file_id)
            metadata = json.loads(row['metadata'])
            cached = metadata.get('materialRecognition', {})
            if (cached.get('recognition', {}).get('schemaVersion') == outcome['recognition']['schemaVersion']
                    and cached.get('extractionStatus') == 'extracted'
                    and cached['recognition']['role'] != 'unknown'):
                return cached
            metadata['materialRecognition'] = outcome
            db.execute('UPDATE files SET metadata=? WHERE id=?', (encode(metadata), file_id))
            return outcome

    def list_files(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT metadata FROM files ORDER BY rowid DESC').fetchall()]

    def get_translation(self, file_id):
        with self.connect() as db:
            row = db.execute('SELECT result FROM translations WHERE file_id=?', (file_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def save_translation(self, file_id, result):
        with self.lock, self.connect() as db:
            db.execute('INSERT INTO translations VALUES(?,?) ON CONFLICT(file_id) DO UPDATE SET result=excluded.result', (file_id, encode(result)))
