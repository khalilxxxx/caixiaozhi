"""追问时保存草稿但延迟出卡，结束与中断只保留当前目标成果。"""
import asyncio
import copy
from types import SimpleNamespace

import pytest

import agent_runtime
from business import Business
from clarification_service import answer_question
from store import Store


def prepare_store(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    store = Store(tmp_path / 'followup.db')
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'refs': [], 'messages': [], 'status': '处理中',
    }))
    return store


def run_journey(store, monkeypatch, run_id, message, journey, *, question_context=None, capability='submission'):
    class ScriptedAgent:
        def __init__(self, **kwargs):
            self.tools = {getattr(tool, 'entrypoint', tool).__name__: getattr(tool, 'entrypoint', tool)
                          for tool in kwargs['tools']}

        async def arun(self, *args, **kwargs):
            outcome = await journey(self.tools)
            yield SimpleNamespace(event='RunError' if outcome == 'fail' else 'RunContent',
                                  content='模型暂时不可用' if outcome == 'fail' else '请核对已保存的行程。')

    monkeypatch.setattr(agent_runtime, 'Agent', ScriptedAgent)
    def start(state):
        task = state['tasks'][0]
        task.update(activeRunId=run_id, status='处理中')
        task['messages'].append({'id': 'user-' + run_id, 'role': 'user', 'text': message})
    store.mutate(start)
    store.create_run(run_id, 't', {'message': message, 'refs': [], 'capability': capability,
                                 'questionContext': question_context})
    asyncio.run(agent_runtime.Runtime(store, Business(store)).execute(run_id))
    return next(message for message in store.get_state()['tasks'][0]['messages']
                if message.get('id') == 'assistant-' + run_id)


