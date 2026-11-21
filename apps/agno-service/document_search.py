"""查询个人单据和按编号引用的工作单流转。"""
import re
from decimal import Decimal


DOCUMENT_NUMBER = re.compile(r'(?<![a-z0-9])[a-z][a-z0-9]*(?:-[a-z0-9]+)+')
PROGRESS_QUESTION = re.compile(r'(?:单据|申请|报销|合同|审批|办理|这张单|流程).{0,12}(?:进度|进展|到哪|到谁|卡在)|'
                               r'谁.{0,6}(?:审批|审核|在批|处理)|审批(?:人|流|节点)|卡在哪|'
                               r'为什么.{0,5}退回|退回原因|被谁退回|轮到谁|在哪个节点|批到哪')
OTHER_WORK = re.compile(r'风险|预审|整改建议|审核依据|帮我(?:审批|提交|退回|填单)|执行规则')
TYPE_TERMS = (
    ('expense_claim', r'(?:个人费用|费用|差旅|出差)?报销单?'),
    ('travel_application', r'(?:差旅|出差|行程)(?:申请单?)?'),
    ('oa_leave', r'请假(?:申请单?)?|年假(?:申请单?)?'),
    ('payment_request', r'(?:采购)?付款(?:申请)?单?|采购单?|支付单?|到账'),
    ('contract_approval', r'合同(?:审批)?单?'),
    ('budget_transfer', r'预算(?:调拨)?单?'),
)
SEARCH_WORDS = re.compile(
    r'谁在审批|由谁(?:来)?审批|谁(?:在)?审[批核]|(?:审批)?到谁|(?:审批|流程)?卡在哪(?:一步|里|个环节)?|'
    r'到哪(?:个环节|个节点|一步|里|儿)?|在谁(?:那里|手上|那)?|下一步|'
    r'当前(?:处理人|审批人|办理人|节点|环节)|(?:审批|办理)(?:记录|进度|进展|状态|情况|流程)|'
    r'审批流|单据|审批|进展|进度|状态|正在|当前|现在|最近|还在|'
    r'请帮我|帮我|看看|看一下|查一下|查查|查询|查看|只看|哪些|所有|全部|'
    r'我的|这[笔张个份]|的|了|[吗呢呀啊]|[？?，,。.！!：:]'
)


def work_progress_document(doc):
    kind = doc.get('kind') or '工作单据'
    if doc.get('system') == 'expense':
        type_id = 'expense_claim'
    elif doc.get('documentType') == 'travel' or kind in ('出差申请', '差旅申请'):
        type_id = 'travel_application'
    elif '请假' in kind:
        type_id = 'oa_leave'
    elif '付款' in kind:
        type_id = 'payment_request'
    else:
        type_id = 'work_document'
    decision = doc.get('decision') or {}
    stage = doc.get('stage') or '状态待核实'
    outcome = decision.get('decision') or {'已退回': 'return', '已同意': 'approve'}.get(stage)
    returned = outcome == 'return'
    steps = []
    for i, step in enumerate(doc.get('steps') or []):
        decided = bool(decision.get('decidedAt') and step.get('time') == decision['decidedAt'])
        was_returned = returned and (decided or (step['status'] == 'done' and '退回' in step['label']))
        entry = {'id': str(i), 'label': step['label'], 'status': 'returned' if was_returned else step['status']}
        if step.get('time'):
            entry['time'] = step['time']
        if step.get('actor'):
            entry['actors'] = [step['actor']]
        if decided and decision.get('reason'):
            entry['note'] = decision['reason']
        steps.append(entry)
    current = [s for s in steps if s['status'] == 'current']
    decided = outcome in ('return', 'approve')
    summary_stage = '本次审批已退回' if returned else '本节点已同意'
    fields = [{'label': label, 'value': doc[name]} for label, name in
              [('申请人', 'person'), ('所属部门', 'department'), ('事由', 'purpose')] if doc.get(name)]
    result = {
        'workDocumentId': doc['id'], 'key': f"work/{type_id}/{doc['id']}", 'id': doc['id'], 'title': doc['title'],
        'typeId': type_id, 'typeLabel': kind, 'source': {'id': doc['system'], 'label': doc.get('sourceLabel') or kind},
        'status': 'processing' if current else 'closed' if decided else 'unknown', 'sourceStatus': stage,
        'phase': 'approval', 'phaseLabel': summary_stage if decided and not current else stage, 'summary': fields[:2],
        'details': fields + (doc.get('specificFields') or []), 'steps': steps,
        'updatedAt': doc.get('updatedAt') or decision.get('decidedAt') or
                     next((s['time'] for s in reversed(steps) if s.get('time')), doc.get('submittedAt', '')),
    }
    if doc.get('sourceUrl'):
        result['sourceUrl'] = doc['sourceUrl']
    if current:
        result['current'] = {'label': '、'.join(dict.fromkeys(s['label'] for s in current)),
                             'actors': list(dict.fromkeys(a for s in current for a in s.get('actors', [])))}
        if len(current) == 1 and current[0].get('time'):
            result['current']['since'] = current[0]['time']
    if doc.get('amountCents') is not None:
        result['amount'] = {'label': '报销金额' if type_id == 'expense_claim' else '申请金额',
                            'value': f"¥{Decimal(doc['amountCents']) / 100:,.2f}", 'currency': 'CNY'}
    return result


