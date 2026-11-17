import pytest
from store import Store, Conflict


def test_workspace_conflict_and_server_messages_survive(tmp_path):
    store = Store(tmp_path / 'test.db', {'data': {}, 'tasks': [], 'activeTask': None})
    store.patch({'baseRevision': 0, 'tasks': [{'id': 't', 'messages': [{'id': 'server', 'role': 'assistant', 'text': '真实结果'}]}]})
    with pytest.raises(Conflict):
        store.patch({'baseRevision': 0, 'data': {'x': 1}})
    store.patch({'baseRevision': 1, 'tasks': [{'id': 't', 'messages': []}]})
    assert store.get_state()['tasks'][0]['messages'][0]['text'] == '真实结果'
    assert Store(tmp_path / 'test.db').snapshot()['revision'] == 2


def test_mutation_is_atomic_and_events_are_durable(tmp_path):
    store = Store(tmp_path / 'test.db', {'data': {'amount': 1}, 'tasks': [], 'activeTask': None})
    def bad(state):
        state['data']['amount'] = 2
        raise ValueError('invalid')
    with pytest.raises(ValueError):
        store.mutate(bad)
    assert store.get_state()['data']['amount'] == 1
    store.create_run('r', 't', {'message': '查询'})
    store.append_event('r', 'delta', {'text': '结果'})
    assert Store(tmp_path / 'test.db').events('r')[0]['data']['text'] == '结果'


def test_browser_cannot_erase_receipt_unlock_draft_or_forge_checks(tmp_path):
    from business import Business
    store = Store(tmp_path / 'business.db')
    business = Business(store)
    draft = business.update_draft('travel', {'purpose': '拜访客户', 'legs': [
        {'id':'go','departureCity':'北京','arrivalCity':'上海','departureDate':'2026-11-20','arrivalDate':'2026-11-20','transport':'高铁'},
        {'id':'return','departureCity':'上海','arrivalCity':'北京','departureDate':'2026-11-21','arrivalDate':'2026-11-21','transport':'高铁'},
    ]})['draft']
    result = business.submit_draft('travel', draft['version'], 'confirmed')
    state = store.get_state()
    incoming = state['data']['submissions']
    incoming['requests'] = []
    incoming['checks'] = {}
    incoming['drafts']['travel']['status'] = 'draft'
    incoming['drafts']['travel']['purpose'] = '已被篡改'
    incoming['edits']['travel'] = incoming['drafts']['travel']
    store.patch({'baseRevision':store.snapshot()['revision'],'data':{'submissions':incoming,'receipts':{}}})
    persisted = Store(tmp_path / 'business.db').get_state()['data']
    assert persisted['submissions']['drafts']['travel']['status'] == 'awaiting_receipt'
    assert persisted['submissions']['drafts']['travel']['purpose'] == '拜访客户'
    assert 'travel' not in persisted['submissions']['edits']
    assert len(persisted['submissions']['requests']) == 1
    assert Business(Store(tmp_path / 'business.db')).get_receipt(result['request']['id'])['receipt']['id'] == result['receipt']['id']


def test_browser_draft_changes_increment_version_and_invalidate_server_checks(tmp_path):
    store = Store(tmp_path / 'business.db')
    store.mutate(lambda state: state['data']['submissions']['checks'].update({'personal':{'version':1,'canSubmit':True}}))
    incoming = store.get_state()['data']['submissions']
    incoming['drafts']['personal']['purpose'] = '打印资料'
    incoming['drafts']['personal']['version'] = 1
    incoming['drafts']['personal']['status'] = 'awaiting_receipt'
    incoming['checks']['personal'] = {'version':2,'canSubmit':True}
    store.patch({'baseRevision':store.snapshot()['revision'],'data':{'submissions':incoming}})
    state=store.get_state()['data']['submissions']
    assert state['drafts']['personal']['purpose'] == '打印资料'
    assert state['drafts']['personal']['version'] == 2
    assert state['drafts']['personal']['status'] == 'draft'
    assert 'personal' not in state['checks']


