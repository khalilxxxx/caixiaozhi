from business import Business
from test_business import MemoryStore


def test_conversational_search_preserves_type_place_and_exact_number():
    service = Business(MemoryStore())
    for question, ids in (
        ('北京差旅报销审批到谁了？', ['EX-20261116-018']),
        ('上海差旅报销审批到谁了？', []),
        ('TA-20261116-023 的审批卡在哪？', ['TA-20261116-023']),
        ('报销 EX-20261116-999 到哪一步了？', []),
        ('谁在审批', ['TA-20261116-023', 'OA-20261116-006', 'CT-20261116-012']),
    ):
        result = service.query_documents(question)
        assert [doc['id'] for doc in result['items']] == ids


def test_bound_query_uses_only_selected_documents_and_their_live_source():
    store = MemoryStore()
    store.state['data']['documentSources']['states']['oa'] = 'unavailable'
    service = Business(store)
    selected = [doc['key'] for doc in store.state['data']['documents'] if doc['typeId'] == 'oa_leave']
    result = service.query_documents('卡在哪', selected)
    assert result['items'] == []
    assert result['unavailableSources'] == ['oa']
    assert result['cards'][0]['data']['documentIds'] == selected
    assert result['cards'][0]['data']['unavailableSources'] == ['oa']
    store.state['data']['documentSources']['states']['oa'] = 'ready'
    recovered = service.query_documents(result['cards'][0]['data']['query'], selected)
    assert [doc['key'] for doc in recovered['items']] == selected
    assert recovered['items'][0]['current']['actors'] == ['李婷']


def test_scoped_queries_only_report_relevant_outages_and_current_handlers():
    store = MemoryStore()
    store.state['data']['documentSources']['states']['oa'] = 'unavailable'
    service = Business(store)
    reimbursements = service.query_documents('报销进度')
    assert reimbursements['unavailableSources'] == []
    assert reimbursements['items'][0]['sourceStatus'] == '已退回'
    contract = service.query_documents('合同审批到谁了')['items'][0]
    assert contract['current']['actors'] == ['张伟']
    assert contract['steps'][1]['actors'] == ['张伟', '李婷']
    pending = service.query_documents('待我处理的单据')
    assert [doc['id'] for doc in pending['items']] == ['EX-20261116-018']


def test_search_for_current_approver_excludes_completed_countersigners():
    service = Business(MemoryStore())
    for query in ('李婷正在审批哪些单据', '由李婷审批的单据'):
        assert [doc['id'] for doc in service.query_documents(query)['items']] == ['OA-20261116-006']


def test_work_record_is_only_included_when_named_or_referenced():
    store = MemoryStore()
    service = Business(store)
    doc = store.state['data']['auditDocuments'][0]
    work_key = f"work/expense_claim/{doc['id']}"
    for result in (service.query_documents(doc['id']), service.query_documents('', [work_key])):
        record, = result['items']
        assert (record['key'], record['workDocumentId'], record['source']['id']) == (work_key, doc['id'], doc['system'])
        assert record['current']['actors'] == [doc['steps'][1]['actor']]
        assert result['cards'][0]['kind'] == 'documents'
    assert not any('workDocumentId' in doc for doc in service.query_documents('报销')['items'])
    assert service.query_documents('', [f"work/travel_application/{doc['id']}"])['items'] == []
    store.state['data']['documentSources']['states'][doc['system']] = 'unavailable'
    inaccessible = service.query_documents('', [work_key])
    assert inaccessible['items'] == [] and inaccessible['unavailableSources'] == [doc['system']]


def test_handled_work_decision_closes_only_that_node_and_preserves_actual_completion_time():
    store = MemoryStore()
    service = Business(store)
    data = store.state['data']
    doc = data['auditDocuments'].pop(0)
    stamp = '2026-11-17T00:30:00+00:00'
    for key, label in [('return', '退回'), ('approve', '同意')]:
        doc.update(stage='已' + label, decision={'decision': key, 'decidedAt': stamp, 'reason': '本次意见'})
        doc['steps'][1].update(status='done', time=stamp, label='财务审核 · ' + label)
        data['handledWorkDocuments'] = {doc['id']: doc}
        current, = service.query_documents(doc['id'])['items']
        assert current['status'] == 'closed' and 'current' not in current
        assert current['sourceStatus'] == '已' + label and current['updatedAt'] == stamp
        assert current['steps'][-1]['status'] == ('returned' if key == 'return' else 'done')
        assert current['steps'][-1]['note'] == '本次意见'