def test_asking_preserves_saved_draft_without_publishing_submission_card(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    checkpoints = []

    async def collect(tools):
        await tools['get_submission_draft']('travel')
        await tools['update_submission_draft']('travel', {
            'purpose': '拜访客户', 'legs': [{'id': 'go', 'arrivalCity': '上海'}],
        })
        await tools['list_materials']()
        checkpoints.append(Store(store.path).get_state()['tasks'][0])
        await tools['ask_user']('哪天出发？', [], draft_id='travel')

    message = run_journey(store, monkeypatch, 'collect', '下周去上海拜访客户', collect)
    saved = checkpoints[0]['messages'][-1]
    assert saved.get('submissionPhase') == 'collecting'
    assert saved['cards'][0]['id'] == 'travel'
    assert checkpoints[0]['refs'][0]['id'] == 'travel'
    assert message.get('submissionPhase') == 'collecting'
    assert message['question']['status'] == 'pending'
    result = next(event['data'] for event in store.events('collect') if event['kind'] == 'result')
    assert result.get('submissionPhase') == 'collecting'
    assert [card['kind'] for card in result['cards']] == ['materials']
    assert store.get_state()['data']['submissions']['drafts']['travel']['purpose'] == '拜访客户'


def test_answer_updates_same_draft_and_only_publishes_latest_target(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    old = copy.deepcopy(store.get_state()['data']['submissions']['drafts']['travel'])
    selected = {}

    async def collect(tools):
        await tools['get_submission_draft']('travel')
        created = await tools['new_submission_draft']('travel')
        selected['id'] = created['draft']['id']
        await tools['update_submission_draft'](selected['id'], {
            'purpose': '拜访客户', 'companions': ['陈宁'],
            'legs': [{'id': 'go', 'arrivalCity': '上海', 'transport': '火车-一等座'}],
        })
        await tools['ask_user']('哪天出发？', [], draft_id=selected['id'])

    first = run_journey(store, monkeypatch, 'collect', '另外建一份上海申请', collect)
    context, _ = store.mutate(lambda state: answer_question(state, 't', {
        'questionId': first['question']['id'], 'text': '11月19日出发，只填单程',
    }, ''))

    async def answer(tools):
        await tools['get_submission_draft'](selected['id'])
        await tools['update_submission_draft'](selected['id'], {
            'legs': [{'id': 'go', 'departureDate': '2026-11-19'}],
        })
        await tools['validate_submission'](selected['id'])

    message = run_journey(store, monkeypatch, 'answer', '11月19日出发，只填单程', answer,
                          question_context=context)
    assert message.get('submissionPhase') == 'ready'
    assert [card['id'] for card in message['cards'] if card['kind'] == 'submission'] == [selected['id']]
    assert [card['id'] for card in first['cards'] if card['kind'] == 'submission'] == [selected['id']]
    draft = store.get_state()['data']['submissions']['drafts'][selected['id']]
    assert draft['legs'][0]['departureDate'] == '2026-11-19'
    assert draft['legs'][0]['arrivalDate'] == '2026-11-19'
    assert draft['legs'][0]['transport'] == '火车-一等座'
    assert draft['companions'] == ['陈宁']
    assert store.get_state()['data']['submissions']['drafts']['travel'] == old


@pytest.mark.parametrize('ending', ['failed', 'restart'])
def test_partial_draft_is_accessible_after_failure_and_text_only_resume(tmp_path, monkeypatch, ending):
    store = prepare_store(tmp_path, monkeypatch)
    selected = {}

    class ProcessStopped(BaseException):
        pass

    async def interrupted(tools):
        await tools['get_submission_draft']('travel')
        created = await tools['new_submission_draft']('travel')
        selected['id'] = created['draft']['id']
        await tools['update_submission_draft'](selected['id'], {'purpose': '北京客户评审'})
        if ending == 'restart':
            raise ProcessStopped()
        return 'fail'

    if ending == 'restart':
        with pytest.raises(ProcessStopped):
            run_journey(store, monkeypatch, 'partial', '另建北京申请', interrupted)
        Store(store.path).recover()
    else:
        run_journey(store, monkeypatch, 'partial', '另建北京申请', interrupted)
    partial = store.get_state()['tasks'][0]['messages'][-1]
    assert partial.get('submissionPhase') == 'ready'
    assert [card['id'] for card in partial['cards']] == [selected['id']]
    assert partial['text']

    async def resume(tools):
        pass

    message = run_journey(store, monkeypatch, 'resume', '继续核对刚才的申请', resume, capability=None)
    assert message.get('submissionPhase') == 'ready'
    assert [card['id'] for card in message['cards']] == [selected['id']]
    assert len(store.get_state()['data']['submissions']['drafts']) == 4
    assert store.get_state()['data']['submissions']['drafts'][selected['id']]['purpose'] == '北京客户评审'


def test_recovery_does_not_publish_draft_with_unanswered_question(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)

    async def collect(tools):
        await tools['get_submission_draft']('travel')
        await tools['ask_user']('目的地是哪里？', [], draft_id='travel')

    run_journey(store, monkeypatch, 'collect', '帮我申请出差', collect)
    store.mutate(lambda state: state['tasks'][0].update(activeRunId='collect'))
    Store(store.path).recover()
    task = store.get_state()['tasks'][0]
    assert task['status'] == '待你回答'
    assert task['messages'][-1].get('submissionPhase') == 'collecting'
    assert task['messages'][-1]['question']['status'] == 'pending'


def test_unknown_return_is_ready_then_explicit_date_updates_original_return(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)

    async def collect(tools):
        await tools['get_submission_draft']('travel')
        await tools['update_submission_draft']('travel', {
            'purpose': '南京客户评审', 'companions': ['陈宁'],
            'legs': [{'id': 'go', 'departureCity': '南京', 'arrivalCity': '上海',
                      'departureDate': '2026-11-19', 'transport': '火车-一等座'}],
        })
        await tools['ask_user']('返程如何安排？', [{'id': 'pending', 'label': '返程未定'}], draft_id='travel')

    first = run_journey(store, monkeypatch, 'collect', '11月19日从南京去上海拜访客户', collect)
    context, _ = store.mutate(lambda state: answer_question(state, 't', {
        'questionId': first['question']['id'], 'optionIds': ['pending'],
    }, ''))

    async def pending(tools):
        await tools['get_submission_draft']('travel')
        saved = await tools['update_submission_draft']('travel', {'returnDatePending': True})
        assert 'error' not in saved, saved
        await tools['validate_submission']('travel')

    message = run_journey(store, monkeypatch, 'pending', '返程未定', pending, question_context=context)
    assert message.get('submissionPhase') == 'ready'
    assert 'question' not in message
    draft = copy.deepcopy(store.get_state()['data']['submissions']['drafts']['travel'])
    assert draft['returnDatePending']
    go, back = draft['legs']
    assert (back['departureCity'], back['arrivalCity'], back['transport']) == ('上海', '南京', '火车-二等座')
    assert back['departureDate'] == back['arrivalDate'] == ''

    async def dated(tools):
        before = await tools['get_submission_draft']('travel')
        assert before['draft']['legs'][1]['id'] == back['id']
        await tools['update_submission_draft']('travel', {
            'legs': [{'id': go['id']}, {'id': back['id'], 'departureDate': '2026-11-21'}],
        })
        await tools['validate_submission']('travel')

    updated = run_journey(store, monkeypatch, 'dated', '返程定为11月21日', dated)
    assert updated.get('submissionPhase') == 'ready'
    final = store.get_state()['data']['submissions']['drafts']['travel']
    assert len(final['legs']) == 2
    assert final['legs'][0] == go
    assert final['companions'] == ['陈宁']
    assert final['purpose'] == '南京客户评审'
    assert final['legs'][1]['id'] == back['id']
    assert final['legs'][1]['departureDate'] == final['legs'][1]['arrivalDate'] == '2026-11-21'
    assert not final['returnDatePending']


def test_non_submission_result_does_not_attach_old_bound_draft(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)

    async def prepare(tools):
        await tools['get_submission_draft']('travel')

    first = run_journey(store, monkeypatch, 'prepare', '查看草稿', prepare)

    async def materials(tools):
        await tools['list_materials']()

    message = run_journey(store, monkeypatch, 'materials', '先看一下材料', materials)
    assert [card['kind'] for card in message['cards']] == ['materials']
    assert first.get('submissionPhase') == 'ready'


def test_saved_cards_reach_model_as_system_context_instead_of_assistant_prose(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    card = Business(store).get_draft('travel')['cards'][0]
    previous_text = '草稿已保留，确定返程后可以继续补充。'
    store.mutate(lambda state: state['tasks'][0].update(messages=[{
        'id': 'assistant-before', 'role': 'assistant', 'text': previous_text,
        'cards': [card], 'submissionPhase': 'ready',
    }], activeRunId='context'))
    store.create_run('context', 't', {'message': '本周六返回，回程改高铁。', 'refs': []})
    seen = []

    class InspectingAgent:
        def __init__(self, **kwargs):
            pass

        async def arun(self, messages, **kwargs):
            seen.extend(messages)
            yield SimpleNamespace(event='RunContent', content='返程已更新，请核对。')

    monkeypatch.setattr(agent_runtime, 'Agent', InspectingAgent)
    asyncio.run(agent_runtime.Runtime(store, Business(store)).execute('context'))
    assert [message.content for message in seen if message.role == 'assistant'] == [previous_text]
    system_context = '\n'.join(message.content for message in seen if message.role == 'system')
    assert '"id": "travel"' in system_context
    assert '"kind": "submission"' in system_context
    assert '"submissionPhase": "ready"' in system_context


def test_other_conversations_trip_is_read_only_until_selected(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    old = Business(store).update_draft('travel', {'purpose': '12月上海出差'})['draft']
    ref = {'kind': 'submission', 'id': 'travel', 'title': '原差旅草稿'}
    store.mutate(lambda s: s['tasks'].append({'id': 'original-trip', 'refs': [ref], 'messages': [], 'status': '待核对'}))
    seen = {}
    async def collect(tools):
        seen['read'] = await tools['get_submission_draft']('travel')
        seen['refs'] = store.get_state()['tasks'][0].get('refs', [])
        seen['write'] = await tools['update_submission_draft']('travel', {'purpose': '改到了别人的草稿'})
        seen['check'] = await tools['validate_submission']('travel')
        fresh = (await tools['new_submission_draft']('travel'))['draft']
        await tools['update_submission_draft'](fresh['id'], {'purpose': '本次拜访客户'})
        await tools['ask_user']('下周哪天出发？', [], draft_id=fresh['id'])

    msg = run_journey(store, monkeypatch, 'scope', '下周杭州到上海拜访客户', collect)
    assert seen['refs'] == []
    assert seen['write'].get('error') and seen['check'].get('error')
    assert store.get_state()['data']['submissions']['drafts']['travel'] == old
    assert msg['question']['draftId'] != 'travel'
    assert store.get_state()['tasks'][0]['refs'][0]['id'] == msg['question']['draftId']


def test_locked_trip_offers_only_actions_supported_by_its_state(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    store.mutate(lambda s: s['data']['submissions']['drafts']['travel'].update(status='awaiting_receipt'))
    async def collect(tools):
        await tools['get_submission_draft']('travel')
        await tools['ask_user']('原差旅如何处理？', [{'id': 'new', 'label': '新建申请'}, {'id': 'edit', 'label': '沿用原单并修改日期'}])
    msg = run_journey(store, monkeypatch, 'lock', '我明天去北京出差', collect)
    assert [o['id'] for o in msg['question']['options']] == ['view_existing', 'new_application']
    assert msg['question']['sourceDraftId'] == 'travel'
    assert not store.get_state()['tasks'][0]['refs']


def test_viewing_locked_trip_reads_its_own_submitted_document(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    business = Business(store)
    draft_id = business.new_draft('travel')['draft']['id']
    draft = business.update_draft(draft_id, {'purpose': '北京客户拜访', 'legs': [{
        'departureCity': '杭州', 'arrivalCity': '北京', 'departureDate': '2026-11-20',
        'arrivalDate': '2026-11-20', 'transport': '高铁',
    }, {
        'departureCity': '北京', 'arrivalCity': '杭州', 'departureDate': '2026-11-22',
        'arrivalDate': '2026-11-22', 'transport': '高铁',
    }]})['draft']
    check = business.validate_draft(draft_id)
    assert check['canSubmit'], check['check']['issues']
    receipt = business.submit_draft(draft_id, draft['version'], 'source-trip')['receipt']

    async def collect(tools):
        await tools['get_submission_draft'](draft_id)
        await tools['ask_user']('是否沿用原单？', [{'id': 'edit', 'label': '修改日期'}])
    asked = run_journey(store, monkeypatch, 'read-lock', '查看原有差旅', collect)['question']
    assert asked['sourceDocumentId'] == receipt['businessId']
    context, label = store.mutate(lambda state: answer_question(state, 't', {
        'questionId': asked['id'], 'optionIds': ['view_existing']}, ''))
    async def unexpected_model(tools):
        pytest.fail('选好原单后应直接读其真实进展')
    reply = run_journey(store, monkeypatch, 'view', label, unexpected_model, question_context=context)
    assert receipt['businessId'] in reply['text']
    assert reply['cards'][0]['data']['items'][0]['id'] == receipt['businessId']
    assert len(store.get_state()['data']['submissions']['requests']) == 1
