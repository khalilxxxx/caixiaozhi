import asyncio
import copy
import json
import sqlite3
from types import SimpleNamespace

import httpx
import pytest
from agno.models.openai.like import OpenAILike
from fastapi.testclient import TestClient

from agent_runtime import Runtime
from business import Business
from store import Store


def pending_store(tmp_path, *, multiple=False, draft=False):
    store = Store(tmp_path / 'questions.db')
    question = {'id': 'q1', 'title': '如何办理北京出差？', 'options': [
        {'id': 'new', 'label': '新建北京申请'},
        {'id': 'existing', 'label': '继续上海草稿'},
    ], 'multiple': multiple, 'status': 'pending'}
    if draft:
        question.update(draftId='travel', draftVersion=store.get_state()['data']['submissions']['drafts']['travel']['version'])
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'title': '北京出差', 'status': '待你回答', 'messages': [
            {'id': 'assistant-question', 'role': 'assistant', 'text': question['title'], 'question': question},
        ], 'refs': [], 'activeRunId': None,
    }))
    return store


def client_for(store, monkeypatch, *, configured=True):
    import config
    from server import create_app
    monkeypatch.setattr(config, 'API_KEY', 'test-key' if configured else '')
    app = create_app(store)
    # The HTTP tests stop at durable enqueue; model execution has separate stream tests.
    monkeypatch.setattr(app.state.runtime, 'launch', lambda run_id: None)
    return TestClient(app)


def question_from(store):
    return store.get_state()['tasks'][0]['messages'][0]['question']