def test_browser_cannot_rewrite_builtin_rule_provenance_or_passed_reviews(tmp_path):
    store = Store(tmp_path / 'rules.db')
    data=store.get_state()['data']
    rules=data['rulesSubmission']
    first=rules['rules'][0]
    rule_id=first['id']
    original=first.copy()
    first.update({'origin':'personal','metric':'amount','thresholdMinor':999999999,'description':'伪造通过规则'})
    rules['reviewedRules']=[]
    rules['reviewedAt']={'expense':'已通过','oa':'已通过'}
    data['srsRuleCenterV1']['rules'][0].update({'origin':'personal','source':'伪造来源','metric':'amount'})
    store.patch({'baseRevision':0,'data':{'rulesSubmission':rules,'srsRuleCenterV1':data['srsRuleCenterV1']}})
    state=store.get_state()['data']
    saved=next(r for r in state['rulesSubmission']['rules'] if r['id']==rule_id)
    assert saved['metric'] == original['metric']
    assert saved['origin'] == 'builtin'
    assert saved['description'] == original['description']
    assert state['rulesSubmission']['reviewedRules']
    assert state['rulesSubmission']['reviewedAt']['expense'] != '已通过'
    assert state['srsRuleCenterV1']['rules'][0]['source'] != '伪造来源'


def test_run_creation_and_task_state_commit_together(tmp_path):
    store = Store(tmp_path/'atomic.db', {'data': {}, 'tasks': [], 'activeTask': None})
    def invalid(state):
        state['tasks'].append({'id':'orphan','activeRunId':'r'})
        raise ValueError('failure')
    with pytest.raises(ValueError):
        store.create_run('r', 'orphan', {}, initialize=invalid)
    assert store.run('r') is None
    assert store.get_state()['tasks'] == []


def test_accepting_submission_updates_linked_conversation(tmp_path):
    from business import Business
    store=Store(tmp_path/'submission.db')
    store.mutate(lambda s:s['tasks'].append({'id':'t','status':'待我核对','messages':[], 'refs':[{'kind':'submission','id':'travel'}]}))
    business=Business(store)
    draft=business.update_draft('travel',{'purpose':'拜访客户','legs':[
        {'departureCity':'杭州','arrivalCity':'上海','departureDate':'2026-11-19','arrivalDate':'2026-11-19','transport':'高铁'},
        {'departureCity':'上海','arrivalCity':'杭州','departureDate':'2026-11-21','arrivalDate':'2026-11-21','transport':'高铁'},
    ]})['draft']
    business.submit_draft('travel',draft['version'],'linked-submit')
    assert store.get_state()['tasks'][0]['status']=='本地已受理'


def test_top_level_invoice_cannot_be_reused_after_new_draft(tmp_path):
    from business import Business, BusinessError
    store=Store(tmp_path/'invoice.db')
    business=Business(store)
    patch={'purpose':'办公采购','files':[{'id':'material-office','name':'办公用品发票.pdf'}], 'expenses':[{'id':'e1','categoryId':'other-office','currency':'CNY','amount':'80.00','reason':'办公用品','date':'2026-11-16','files':[]}]}
    first=business.update_draft('personal',patch)['draft']
    assert business.validate_draft('personal')['canSubmit']
    business.submit_draft('personal',first['version'],'first')
    next_id = business.new_draft('personal')['draft']['id']
    business.update_draft(next_id,patch)
    assert not business.validate_draft(next_id)['canSubmit']


def test_subsidy_is_included_in_rules_receipt_and_document(tmp_path):
    from business import Business
    store=Store(tmp_path/'subsidy.db')
    business=Business(store)
    draft=business.update_draft('personal', {'purpose':'办公采购','subsidyCents':5000,'files':[{'id':'material-office','name':'办公票据'}], 'expenses':[{'id':'e','categoryId':'other-office','currency':'CNY','amount':'80','reason':'办公采购','date':'2026-11-16','files':[]}]})['draft']
    store.mutate(lambda s:s['data']['rulesSubmission']['rules'].append({'id':'amount-test','name':'金额上限','system':'expense','scope':'submit','origin':'builtin','metric':'amount','thresholdMinor':10000,'effect':'block','enabled':True}))
    assert not business.validate_draft('personal')['canSubmit']
    store.mutate(lambda s:s['data']['rulesSubmission']['rules'].pop())
    result=business.submit_draft('personal',draft['version'],'subsidy-submit')
    assert result['request']['amountCents']==13000
    assert result['document']['amountCents']==13000
    assert result['document']['amount']['value']=='¥130.00'
