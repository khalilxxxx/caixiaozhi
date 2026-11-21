from clarification_service import answer_question
from test_travel_followup_runtime import prepare_store, run_journey


def test_reimbursement_agent_lists_then_links_selected_approved_application(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    observed = {}

    async def find(tools):
        draft = await tools['get_submission_draft']('expense')
        result = await tools['list_reimbursable_travel_applications']('上海')
        candidate = next(item for item in result['items'] if item['id'] == 'TA-20261113-015')
        observed['unconfirmed'] = await tools['link_travel_application']('expense', candidate['id'])
        observed['direct_patch'] = await tools['update_submission_draft'](
            'expense', {'applicationId': candidate['id']})
        await tools['ask_user']('请选择要关联的差旅申请', [{'id': candidate['id'], 'label': candidate['title']}],
                                draft_id=draft['draft']['id'])

    first = run_journey(store, monkeypatch, 'find', '报销上次上海出差', find)
    assert first['question']['options'][0]['id'] == 'TA-20261113-015'
    assert observed['unconfirmed']['code'] == 'APPLICATION_SELECTION_REQUIRED'
    assert observed['direct_patch']['code'] == 'APPLICATION_SELECTION_REQUIRED'
    assert not store.get_state()['data']['submissions']['drafts']['expense']['applicationId']

    context, _ = store.mutate(lambda state: answer_question(state, 't', {
        'questionId': first['question']['id'], 'optionIds': ['TA-20261113-015'],
    }, ''))

    async def link(tools):
        await tools['get_submission_draft']('expense')
        result = await tools['link_travel_application']('expense', 'TA-20261113-015')
        assert result['importedLegCount'] == 2
        result = await tools['update_submission_draft']('expense', {'purpose': '上海现场交流'})
        assert 'error' not in result

    message = run_journey(store, monkeypatch, 'link', '上海差旅申请', link, question_context=context)
    assert [card['id'] for card in message['cards'] if card['kind'] == 'submission'] == ['expense']
    draft = store.get_state()['data']['submissions']['drafts']['expense']
    assert draft['applicationId'] == 'TA-20261113-015'
    assert [row['arrivalCity'] for row in draft['legs']] == ['上海', '杭州']
    assert draft['purpose'] == '上海现场交流'


def test_only_explicit_association_or_its_selection_authorizes_link(tmp_path, monkeypatch):
    store = prepare_store(tmp_path, monkeypatch)
    number = 'TA-20261113-015'
    results = []

    async def attempt(tools):
        await tools['get_submission_draft']('expense')
        results.append(await tools['link_travel_application']('expense', number))

    run_journey(store, monkeypatch, 'read-only', f'不要关联 {number}，先查一下审批情况', attempt)
    assert results[-1]['code'] == 'APPLICATION_SELECTION_REQUIRED'

    async def select_for_reading(tools):
        await tools['get_submission_draft']('expense')
        await tools['ask_user']('请选择要查看的申请', [{'id': number, 'label': number}], draft_id='expense')

    choice = run_journey(store, monkeypatch, 'preview', '查看上海申请', select_for_reading)
    context, _ = store.mutate(lambda state: answer_question(state, 't', {
        'questionId': choice['question']['id'], 'optionIds': [number],
    }, ''))
    run_journey(store, monkeypatch, 'read-choice', number, attempt, question_context=context)
    assert results[-1]['code'] == 'APPLICATION_SELECTION_REQUIRED'
    assert not store.get_state()['data']['submissions']['drafts']['expense']['applicationId']

    run_journey(store, monkeypatch, 'explicit-link', f'请关联差旅申请 {number}', attempt)
    assert results[-1]['importedLegCount'] == 2
