"""Read-only queue scope and a reversible lookup/create fork at the actual run boundary."""
from copy import deepcopy

import pytest

from business import Business
from clarification_service import answer_question
from test_travel_followup_runtime import prepare_store, run_journey
from work_conversation import reimbursement_choice


async def unexpected_model(tools):
    pytest.fail('An explicit queue or fork decision must use the business service directly')


def turn(store, monkeypatch, name, message, context=None):
    return run_journey(store, monkeypatch, name, message, unexpected_model, question_context=context, capability=None)


def choose(store, question, index):
    return store.mutate(lambda state: answer_question(state, 't', {
        'questionId': question['id'], 'optionIds': [question['options'][index]['id']],
    }, ''))


def test_inbox_role_correction_uses_same_queue_and_preserves_reviews(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    before = store.get_state()['data']
    overview = turn(store, monkeypatch, 'overview', '我今天有哪些待办？')
    assert '待我审批 13 张' in overview['text'] and '退回待我补件 1 张' in overview['text']
    assert 'EX-20261116-018' in overview['text']
    assert [s['name'] for s in overview['tools']] == ['query_work_inbox']
    selected = turn(store, monkeypatch, 'correct', '我说的是等我审批的，先告诉我哪两张最值得看。')
    assert [card['id'] for card in selected['cards']] == ['BX-20261116-001', 'BX-20261116-002']
    assert '780.00' in selected['text'] and '已用于其他报销单' in selected['text'] and 'EX-20261116-018' not in selected['text']
    returned = turn(store, monkeypatch, 'returned', '换成退回等我补材料的')
    assert len(returned['cards']) == 1 and returned['cards'][0]['kind'] == 'documents'
    assert returned['cards'][0]['data']['items'][0]['id'] == 'EX-20261116-018'
    assert '费用报销系统打开原单 EX-20261116-018 补件' in returned['text']
    assert '当前责任人是林悦' in returned['text']
    assert store.get_state()['data'] == before


def test_inbox_uses_current_assignment_and_signature_and_reports_source_outage(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    business = Business(store)

    def change(state):
        data = state['data']
        docs = data['auditDocuments']
        for step in docs[0]['steps']:
            if step['status'] == 'current':
                step['actor'] = '其他审批人'
        docs[1]['version'] += 1
        data['handledWorkDocuments'] = {docs[2]['id']: docs.pop(2)}
        returned = deepcopy(next(d for d in data['documents'] if d['id'] == 'EX-20261116-018'))
        returned.update(id='another-claim', applicantId='other-employee')
        data['documents'].append(returned)
    store.mutate(change)
    snapshot = store.snapshot()
    result = business.query_work_inbox()
    assert len(result['approvals']) == 11
    ids = {item['id']: item['category'] for item in result['approvals']}
    assert 'BX-20261116-001' not in ids and 'BX-20261116-003' not in ids
    assert ids['BX-20261116-002'] == 'unknown'
    assert [item['id'] for item in result['returned']] == ['EX-20261116-018']
    assert store.snapshot() == snapshot
    store.mutate(lambda s: s['data']['documentSources']['states'].update(expense='unavailable'))
    partial = business.query_work_inbox()
    assert partial['unavailableSources'] == ['expense'] and not partial['returned']
    assert not any(item['id'].startswith('BX-') for item in partial['approvals'])


@pytest.mark.parametrize('city,expected', [('北京', ['EX-20261116-018']), ('上海', [])])
def test_short_expense_lookup_requires_no_draft_and_obeys_city(tmp_path, monkeypatch, city, expected):
    store = prepare_store(tmp_path, monkeypatch)
    before = store.get_state()['data']
    first = turn(store, monkeypatch, 'ambiguous', city + '差旅报销')
    question = first['question']
    assert [o['label'] for o in question['options']] == ['查看已有报销单', '新建差旅报销单']
    assert not first['cards']
    context, text = choose(store, question, 0)
    viewed = turn(store, monkeypatch, 'lookup', text, context)
    assert [s['name'] for s in viewed['tools']] == ['query_documents']
    assert [d['id'] for d in viewed['cards'][0]['data']['items']] == expected
    assert store.get_state()['data'] == before


@pytest.mark.parametrize('city,matching_application', [('北京', None), ('上海', 'TA-20261113-015')])
def test_new_claim_only_after_selection_and_can_continue_filling(tmp_path, monkeypatch, city, matching_application):
    store = prepare_store(tmp_path, monkeypatch)
    business = Business(store)
    originals = store.get_state()['data']['submissions']['drafts']
    question = turn(store, monkeypatch, 'ask', city + '差旅报销')['question']
    context, text = choose(store, question, 1)
    created = turn(store, monkeypatch, 'create', text, context)
    new_id, = set(store.get_state()['data']['submissions']['drafts']) - originals.keys()
    assert [c['id'] for c in created['cards'] if c['kind'] == 'submission'] == [new_id]
    draft = business.get_draft(new_id)['draft']
    assert draft['status'] == 'draft' and draft['type'] == 'expense'
    if matching_application:
        link_question = created['question']
        assert link_question['draftId'] == new_id
        assert [o['id'] for o in link_question['options']] == [matching_application]
        context, text = choose(store, link_question, 0)
        async def link_and_fill(tools):
            await tools['get_submission_draft'](new_id)
            assert 'error' not in await tools['link_travel_application'](new_id, matching_application)
            assert 'error' not in await tools['update_submission_draft'](new_id, {'purpose': '上海客户拜访'})
        run_journey(store, monkeypatch, 'fill', text, link_and_fill, question_context=context, capability=None)
        assert business.get_draft(new_id)['draft']['purpose'] == '上海客户拜访'
    else:
        assert 'question' not in created and '上海' not in created['text']
        assert not draft.get('applicationId')
    after = store.get_state()['data']['submissions']['drafts']
    assert all(after[key] == original for key, original in originals.items())


@pytest.mark.parametrize('phrase', ['新建北京差旅报销', '查一下上海差旅报销', '审批上海差旅报销', '帮我分析差旅报销'])
def test_short_phrase_fork_does_not_capture_an_explicit_verb(phrase):
    assert reimbursement_choice(phrase, None) is None


def test_inbox_page_query_and_two_chat_turns_share_business_scope(tmp_path, monkeypatch):
    import time
    import config
    from fastapi.testclient import TestClient
    from server import create_app
    from store import Store
    from test_work_decisions import payload

    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'API_KEY', '')
    store = Store(tmp_path / 'http.db')
    route = '/api/local/business/work-inbox'
    with TestClient(create_app(store)) as client:
        def send(message):
            result = client.post('/api/local/runs', json={'taskId': 'work-role', 'message': message})
            assert result.status_code == 200, result.text
            run = result.json()['runId']
            deadline = time.monotonic() + 4
            while client.get('/api/local/runs/' + run).json()['status'] == 'running':
                assert time.monotonic() < deadline
                time.sleep(0.01)
            return next(m for t in store.get_state()['tasks'] if t['id'] == 'work-role'
                        for m in t['messages'] if m.get('runId') == run and m['role'] == 'assistant')

        queue = client.get(route).json()
        assert queue['reviewCounts'] == {'attention': 3, 'unknown': 8, 'clear': 2}
        initial_data = store.get_state()['data']
        assert '13 张' in send('我今天有哪些待办？')['text']
        response = send('我说的是等我审批的，先告诉我哪两张最值得看')
        assert [c['id'] for c in response['cards']] == [x['id'] for x in queue['approvals'][:2]]
        assert store.get_state()['data'] == initial_data
        target = '/api/local/business/work-documents/' + queue['approvals'][0]['id']
        context = client.get(target + '/decision-context').json()
        result = client.post(target + '/decision', json=payload(context, reason='已核对住宿明细及差额。'))
        assert result.status_code == 200, result.text
        assert len(client.get(route).json()['approvals']) == 12
        assert '待我审批 12 张' in send('等我审批的还有哪些？')['text']
        store.mutate(lambda s: s['data'].update(auditDocuments=[]))
        assert client.get(route).json()['unavailableSources'] == []
        store.mutate(lambda s: s['data']['documentSources']['states'].update(oa='unavailable'))
        partial = client.get(route).json()
        assert not partial['approvals'] and partial['unavailableSources'] == ['oa']


def test_other_pending_actions_are_not_presented_as_returns():
    from work_conversation import inbox_scope, progress_reply
    assert inbox_scope('退回等我审批的单据') is None
    assert inbox_scope('请把这两张等我审批的申请全部退回') is None
    assert inbox_scope('我说的是等我审批的单据') == 'approvals'
    doc = {'id': 'EX-001', 'title': '办公用品费用', 'status': 'needs_action',
           'sourceStatus': '待确认收款信息', 'source': {'label': '费用报销系统'}, 'current': {'actors': ['林悦']}}
    reply = progress_reply({'items': [doc], 'unavailableSources': []})
    assert '退回' not in reply and '待确认收款信息' in reply and '费用报销系统' in reply and 'EX-001' in reply