def test_answer_is_saved_with_run_and_cannot_execute_twice(tmp_path, monkeypatch):
    store = pending_store(tmp_path)
    client = client_for(store, monkeypatch)
    payload = {'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'optionIds': ['new'], 'text': '保留上海草稿'}}
    response = client.post('/api/local/runs', json=payload)
    assert response.status_code == 200
    run = store.run(response.json()['runId'])
    assert question_from(store)['answer'] == {'optionIds': ['new'], 'text': '保留上海草稿'}
    assert question_from(store)['status'] == 'answered'
    assert run['request']['questionContext']['question']['title'] == '如何办理北京出差？'
    assert run['request']['questionContext']['mode'] == 'selection'
    task = store.get_state()['tasks'][0]
    assert task['messages'][-1]['questionAnswer']['questionId'] == 'q1'
    assert '新建北京申请' in task['messages'][-1]['text']
    store.mutate(lambda state: state['tasks'][0].update(activeRunId=None))
    duplicate = client.post('/api/local/runs', json=payload)
    assert duplicate.status_code == 409
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == 1


@pytest.mark.parametrize('answer', [
    {'questionId': 'missing', 'optionIds': ['new']},
    {'questionId': 'q1', 'optionIds': ['unknown']},
    {'questionId': 'q1', 'optionIds': ['new', 'existing']},
    {'questionId': 'q1', 'optionIds': ['new', 'new']},
    {'questionId': 'q1', 'optionIds': [], 'text': '  '},
])
def test_invalid_answers_never_start_a_run_or_consume_question(tmp_path, monkeypatch, answer):
    store = pending_store(tmp_path)
    response = client_for(store, monkeypatch).post('/api/local/runs', json={'taskId': 't', 'message': '回答', 'questionAnswer': answer})
    assert response.status_code in {409, 422}
    assert question_from(store)['status'] == 'pending'
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == 0


def test_answer_cannot_be_applied_to_another_task(tmp_path, monkeypatch):
    store = pending_store(tmp_path)
    response = client_for(store, monkeypatch).post('/api/local/runs', json={
        'taskId': 'other', 'message': '新建北京申请', 'questionAnswer': {'questionId': 'q1', 'optionIds': ['new']},
    })
    assert response.status_code == 409
    assert len(store.get_state()['tasks']) == 1
    assert question_from(store)['status'] == 'pending'


def test_multiple_answer_and_plain_text_keep_real_question_context(tmp_path, monkeypatch):
    store = pending_store(tmp_path, multiple=True)
    client = client_for(store, monkeypatch)
    response = client.post('/api/local/runs', json={
        'taskId': 't', 'message': '两个都要', 'questionAnswer': {'questionId': 'q1', 'optionIds': ['new', 'existing']},
    })
    assert response.status_code == 200
    assert question_from(store)['answer']['optionIds'] == ['new', 'existing']

    other_store = pending_store(tmp_path / 'plain')
    other_store.mutate(lambda state: state['tasks'][0].update(refs=[{'kind': 'submission', 'id': 'travel'}]))
    response = client_for(other_store, monkeypatch).post('/api/local/runs', json={
        'taskId': 't', 'message': '这次是去北京复核费用', 'refs': [{'kind': 'submission', 'id': 'personal'}],
    })
    assert response.status_code == 200
    assert question_from(other_store)['answer'] == {'optionIds': [], 'text': '这次是去北京复核费用'}
    context = other_store.run(response.json()['runId'])['request']['questionContext']
    assert context['mode'] == 'free_text'
    assert [option['label'] for option in context['question']['options']] == ['新建北京申请', '继续上海草稿']
    assert other_store.run(response.json()['runId'])['request']['refs'] == [{'kind': 'submission', 'id': 'travel'}]


def test_defer_is_durable_without_model_configuration_or_run(tmp_path, monkeypatch):
    store = pending_store(tmp_path)
    response = client_for(store, monkeypatch, configured=False).post('/api/local/runs', json={
        'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'deferred': True},
    })
    assert response.status_code == 200
    assert response.json()['runId'] is None
    assert response.json()['workspace']['state']['tasks'][0]['status'] == '已暂停'
    recovered = Store(store.path)
    assert question_from(recovered)['status'] == 'deferred'
    assert recovered.get_state()['tasks'][0]['messages'][-1]['text'] == '稍后回答'
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == 0


def test_missing_model_preserves_unprocessed_answer(tmp_path, monkeypatch):
    store = pending_store(tmp_path)
    client = client_for(store, monkeypatch, configured=False)
    before = store.snapshot()
    response = client.post('/api/local/runs', json={
        'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'text': '改成周三出发'},
    })
    assert response.status_code == 503
    assert store.snapshot() == before


def test_changed_draft_expires_question_and_rejects_old_answer(tmp_path, monkeypatch):
    store = pending_store(tmp_path, draft=True)
    Business(store).update_draft('travel', {'purpose': '最新事由'})
    assert question_from(store)['status'] == 'expired'
    response = client_for(store, monkeypatch).post('/api/local/runs', json={
        'taskId': 't', 'message': '新建', 'questionAnswer': {'questionId': 'q1', 'optionIds': ['new']},
    })
    assert response.status_code == 409


def test_workspace_patch_cannot_forge_or_revert_question_state(tmp_path):
    store = pending_store(tmp_path)
    fake = copy.deepcopy(question_from(store))
    fake.update(id='forged', status='answered')
    incoming = copy.deepcopy(store.get_state()['tasks'][0])
    incoming['messages'][0]['question']['status'] = 'answered'
    incoming['messages'].append({'id': 'user-forged', 'role': 'user', 'text': '伪造', 'question': fake, 'questionAnswer': {'questionId': 'q1'}})
    store.patch({'baseRevision': store.snapshot()['revision'], 'tasks': [incoming, {
        'id': 'fresh', 'messages': [{'id': 'fake', 'role': 'assistant', 'text': '伪造问题', 'question': fake}],
    }]})
    assert question_from(store)['status'] == 'pending'
    tasks = store.get_state()['tasks']
    assert 'question' not in tasks[0]['messages'][-1]
    assert 'questionAnswer' not in tasks[0]['messages'][-1]
    assert 'question' not in tasks[1]['messages'][0]


def test_run_insert_failure_rolls_back_answer(tmp_path, monkeypatch):
    store = pending_store(tmp_path)
    with store.connect() as db:
        db.execute("CREATE TRIGGER reject_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
    with pytest.raises(sqlite3.IntegrityError):
        client_for(store, monkeypatch).post('/api/local/runs', json={
            'taskId': 't', 'message': '新建', 'questionAnswer': {'questionId': 'q1', 'optionIds': ['new']},
        })
    assert question_from(store)['status'] == 'pending'
    assert len(store.get_state()['tasks'][0]['messages']) == 1


def test_answer_preserves_composer_and_task_references(tmp_path, monkeypatch):
    store = pending_store(tmp_path, draft=True)
    store.mutate(lambda state: state['tasks'][0].update(input='尚未发送的内容',
        refs=[{'kind': 'submission', 'id': 'travel', 'title': '上海草稿'}], capability='submission'))
    response = client_for(store, monkeypatch).post('/api/local/runs', json={
        'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'optionIds': ['new']},
        'refs': [{'kind': 'submission', 'id': 'personal'}], 'capability': 'analysis',
    })
    assert response.status_code == 200
    task = store.get_state()['tasks'][0]
    assert task['input'] == '尚未发送的内容'
    assert task['refs'] == [{'kind': 'submission', 'id': 'travel', 'title': '上海草稿'}]
    request = store.run(response.json()['runId'])['request']
    assert request['refs'] == task['refs']
    assert request['capability'] == 'submission'


def test_recovery_preserves_issued_question_and_does_not_duplicate_message(tmp_path):
    store = pending_store(tmp_path)
    store.mutate(lambda state: state['tasks'][0].update(activeRunId='question'))
    store.create_run('question', 't', {'message': '北京出差'})
    recovered = Store(store.path)
    recovered.recover()
    task = recovered.get_state()['tasks'][0]
    assert task['status'] == '待你回答'
    assert task['activeRunId'] is None
    assert len(task['messages']) == 1
    assert task['messages'][0]['question']['status'] == 'pending'


def callable_tool(candidate):
    return getattr(candidate, 'entrypoint', candidate)


def test_ask_tool_persists_question_without_body_and_blocks_following_writes(tmp_path, monkeypatch):
    import agent_runtime
    store = Store(tmp_path / 'runtime.db')
    original = copy.deepcopy(store.get_state()['data']['submissions']['drafts']['travel'])
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'activeRunId': 'r', 'messages': [{'role': 'user', 'text': '北京出差'}]}))
    store.create_run('r', 't', {'message': '北京出差', 'refs': []})

    class AskingAgent:
        def __init__(self, **kwargs):
            self.tools = {callable_tool(candidate).__name__: callable_tool(candidate) for candidate in kwargs['tools']}

        async def arun(self, *args, **kwargs):
            assert 'ask_user' in self.tools
            await self.tools['ask_user']('是否新建北京申请？', [{'id': 'new', 'label': '新建北京申请'}], draft_id='travel')
            # A provider can return more than one tool call in the same batch.
            await self.tools['update_submission_draft']('travel', {'purpose': '不得写入'})
            if False:
                yield SimpleNamespace(event='RunContent', content='')

    monkeypatch.setattr(agent_runtime, 'Agent', AskingAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    asyncio.run(Runtime(store, Business(store)).execute('r'))
    task = store.get_state()['tasks'][0]
    assert store.run('r')['status'] == 'completed'
    assert task['status'] == '待你回答'
    assert task['messages'][-1]['question']['draftVersion'] == original['version']
    assert task['messages'][-1]['text'] == '是否新建北京申请？'
    assert store.get_state()['data']['submissions']['drafts']['travel'] == original
    assert next(event['data'] for event in store.events('r') if event['kind'] == 'result')['question']['status'] == 'pending'
    assert question_from_runtime(Store(store.path))['status'] == 'pending'


def test_rejected_question_can_be_corrected_in_the_same_run(tmp_path, monkeypatch):
    import agent_runtime
    import config

    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'question-retry.db')
    user_message = '帮我处理一下出差的事'
    title = '你想新建差旅申请，还是查询已提交单据？'

    def prepare(state):
        state['data']['submissions']['drafts']['travel']['status'] = 'awaiting_receipt'
        state['tasks'].insert(0, {
            'id': 't', 'activeRunId': 'r', 'refs': [],
            'messages': [{'role': 'user', 'text': user_message}],
        })

    store.mutate(prepare)
    store.create_run('r', 't', {'message': user_message, 'refs': []})
    requests = []

    def respond(request):
        messages = json.loads(request.content)['messages']
        requests.append(messages)
        arguments = {'title': title}
        if len(requests) == 1:
            arguments['draft_id'] = 'travel'
        tool_call = {
            'index': 0, 'id': f'call-{len(requests)}', 'type': 'function',
            'function': {'name': 'ask_user', 'arguments': json.dumps(arguments)},
        }
        chunk = {
            'id': 'synthetic', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'test-model',
            'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [tool_call]},
                         'finish_reason': 'tool_calls'}],
        }
        return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                              text=f'data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n')

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            monkeypatch.setattr(agent_runtime, 'model', lambda: OpenAILike(
                id='test-model', api_key='test-key', base_url='https://model.test/v1', http_client=client,
            ))
            await Runtime(store, Business(store)).execute('r')

    asyncio.run(run())
    assert store.run('r')['status'] == 'completed'
    assert len(requests) == 2
    assert any('不可编辑' in message['content'] for message in requests[1] if message['role'] == 'tool')
    task = store.get_state()['tasks'][0]
    assert task['status'] == '待你回答'
    question = question_from_runtime(store)
    assert question['status'] == 'pending' and question['title'] == title
    assert 'draftId' not in question
    assert store.get_state()['data']['submissions']['drafts']['travel']['status'] == 'awaiting_receipt'


