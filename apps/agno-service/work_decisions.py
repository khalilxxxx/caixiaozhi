"""我的工作中的单笔人工办理，仅写入本机模拟业务系统。"""
from copy import deepcopy
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from business import (BusinessError, SOURCE, audit_document_input, canonical, evaluate, is_date,
                      now, rules_for, signature)

# 与本地工作台登录席位一致。申请人、操作人均不从决策请求中接收。
WORK_APPROVER = '吴侠'


@lru_cache(maxsize=1)
def fixture_ids():
    seed = json.loads(Path(__file__).with_name('seed.json').read_text(encoding='utf-8'))
    return frozenset(doc['id'] for doc in seed['data']['auditDocuments'] if doc.get('synthetic') is True)


def migrate_approval_assignments(data, seeded_data):
    if data.get('workDecisionFixtureVersion', 0) >= 1 or not isinstance(data.get('auditDocuments'), list):
        return False
    fixtures = {doc['id']: doc for doc in seeded_data.get('auditDocuments', [])}
    for doc in data['auditDocuments']:
        # 完整比对原始样例；用户改过的单据、处理人、外部数据及历史步骤都不作回填。
        if doc.get('synthetic') is True and not doc.get('sourceUrl') and doc == fixtures.get(doc.get('id')):
            for step in doc.get('steps', []):
                if step.get('status') == 'current':
                    step['actor'] = WORK_APPROVER
    data['workDecisionFixtureVersion'] = 1
    return True


def _review_snapshot(doc, data):
    active = rules_for(data, scope='review', system=doc['system'])
    sig = signature(active)
    saved = data.get('rulesSubmission', {}).get('reviewResults', {}).get(doc['id'])
    version = doc.get('version', 1)
    checked = bool(saved and saved.get('documentVersion') == version and saved.get('signature') == sig)
    if checked:
        review = saved['review']
    else:
        # 只判断适用范围。尚未执行或已过期时，决策人需要明确核对这些未知项。
        applicable = evaluate(audit_document_input(doc), active)
        review = {'status': 'unknown', 'findings': [], 'passed': [],
                  'inapplicable': applicable['inapplicable'], 'applicable': applicable['applicable']}
    return {'checked': checked, 'stale': bool(saved) and not checked, 'checkedAt': (saved or {}).get('checkedAt'),
            'signature': sig, 'documentVersion': version, 'review': review}


def _business_blocks(doc):
    supplied = doc.get('hardBlockReasons') or doc.get('hard_block_reasons') or []
    reasons = [r if isinstance(r, str) else r.get('message', '来源系统报告业务硬阻断。')
               for r in supplied if isinstance(r, (str, dict))]
    if doc.get('system') == 'expense':
        if doc.get('invoiceUnique') is False:
            reasons.append('业务单据记录存在重复使用的发票。')
        if doc.get('attachment') is False:
            reasons.append('业务单据缺少必要报销凭证。')
        if type(doc.get('amountCents')) is not int or doc['amountCents'] <= 0:
            reasons.append('报销金额无效。')
        for line in doc.get('expenses') or []:
            if not line.get('categoryId'):
                reasons.append('费用明细缺少费用类型。')
            if not is_date(line.get('date')):
                reasons.append('费用明细的发生日期无效。')
            if type(line.get('amountCents')) is not int or line['amountCents'] < 0:
                reasons.append('费用明细的金额无效。')
    return list(dict.fromkeys(reasons))


