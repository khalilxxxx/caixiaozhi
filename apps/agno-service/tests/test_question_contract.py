import pytest


def state_with_task():
    return {'data': {}, 'tasks': [{'id': 't', 'messages': []}]}


def test_question_and_answer_retain_option_identity_and_context():
    from clarification_service import issue_question, answer_question
    state = state_with_task()
    question = issue_question(state, 't', '如何办理？', [{'id': 'new', 'label': '新建申请'}])
    context, summary = answer_question(state, 't', {'questionId': question['id'], 'optionIds': ['new']}, '')
    assert context['question']['status'] == 'answered'
    assert context['question']['answer'] == {'optionIds': ['new'], 'text': ''}
    assert summary == '新建申请'
    assert context['mode'] == 'selection'
    assert state['tasks'][0]['messages'][0]['question']['status'] == 'answered'
    with pytest.raises(ValueError):
        answer_question(state, 't', {'questionId': question['id'], 'optionIds': ['new']}, '')


def test_text_answer_never_guesses_an_option_or_grants_selection():
    from clarification_service import issue_question, answer_question
    state = state_with_task()
    issue_question(state, 't', '是否新建？', [{'id': 'new', 'label': '新建申请'}])
    context, summary = answer_question(state, 't', None, '先看一下上海草稿')
    assert context['mode'] == 'free_text'
    assert context['question']['answer']['optionIds'] == []
    assert context['question']['answer']['text'] == '先看一下上海草稿'
    assert summary == '先看一下上海草稿'


def test_new_question_expires_previous_and_limits_options():
    from clarification_service import issue_question
    state = state_with_task()
    first = issue_question(state, 't', '选择申请', [])
    with pytest.raises(ValueError):
        issue_question(state, 't', '选择申请', [{'id': str(i), 'label': str(i)} for i in range(7)])
    assert first['status'] == 'pending'
    second = issue_question(state, 't', '请补充办理方向', [])
    assert first['status'] == 'expired'
    assert second['status'] == 'pending'