def search_documents(data, query, document_ids=None):
    records = data.get('documents', [])
    states = data.get('documentSources', {}).get('states', {})
    allowed = set(document_ids) if document_ids is not None else None
    numbers = set(DOCUMENT_NUMBER.findall(query))
    if numbers or allowed:
        # Personal progress lists and approver inboxes have different scopes.
        # Expose a work item only by exact number or a selected stable key.
        requested = {value.rsplit('/', 1)[-1].lower() for value in allowed or ()} | numbers
        existing = {(d['source']['id'], d['id']) for d in records}
        work = [*data.get('auditDocuments', []), *data.get('handledWorkDocuments', {}).values()]
        projections = []
        for doc in work:
            if doc['id'].lower() not in requested:
                continue
            record = work_progress_document(doc)
            if ((doc['system'], doc['id']) not in existing or record['key'] in (allowed or ())):
                projections.append(record)
        records = [*records, *projections]
    if allowed is not None:
        records = [doc for doc in records if doc['id'] in allowed or doc['key'] in allowed]
    # A number identifies a document regardless of the wording around it.
    scope = records
    words = query
    if numbers:
        scope = [doc for doc in scope if doc['id'].lower() in numbers]
        words = ''
    else:
        for kind, pattern in TYPE_TERMS:
            if re.search(pattern, words):
                scope = [doc for doc in scope if doc['typeId'] == kind]
                words = re.sub(pattern, ' ', words)
                break
        if 'oa' in words:
            scope = [doc for doc in scope if doc['source']['id'] == 'oa']
            words = words.replace('oa', ' ')
    # An unavailable source may contain matches that have never been cached.
    source_ids = (set(states) if scope is records and allowed is None
                  else {doc['source']['id'] for doc in scope})
    unavailable = sorted(source for source in source_ids if states.get(source, 'ready') != 'ready')
    candidates = [doc for doc in scope if doc['source']['id'] not in unavailable]
    pending_me = r'待我(?:处理|补充)|需要我(?:处理|补充)(?:材料)?|退回(?:待补充)?'
    if re.search(pending_me, words):
        candidates = [doc for doc in candidates if doc.get('status') == 'needs_action']
        words = re.sub(pending_me, ' ', words)
    if '审批中' in words or (allowed is None and scope is records and not SEARCH_WORDS.sub('', words).strip()
                            and re.search(r'谁在审批|谁在审[批核]', words)):
        candidates = [doc for doc in candidates if doc.get('status') == 'processing' and doc.get('phase') == 'approval']
        words = words.replace('审批中', ' ')
    current_owner = bool(re.search(r'(?:正在|在)审[批核]|由.+?审[批核]', words))
    terms = SEARCH_WORDS.sub(' ', words.replace('由', ' ') if current_owner else words).split()
    if terms:
        if current_owner:
            people = {actor for doc in candidates for step in doc.get('steps', []) for actor in step.get('actors', [])}
            requested_people = people.intersection(terms)
            if requested_people:
                candidates = [doc for doc in candidates if doc.get('phase') == 'approval' and
                              doc.get('status') == 'processing' and
                              requested_people.issubset((doc.get('current') or {}).get('actors', []))]
        def matches(doc):
            fields = [doc['id'], doc['title'], doc['typeLabel'], doc['source']['label'], doc['sourceStatus'],
                      doc.get('phaseLabel', ''), (doc.get('current') or {}).get('label', ''),
                      *((doc.get('current') or {}).get('actors') or []),
                      *(field['value'] for field in doc.get('summary', []))]
            if not current_owner:
                fields.extend(field['value'] for field in doc.get('details', []))
            return all(any(term in value.lower() for value in fields) for term in terms)
        candidates = [doc for doc in candidates if matches(doc)]
    return candidates, unavailable