def _context(doc, snapshot):
    steps = [step for step in doc.get('steps', []) if step.get('status') == 'current']
    unavailable = ''
    if doc.get('synthetic') is not True or doc.get('sourceUrl') or doc['id'] not in fixture_ids():
        unavailable = '该单据需在来源业务系统中审批。'
    elif type(doc.get('version')) is not int or doc['version'] < 1:
        unavailable = '缺少可确认的业务单据版本，请在来源系统核对。'
    elif doc.get('stage') != '待审批' or len(steps) != 1:
        unavailable = '当前单据没有可办理的审批节点。'
    elif steps[0].get('actor') != WORK_APPROVER:
        unavailable = '当前审批任务未指派给你。'
    review = snapshot['review']
    issues = {finding['rule']['id']: finding for finding in review['findings']}
    passed = {rule['id'] for rule in review['passed']}
    items = []
    for rule in review['applicable']:
        rid = rule['id']
        finding = issues.get(rid)
        if rid in passed and finding is None:
            continue
        detail = (finding or {}).get('detail') or ('预审依据已变化，本项尚待重新核实。' if snapshot['stale']
                                                  else '本项尚无已完成的核验结果。')
        items.append({'id': rid, 'title': rule['name'], 'detail': detail,
                      'evidence': (finding or {}).get('evidence', [])})
    blockers = _business_blocks(doc)
    bindings = [doc, snapshot, items, blockers, WORK_APPROVER]
    digest = hashlib.sha256(canonical(bindings).encode()).hexdigest()
    return {'expectedVersion': snapshot['documentVersion'], 'reviewHash': digest, 'items': items,
            'requiresReview': bool(items), 'hardBlockReasons': blockers, 'unavailableReason': unavailable,
            'availableActions': [] if unavailable else (['return'] if blockers else ['approve', 'return'])}


def _pending(data, document_id):
    doc = next((d for d in data.get('auditDocuments', []) if d['id'] == document_id), None)
    if doc is None:
        if document_id in data.get('handledWorkDocuments', {}):
            raise BusinessError('DECISION_CONFLICT', '这张单据已经办理，请刷新查看办理结果。')
        raise BusinessError('WORK_DOCUMENT_NOT_FOUND', '未找到这张待办单据。')
    return doc


def decision_context(store, document_id):
    data = store.get_state()['data']
    doc = _pending(data, document_id)
    return _context(doc, _review_snapshot(doc, data))


def decide(store, document_id, *, decision, expectedVersion, idempotencyKey, reviewAck, reason=''):
    reason = reason.strip()
    ack = {'reviewHash': reviewAck['reviewHash'], 'findingIds': sorted(reviewAck['findingIds'])}
    intent = hashlib.sha256(canonical([document_id, expectedVersion, decision, reason, ack]).encode()).hexdigest()

    def transaction(state):
        data = state['data']
        ledger = data.setdefault('workDecisionLedger', {})
        previous = ledger.get(idempotencyKey)
        if previous is not None:
            if previous['intent'] != intent:
                raise BusinessError('IDEMPOTENCY_CONFLICT', '该提交标识已用于不同的审批内容。')
            doc = data['handledWorkDocuments'][document_id]
            return {'document': doc, 'decision': doc['decision'], 'dataSource': SOURCE}
        doc = _pending(data, document_id)
        snapshot = _review_snapshot(doc, data)
        context = _context(doc, snapshot)
        if context['unavailableReason']:
            raise BusinessError('WORK_DECISION_FORBIDDEN', context['unavailableReason'])
        if expectedVersion != doc['version'] or ack['reviewHash'] != context['reviewHash']:
            raise BusinessError('REVIEW_VERSION_CONFLICT', '单据或预审依据已更新，请重新核对后审批。')
        if decision not in context['availableActions']:
            raise BusinessError('BUSINESS_BLOCKED', '；'.join(context['hardBlockReasons']))
        if ack['findingIds'] != sorted(item['id'] for item in context['items']):
            raise BusinessError('REVIEW_ACK_REQUIRED', '请明确核对本次全部预审事项。')
        if (context['requiresReview'] or decision == 'return') and not reason:
            raise BusinessError('VALIDATION_ERROR', '请填写本次审批的理由。')
        stamp = now()
        result = {'id': str(uuid4()), 'decision': decision, 'reason': reason,
                  'actor': WORK_APPROVER, 'decidedAt': stamp, 'fromVersion': expectedVersion,
                  'reviewAck': ack, 'evidence': context['items']}
        current_step = next(step for step in doc['steps'] if step['status'] == 'current')
        outcome = '同意' if decision == 'approve' else '退回'
        current_step.update(label=f"{current_step['label']} · {outcome}", status='done', time=stamp)
        doc.update(stage='已' + outcome, version=expectedVersion + 1, decision=result,
                   decisionReview=deepcopy(snapshot))
        data['auditDocuments'].remove(doc)
        data.setdefault('handledWorkDocuments', {})[document_id] = doc
        ledger[idempotencyKey] = {'intent': intent, 'documentId': document_id}
        return {'document': doc, 'decision': result, 'dataSource': SOURCE}

    return store.mutate(transaction, only_if_changed=True)