def question_from_runtime(store):
    return next(message['question'] for message in store.get_state()['tasks'][0]['messages'] if message.get('question'))


def test_runtime_passes_question_and_free_answer_to_model_and_failure_keeps_them(tmp_path, monkeypatch):
    import agent_runtime
    store = pending_store(tmp_path)
    response = client_for(store, monkeypatch).post('/api/local/runs', json={'taskId': 't', 'message': '这次只想核对原申请'})
    seen = []

    class FailingAgent:
        def __init__(self, **kwargs):
            pass

        async def arun(self, messages, **kwargs):
            seen.extend(message.content for message in messages)
            yield SimpleNamespace(event='RunError', content='provider failed')

    monkeypatch.setattr(agent_runtime, 'Agent', FailingAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    runtime = Runtime(store, Business(store))
    asyncio.run(runtime.execute(response.json()['runId']))
    content = '\n'.join(seen)
    assert '如何办理北京出差？' in content and '新建北京申请' in content and '这次只想核对原申请' in content
    assert 'free_text' in content
    assert question_from(store)['status'] == 'answered'
    assert store.get_state()['tasks'][0]['activeRunId'] is None
    assert store.get_state()['tasks'][0]['status'] == '执行失败'
    recovery = client_for(store, monkeypatch).post('/api/local/runs', json={'taskId': 't', 'message': '继续刚才的任务'})
    assert recovery.status_code == 200


def test_new_draft_continuation_tracks_final_instance_in_task_refs(tmp_path, monkeypatch):
    import agent_runtime
    store = Store(tmp_path / 'new-draft-run.db')
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'activeRunId': 'r', 'messages': [{'id': 'u', 'role': 'user', 'text': '新建北京申请，保留上海草稿'}],
        'refs': [{'kind': 'submission', 'id': 'travel', 'title': '上海草稿'}],
    }))
    store.create_run('r', 't', {'message': '新建北京申请，保留上海草稿', 'refs': []})

    class NewDraftAgent:
        def __init__(self, **kwargs):
            self.tools = {callable_tool(candidate).__name__: callable_tool(candidate) for candidate in kwargs['tools']}

        async def arun(self, *args, **kwargs):
            await self.tools['get_submission_draft']('travel')
            created = await self.tools['new_submission_draft']('travel')
            draft_id = created['draft']['id']
            await self.tools['update_submission_draft'](draft_id, {'purpose': '北京拜访客户'})
            await self.tools['validate_submission'](draft_id)
            yield SimpleNamespace(event='RunContent', content='北京申请已新建，请核对。')

    monkeypatch.setattr(agent_runtime, 'Agent', NewDraftAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    asyncio.run(Runtime(store, Business(store)).execute('r'))
    task = store.get_state()['tasks'][0]
    assert store.run('r')['status'] == 'completed'
    assert task['refs'][0]['id'].startswith('travel-')
    selected = store.get_state()['data']['submissions']['drafts'][task['refs'][0]['id']]
    assert selected['purpose'] == '北京拜访客户'


@pytest.mark.parametrize('ending', ['failed', 'restart'])
def test_partial_new_draft_survives_failure_or_restart_with_its_reference(tmp_path, monkeypatch, ending):
    import agent_runtime
    store = Store(tmp_path / 'partial-new-draft.db')
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'activeRunId': 'r', 'messages': [{'id': 'u', 'role': 'user', 'text': '新建北京申请，保留上海草稿'}],
        'refs': [{'kind': 'submission', 'id': 'travel', 'title': '上海草稿'}],
    }))
    store.create_run('r', 't', {'message': '新建北京申请，保留上海草稿', 'refs': []})
    checkpoints = []

    class ProcessStopped(BaseException):
        pass

    class PartialAgent:
        def __init__(self, **kwargs):
            self.tools = {callable_tool(candidate).__name__: callable_tool(candidate) for candidate in kwargs['tools']}

        async def arun(self, *args, **kwargs):
            await self.tools['get_submission_draft']('travel')
            created = await self.tools['new_submission_draft']('travel')
            await self.tools['update_submission_draft'](created['draft']['id'], {'purpose': '北京拜访客户'})
            checkpoints.append(Store(store.path).get_state()['tasks'][0])
            if ending == 'restart':
                raise ProcessStopped()
            yield SimpleNamespace(event='RunError', content='provider failed')

    monkeypatch.setattr(agent_runtime, 'Agent', PartialAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    if ending == 'restart':
        with pytest.raises(ProcessStopped):
            asyncio.run(Runtime(store, Business(store)).execute('r'))
        Store(store.path).recover()
    else:
        asyncio.run(Runtime(store, Business(store)).execute('r'))
    task = Store(store.path).get_state()['tasks'][0]
    assert task['refs'][0]['id'].startswith('travel-')
    assert checkpoints[0]['refs'] == task['refs']
    draft_id = task['refs'][0]['id']
    assert store.get_state()['data']['submissions']['drafts'][draft_id]['purpose'] == '北京拜访客户'
    output = [message for message in task['messages'] if message.get('id') == 'assistant-r']
    assert len(output) == 1
    assert any(card['id'] == draft_id for card in output[0]['cards'])
    assert output[0]['text']
    assert any(tool['name'] == 'new_submission_draft' for tool in output[0]['tools'])
    assert task['status'] == ('执行失败' if ending == 'failed' else '已暂停')
    assert task['activeRunId'] is None

    seen = []
    class ContinueAgent:
        def __init__(self, **kwargs):
            pass

        async def arun(self, messages, **kwargs):
            seen.extend(message.content for message in messages)
            yield SimpleNamespace(event='RunContent', content='继续核对已保存的北京申请。')

    monkeypatch.setattr(agent_runtime, 'Agent', ContinueAgent)
    store.mutate(lambda state: state['tasks'][0].update(activeRunId='retry'))
    store.create_run('retry', 't', {'message': '继续', 'refs': []})
    asyncio.run(Runtime(store, Business(store)).execute('retry'))
    assert draft_id in '\n'.join(seen)
    assert len(store.get_state()['data']['submissions']['drafts']) == 4


def test_question_updates_existing_partial_result_without_duplicate_message(tmp_path, monkeypatch):
    import agent_runtime
    store = Store(tmp_path / 'question-after-read.db')
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'activeRunId': 'r', 'messages': [{'id': 'u', 'role': 'user', 'text': '北京出差'}], 'refs': [],
    }))
    store.create_run('r', 't', {'message': '北京出差', 'refs': []})
    checkpoints = []

    class ReadThenAskAgent:
        def __init__(self, **kwargs):
            self.tools = {callable_tool(candidate).__name__: callable_tool(candidate) for candidate in kwargs['tools']}

        async def arun(self, *args, **kwargs):
            await self.tools['get_submission_draft']('travel')
            checkpoints.append(Store(store.path).get_state()['tasks'][0])
            await self.tools['ask_user']('是否新建北京申请？', [{'id': 'new', 'label': '新建北京申请'}], draft_id='travel')
            if False:
                yield SimpleNamespace(event='RunContent', content='')

    monkeypatch.setattr(agent_runtime, 'Agent', ReadThenAskAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    asyncio.run(Runtime(store, Business(store)).execute('r'))
    assert any(message.get('cards') for message in checkpoints[0]['messages'])
    output = [message for message in store.get_state()['tasks'][0]['messages'] if message.get('id') == 'assistant-r']
    assert len(output) == 1
    assert output[0]['question']['status'] == 'pending'
    assert output[0]['cards'][0]['id'] == 'travel'
    assert [tool['name'] for tool in output[0]['tools']] == ['get_submission_draft', 'ask_user']


def test_question_issue_bounds_and_replaces_previous_pending(tmp_path):
    import clarification_service
    store = pending_store(tmp_path)
    with pytest.raises(ValueError):
        store.mutate(lambda state: clarification_service.issue_question(state, 't', '请选择', [{'id': str(i), 'label': str(i)} for i in range(7)]))
    assert question_from(store)['status'] == 'pending'
    question = store.mutate(lambda state: clarification_service.issue_question(state, 't', '请补充办理方向', []))
    assert question['options'] == [] and question['status'] == 'pending'
    assert question_from(store)['status'] == 'expired'


def test_resume_reopens_only_original_question_without_creating_a_run(tmp_path, monkeypatch):
    store = pending_store(tmp_path, draft=True)
    client = client_for(store, monkeypatch, configured=False)
    original = question_from(store)
    url = '/api/local/tasks/t/questions/q1/resume'
    client.post('/api/local/runs', json={'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'deferred': True}}).raise_for_status()
    assert client.post('/api/local/tasks/other/questions/q1/resume').status_code == 409
    client.post(url).raise_for_status()
    assert question_from(Store(store.path)) == original
    assert client.post(url).status_code == 200
    assert store.get_state()['tasks'][0]['status'] == '待你回答'
    assert len(store.get_state()['tasks'][0]['messages']) == 2
    client.post('/api/local/runs', json={'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'deferred': True}}).raise_for_status()
    Business(store).update_draft('travel', {'purpose': '已手工修改'})
    assert client.post(url).status_code == 409
    assert question_from(store)['status'] != 'pending'


def test_policy_side_question_preserves_date_decision(tmp_path, monkeypatch):
    store = pending_store(tmp_path, draft=True)
    client = client_for(store, monkeypatch)
    q = '日期稍后再答，先查一下上海住宿标准'
    response = client.post('/api/local/runs', json={'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'text': q}})
    response.raise_for_status()
    assert question_from(store)['status'] == 'pending'
    run = store.run(response.json()['runId'])
    assert run['request']['questionContext']['mode'] == 'policy_lookup'
    observed = []
    class PolicyAgent:
        def __init__(self, **kwargs):
            observed.extend(getattr(tool, 'entrypoint', tool).__name__ for tool in kwargs['tools'])
            self.search = kwargs['tools'][0]

        async def arun(self, *args, **kwargs):
            await self.search('上海住宿标准')
            yield SimpleNamespace(event='RunContent', content='上海普通员工的住宿标准为每晚600元。')

    import agent_runtime
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    monkeypatch.setattr(agent_runtime, 'Agent', PolicyAgent)
    asyncio.run(Runtime(store, Business(store)).execute(run['id']))
    task = store.get_state()['tasks'][0]
    assert observed == ['search_policies']
    assert task['status'] == '待你回答' and question_from(store)['id'] == 'q1'
    assert task['messages'][-1]['cards'][0]['kind'] == 'knowledge'
    assert not any(m.get('role') == 'user' and m.get('questionAnswer') for m in task['messages'])



def test_answer_keeps_question_target_after_composer_draft_changes(tmp_path, monkeypatch):
    store = pending_store(tmp_path, draft=True)
    replacement = Business(store).new_draft('travel')['draft']
    other_ref = {'kind': 'submission', 'id': replacement['id'], 'title': replacement['title']}
    store.mutate(lambda state: state['tasks'][0].update(refs=[other_ref]))
    client = client_for(store, monkeypatch)
    response = client.post('/api/local/runs', json={'taskId': 't', 'questionAnswer': {'questionId': 'q1', 'text': '周三出发'}})
    response.raise_for_status()
    run = store.run(response.json()['runId'])
    assert [r['id'] for r in run['request']['refs']] == ['travel']
    assert store.get_state()['tasks'][0]['refs'] == [other_ref]
