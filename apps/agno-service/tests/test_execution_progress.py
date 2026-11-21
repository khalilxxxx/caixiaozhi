"""Exercise durable execution state at the real runtime/store boundary."""
import asyncio
import json
from types import SimpleNamespace

import pytest

import agent_runtime
import config
from business import Business
from store import Store


def setup_run(tmp_path, monkeypatch, script, message='查询费用'):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'activeRunId': 'r', 'messages': [{'id': 'u', 'role': 'user', 'text': message}]}))
    store.create_run('r', 't', {'message': message, 'refs': []})
    business = Business(store)

    class ScriptedAgent:
        def __init__(self, **kwargs):
            self.tools = {(getattr(fn, '__name__', None) or fn.name): getattr(fn, 'entrypoint', fn)
                          for fn in kwargs['tools']}

        async def arun(self, *args, **kwargs):
            await script(self.tools, store, business)
            yield SimpleNamespace(event='RunContent', content='处理完成。', reasoning_content='private-reasoning')

    monkeypatch.setattr(agent_runtime, 'Agent', ScriptedAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    return store, agent_runtime.Runtime(store, business)


def saved_message(store):
    return next(m for m in store.get_state()['tasks'][0]['messages'] if m['id'] == 'assistant-r')


def tool_events(store):
    return [event['data'] for event in store.events('r') if event['kind'] == 'tool']


def test_each_tool_call_persists_before_business_read_and_reuses_its_id(tmp_path, monkeypatch):
    observed = []

    async def script(tools, store, business):
        original = business.query_documents

        def query(value):
            observed.append(saved_message(store))
            return original(value)

        business.query_documents = query
        await tools['query_documents']('上海')
        await tools['query_documents']('北京')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    assert len(observed) == 2
    assert [item['tools'][-1]['status'] for item in observed] == ['running', 'running']
    assert all(item['runStatus'] == 'running' for item in observed)
    events = tool_events(store)
    assert [item['status'] for item in events] == ['running', 'completed', 'running', 'completed']
    assert events[0]['id'] == events[1]['id'] != events[2]['id'] == events[3]['id']
    message = saved_message(store)
    assert len(message['tools']) == 2
    assert message['runStatus'] == 'completed'
    assert all(step['finishedAt'] >= step['startedAt'] and step['durationMs'] >= 0 for step in message['tools'])
    assert 'private-reasoning' not in json.dumps(store.events('r'))


@pytest.mark.parametrize('retry', [False, True])
def test_failed_return_is_recorded_and_retry_can_restore_completion(tmp_path, monkeypatch, retry):
    async def script(tools, store, business):
        business.query_documents = lambda query: {'error': '暂时不可用', 'code': 'unavailable'}
        await tools['query_documents']('上海')
        if retry:
            business.query_documents = lambda query: {'documents': [], 'dataSource': '本地数据'}
            await tools['query_documents']('上海')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    expected = 'completed' if retry else 'failed'
    assert store.run('r')['status'] == expected
    message = saved_message(store)
    assert message['runStatus'] == expected
    assert_run_window(store, 'result' if retry else 'error')
    assert 'finding' not in message['tools'][0]
    assert [step['status'] for step in message['tools']] == (['failed', 'completed'] if retry else ['failed'])
    if retry:
        assert len({step['id'] for step in message['tools']}) == 2
    else:
        assert store.get_state()['tasks'][0]['status'] == '执行失败'
        assert message['text'] != '处理完成。'


def test_cancellation_during_async_tool_keeps_terminal_step(tmp_path, monkeypatch):
    entered = asyncio.Event()

    async def extract(*args):
        entered.set()
        await asyncio.Future()

    monkeypatch.setattr('material_service.extract_materials', extract)

    async def script(tools, store, business):
        await tools['extract_expense_materials'](['file-1'])

    store, runtime = setup_run(tmp_path, monkeypatch, script)

    async def execute():
        runtime.launch('r')
        await entered.wait()
        assert saved_message(store)['tools'][0]['status'] == 'running'
        await runtime.cancel('r')

    asyncio.run(execute())
    message = saved_message(store)
    assert_run_window(store, 'error')
    assert message['runStatus'] == 'cancelled'
    assert message['tools'][0]['status'] == 'cancelled'
    assert message['tools'][0]['durationMs'] >= 0
    events = tool_events(store)
    assert events[0]['id'] == events[-1]['id']
    assert events[-1]['status'] == 'cancelled'


def test_restart_cancels_saved_running_steps_and_preserves_cards(tmp_path):
    store = Store(tmp_path / 'state.db')
    step = {'id': 's', 'name': 'extract', 'label': '提取材料', 'status': 'running', 'startedAt': 1000}
    card = {'kind': 'artifact', 'id': 'a', 'title': '已有成果'}
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'activeRunId': 'r', 'messages': [
        {'id': 'assistant-r', 'role': 'assistant', 'text': '', 'runId': 'r', 'runStatus': 'running', 'tools': [step], 'cards': [card]}]}))
    store.create_run('r', 't', {})
    store.recover()
    message = saved_message(store)
    assert_run_window(store, 'error', initial_event=False)
    assert message['runStatus'] == 'interrupted'
    assert message['tools'][0]['status'] == 'cancelled'
    assert message['tools'][0]['finishedAt'] >= 1000
    assert message['cards'] == [card]
    assert tool_events(store)[-1]['id'] == 's'
    assert tool_events(store)[-1]['status'] == 'cancelled'


@pytest.mark.parametrize('legacy_split', [False, True])
def test_recovery_keeps_committed_answer_and_completion_time(tmp_path, monkeypatch, legacy_split):
    async def script(tools, store, business):
        await tools['query_documents']('北京')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    original = saved_message(store)
    if legacy_split:
        # Older releases persisted the reply before finalizing the run row.
        with store.connect() as db:
            db.execute("UPDATE runs SET status='running', updated_at=created_at WHERE id='r'")
            db.execute("DELETE FROM events WHERE kind IN ('result','done')")
        def legacy_reply(state):
            message = state['tasks'][0]['messages'][-1]
            del message['runFinishedAt']
            del message['runStartedAt']
            message['createdAt'] = original['runFinishedAt']
        store.mutate(legacy_reply)
    else:
        # An old workspace can still refer to a run that already finished.
        store.mutate(lambda state: state['tasks'][0].update(activeRunId='r', status='处理中'))
    store.recover()
    store.recover()
    assert store.run('r')['status'] == 'completed'
    assert saved_message(store)['runStatus'] == 'completed'
    assert saved_message(store)['text'] == original['text']
    assert saved_message(store)['tools'] == original['tools']
    assert saved_message(store)['runFinishedAt'] == original['runFinishedAt']
    assert store.get_state()['tasks'][0]['activeRunId'] is None
    assert store.get_state()['tasks'][0]['status'] == '已完成'
    assert [event['kind'] for event in store.events('r')].count('done') == 1
    assert all(event['kind'] != 'error' for event in store.events('r'))


def test_recovery_respects_cancel_recorded_before_reply_was_saved(tmp_path):
    store = Store(tmp_path / 'legacy.db')
    store.create_run('r', 't', {})
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'activeRunId': 'r', 'messages': [
        {'id': 'assistant-r', 'runId': 'r', 'runStatus': 'running', 'tools': [
            {'id': 's', 'label': '核对材料', 'status': 'running'}]}]}))
    store.finish_run('r', 'cancelled')
    finish = store.run('r')['runFinishedAt']
    store.recover()
    assert saved_message(store)['runStatus'] == 'cancelled'
    assert saved_message(store)['runFinishedAt'] == finish
    assert_run_window(store, 'error', initial_event=False)
    assert next(e for e in store.events('r') if e['kind'] == 'error')['data']['runStatus'] == 'cancelled'


@pytest.mark.parametrize('status', ['failed', 'cancelled'])
def test_legacy_error_reply_creation_is_not_a_known_end_time(tmp_path, status):
    store = Store(tmp_path / 'legacy.db')
    store.create_run('r', 't', {})
    start = store.run('r')['runStartedAt']
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'activeRunId': 'r', 'status': '处理中', 'messages': [
        {'id': 'assistant-r', 'runId': 'r', 'runStatus': status,
         'createdAt': start, 'text': '已保存的反馈。'}]}))
    store.recover()
    assert saved_message(store)['text'] == '已保存的反馈。'
    assert 'runFinishedAt' not in saved_message(store)
    assert 'runFinishedAt' not in store.run('r')
    assert store.get_state()['tasks'][0]['status'] == ('执行失败' if status == 'failed' else '已暂停')


@pytest.mark.parametrize('saved_result', [False, True])
def test_completed_run_row_with_partial_reply_survives_recovery(tmp_path, monkeypatch, saved_result):
    async def script(tools, store, business):
        await tools['query_documents']('北京')
    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    original = saved_message(store)
    def partial(state):
        task = state['tasks'][0]
        task.update(activeRunId='r', status='处理中')
        task['messages'][-1] = {'id': 'assistant-r', 'role': 'assistant', 'text': '已保存的片段',
                                'runStatus': 'running', 'runId': 'r', 'tools': original['tools']}
    store.mutate(partial)
    if not saved_result:
        with store.connect() as db:
            db.execute("DELETE FROM events WHERE kind='result'")
    store.recover()
    assert saved_message(store)['text'] == (original['text'] if saved_result else '已保存的片段')
    assert saved_message(store)['runStatus'] == 'completed'
    assert saved_message(store)['tools'] == original['tools']
    assert saved_message(store)['runFinishedAt'] == original['runFinishedAt']
    if saved_result:
        assert saved_message(store)['cards'] == original['cards']
    assert store.get_state()['tasks'][0]['status'] == '已完成'
    assert all(event['kind'] != 'error' for event in store.events('r'))
    assert [event['kind'] for event in store.events('r')].count('done') == 1


@pytest.mark.parametrize('missing_reply', [False, True])
def test_recovery_of_old_result_does_not_reopen_an_answered_question(tmp_path, monkeypatch, missing_reply):
    async def script(tools, store, business):
        await tools['ask_user']('需要核对哪个月份？')
    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    def answered(state):
        task = state['tasks'][0]
        task.update(activeRunId='r', status='本地已受理')
        message = task['messages'][-1]
        message['runStatus'] = 'running'
        answer = {'text': '10月', 'optionIds': []}
        question_id = message['question']['id']
        message['question'].update(status='answered', answer=answer)
        if missing_reply:
            task['messages'].pop()
        task['messages'].append({'id': 'user-later', 'role': 'user', 'text': '10月',
                                 'questionAnswer': {'questionId': question_id, **answer, 'mode': 'free_text', 'deferred': False}})
        task['messages'].append({'id': 'assistant-later', 'runId': 'later',
                                 'role': 'assistant', 'text': '下一轮答复。', 'runStatus': 'completed'})
    store.mutate(answered)
    store.recover()
    question = saved_message(store)['question']
    assert question['status'] == 'answered' and question['answer'] == {'text': '10月', 'optionIds': []}
    assert saved_message(store)['runStatus'] == 'awaiting_input'
    task = store.get_state()['tasks'][0]
    assert task['status'] == '本地已受理' and task['messages'][-1]['text'] == '下一轮答复。'


def test_ask_user_has_one_complete_step_and_waiting_run_status(tmp_path, monkeypatch):
    async def script(tools, store, business):
        await tools['ask_user']('哪一天出发？')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    message = saved_message(store)
    assert_run_window(store, 'result')
    assert message['runStatus'] == 'awaiting_input'
    assert [entry['status'] for entry in tool_events(store)] == ['running', 'completed']
    assert len(message['tools']) == 1
    assert message['question']['status'] == 'pending'


def test_rule_generation_uses_single_step_and_keeps_failure(tmp_path, monkeypatch):
    async def generate(text):
        raise ValueError('不可执行')

    monkeypatch.setattr(agent_runtime, 'generate_rule', generate)

    async def script(tools, store, business):
        await tools['prepare_personal_rule']('提醒我检查')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    message = saved_message(store)
    assert message['runStatus'] == 'failed'
    assert len(message['tools']) == 1
    assert [entry['status'] for entry in tool_events(store)] == ['running', 'failed']
    assert tool_events(store)[0]['id'] == tool_events(store)[1]['id']


@pytest.mark.parametrize('message,expected', [
    ('请生成一份PPT文件', 'failed'),
    ('帮我制作费用Excel', 'failed'),
    ('生成文件', 'failed'),
    ('如何生成PPT文件？', 'completed'),
    ('PPT和Excel有什么区别？', 'completed'),
    ('不要生成文件，只说明如何制作PDF', 'completed'),
    ('解释“生成文件”这个术语', 'completed'),
    ('你好', 'completed'),
])
def test_explicit_deliverable_requires_actual_file_without_blocking_discussion(tmp_path, monkeypatch, message, expected):
    async def script(*args):
        pass

    store, runtime = setup_run(tmp_path, monkeypatch, script, message)
    asyncio.run(runtime.execute('r'))
    assert store.run('r')['status'] == expected
    assert saved_message(store)['runStatus'] == expected


@pytest.mark.parametrize('enabled', [True, False])
def test_official_deepseek_preserves_reasoning_for_tool_roundtrip(monkeypatch, enabled):
    from agno.models.message import Message
    monkeypatch.setattr(config, 'API_KEY', 'test-key')
    monkeypatch.setattr(config, 'BASE_URL', 'https://api.deepseek.com/v1')
    monkeypatch.setattr(config, 'THINKING', enabled, raising=False)
    configured = agent_runtime.model()
    assert configured.get_request_params()['extra_body']['thinking']['type'] == ('enabled' if enabled else 'disabled')
    previous = Message(role='assistant', content='', reasoning_content='private-reasoning',
                       tool_calls=[{'id': 'call-1', 'type': 'function', 'function': {'name': 'query_documents', 'arguments': '{}'}}])
    assert configured._format_message(previous)['reasoning_content'] == 'private-reasoning'


def test_other_provider_does_not_receive_deepseek_extension(monkeypatch):
    monkeypatch.setattr(config, 'API_KEY', 'test-key')
    monkeypatch.setattr(config, 'BASE_URL', 'https://deepseek.com.example.org/v1')
    monkeypatch.setattr(config, 'THINKING', True, raising=False)
    assert 'extra_body' not in agent_runtime.model().get_request_params()


def test_successful_different_query_does_not_resolve_previous_failure(tmp_path, monkeypatch):
    async def script(tools, store, business):
        business.query_documents = lambda query: {'error': '暂时不可用'}
        await tools['query_documents']('上海')
        business.query_documents = lambda query: {'documents': []}
        await tools['query_documents']('北京')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    assert saved_message(store)['runStatus'] == 'failed'


@pytest.mark.parametrize('publish,model_error,expected', [
    (False, False, 'failed'), (True, False, 'completed'), (True, True, 'failed'),
])
def test_real_output_requires_publication_and_survives_later_model_error(tmp_path, monkeypatch, publish, model_error, expected):
    from file_service import save_file

    async def script(tools, store, business):
        file = save_file(store, tmp_path / 'files', 'SKILL.md', 'text/markdown',
                         b'---\nname: text-output\ndescription: Save text output\n---\nSave a text file.')
        version = {'version': '1.0', 'status': 'published', 'mode': 'runnable',
                   'business': 'pass', 'security': 'pass', 'technical': 'pass', 'compatibility': 'pass', 'file': file}
        store.mutate(lambda state: state['data'].update(skillsHub={'skills': [
            {'id': 'text-output', 'title': '文本文件', 'view': True, 'call': True, 'versions': [version]}]}))
        await tools['get_skill_instructions']('text-output')
        written = await tools['write_skill_file']('output/result.txt', '可交付成果')
        assert written['size'] > 0
        if publish:
            result = await tools['publish_skill_artifact']('output/result.txt')
            assert result['artifact']['name'] == 'result.txt'
        if model_error:
            raise RuntimeError('模型中断')

    store, runtime = setup_run(tmp_path, monkeypatch, script, '处理附件')
    asyncio.run(runtime.execute('r'))
    assert store.run('r')['status'] == expected
    message = saved_message(store)
    if publish:
        assert message['cards'][0]['kind'] == 'artifact'
    assert message['runStatus'] == expected


@pytest.mark.parametrize('value,expected', [(None, True), ('false', False), ('0', False), ('enabled', True)])
def test_thinking_environment_default_and_override(monkeypatch, value, expected):
    import runpy
    import dotenv
    from pathlib import Path
    monkeypatch.setattr(dotenv, 'load_dotenv', lambda *args: None)
    if value is None:
        monkeypatch.delenv('AGNO_THINKING', raising=False)
    else:
        monkeypatch.setenv('AGNO_THINKING', value)
    loaded = runpy.run_path(str(Path(config.__file__)))
    assert loaded['THINKING'] is expected


def test_failed_script_with_unrelated_output_does_not_hide_failure(tmp_path, monkeypatch):
    from completion_check import CompletionCheck
    check = CompletionCheck({'message': '处理附件'})
    check.observe('run_skill_script', 'script-a', {'status': 'error', 'exitCode': 1, 'files': []}, 'failed')
    assert check.issue([{'id': 'other', 'name': 'unrelated.txt'}]) is not None


@pytest.mark.parametrize('message', ['生成PDF文件需要什么工具？', '生成PPT的方法有哪些？', '帮我做Excel数据分析'])
def test_creation_terms_in_discussion_or_analysis_do_not_require_download(tmp_path, monkeypatch, message):
    async def script(*args):
        pass
    store, runtime = setup_run(tmp_path, monkeypatch, script, message)
    asyncio.run(runtime.execute('r'))
    assert saved_message(store)['runStatus'] == 'completed'


def test_failed_status_without_error_text_is_not_a_success(tmp_path, monkeypatch):
    async def script(tools, store, business):
        business.query_documents = lambda query: {'status': 'failed'}
        await tools['query_documents']('上海')
    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    assert saved_message(store)['tools'][0]['status'] == 'failed'
    assert saved_message(store)['runStatus'] == 'failed'


def test_snapshot_failure_keeps_committed_business_result(tmp_path, monkeypatch):
    from skill_agent_tools import SkillToolset
    def unavailable(*args):
        raise OSError('snapshot unavailable')
    monkeypatch.setattr(SkillToolset, 'capture_result', unavailable)
    async def script(tools, store, business):
        await tools['create_expense_report']()
    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    message = saved_message(store)
    assert message['runStatus'] == 'completed'
    assert message['cards'][0]['kind'] == 'report'
    assert store.get_state()['data']['analysisWorkspace']['reports']


async def load_output_skill(tools, store, tmp_path):
    from file_service import save_file
    file = save_file(store, tmp_path / 'files', 'SKILL.md', 'text/markdown',
                     b'---\nname: output\ndescription: Save output files\n---\nCreate requested files.')
    version = {'version': '1.0', 'status': 'published', 'mode': 'runnable',
               'business': 'pass', 'security': 'pass', 'technical': 'pass', 'compatibility': 'pass', 'file': file}
    store.mutate(lambda state: state['data'].update(skillsHub={'skills': [
        {'id': 'output', 'title': '文件生成', 'view': True, 'call': True, 'versions': [version]}]}))
    await tools['get_skill_instructions']('output')


@pytest.mark.parametrize('same_file,expected', [(False, 'failed'), (True, 'completed')])
def test_upload_file_read_failure_is_only_resolved_by_same_file(tmp_path, monkeypatch, same_file, expected):
    async def script(tools, store, business):
        await tools['read_uploaded_file']('missing')
        file_id = 'missing' if same_file else 'unrelated'
        store.add_file({'id': file_id, 'name': 'notes.txt', 'text': '业务资料', 'status': 'ready'}, 'unused.txt')
        await tools['read_uploaded_file'](file_id)
    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    assert saved_message(store)['runStatus'] == expected
    assert [entry['status'] for entry in saved_message(store)['tools']] == ['failed', 'completed']


@pytest.mark.parametrize('same_file,expected', [(False, 'failed'), (True, 'completed')])
def test_skill_read_failure_is_only_resolved_by_same_file(tmp_path, monkeypatch, same_file, expected):
    async def script(tools, store, business):
        await load_output_skill(tools, store, tmp_path)
        await tools['read_skill_file']('work/missing.txt')
        path = 'work/missing.txt' if same_file else 'work/unrelated.txt'
        await tools['write_skill_file'](path, '业务资料')
        await tools['read_skill_file'](path)
    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    assert saved_message(store)['runStatus'] == expected


@pytest.mark.parametrize('publish_second,expected', [(False, 'failed'), (True, 'completed')])
def test_two_requested_csv_files_need_two_published_artifacts(tmp_path, monkeypatch, publish_second, expected):
    async def script(tools, store, business):
        await load_output_skill(tools, store, tmp_path)
        await tools['write_skill_file']('output/first.csv', 'item,count\na,1\n')
        await tools['write_skill_file']('output/second.csv', 'item,count\nb,2\n')
        await tools['publish_skill_artifact']('output/first.csv')
        if publish_second:
            await tools['publish_skill_artifact']('output/second.csv')
    store, runtime = setup_run(tmp_path, monkeypatch, script, '请生成两个CSV文件')
    asyncio.run(runtime.execute('r'))
    message = saved_message(store)
    assert message['runStatus'] == expected
    assert len(message['cards']) == (2 if publish_second else 1)


@pytest.mark.parametrize('prompt,artifacts,complete', [
    ('生成Excel和PDF', [{'id': 'a', 'name': 'report.xlsx'}], False),
    ('生成Excel和PDF', [{'id': 'a', 'name': 'report.xlsx'}, {'id': 'b', 'name': 'report.pdf'}], True),
    ('生成两个CSV文件', [{'id': 'a', 'name': 'one.csv'}, {'id': 'a', 'name': 'one.csv'}], False),
    ('生成两个CSV文件', [{'id': 'a', 'name': 'one.csv'}, {'id': 'b', 'name': 'notes.txt'}], False),
    ('生成两个文件', [{'id': 'a', 'name': 'one.csv'}], False),
    ('生成两个文件', [{'id': 'a', 'name': 'one.csv'}, {'id': 'b', 'name': 'two.txt'}], True),
    ('生成一份PDF，使用Excel作为参考', [{'id': 'a', 'name': 'report.pdf'}], True),
    ('生成一份PDF', [{'id': 'a', 'name': 'report.pdf'}], True),
])
def test_explicit_artifact_count_and_formats_are_checked(prompt, artifacts, complete):
    from completion_check import CompletionCheck
    check = CompletionCheck({'message': prompt})
    check.observe('run_skill_script', 'script', {
        'status': 'success', 'exitCode': 0,
        'files': [{'path': 'work/chart.png'}, {'path': 'output/preview.png'}, {'path': 'tmp/helper.txt'}]}, 'completed')
    assert (check.issue(artifacts) is None) is complete


def test_intermediate_preview_image_does_not_create_a_delivery_requirement():
    from completion_check import CompletionCheck
    check = CompletionCheck({'message': '分析这份数据'})
    check.observe('run_skill_script', 'script', {'status': 'success', 'exitCode': 0, 'files': [
        {'path': 'work/chart.png'}, {'path': 'output/preview.png'}, {'path': 'tmp/data.txt'}]}, 'completed')
    assert check.issue([]) is None


def test_progress_uses_only_the_outbound_leg_for_itinerary_context(tmp_path, monkeypatch):
    async def script(tools, store, business):
        await tools['get_submission_draft']('travel')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    previous = runtime.business.get_draft

    def get_draft(draft_id):
        result = previous(draft_id)
        result['draft']['legs'] = [
            {'arrivalCity': '南京', 'transport': '高铁二等座', 'privateNote': 'private-itinerary-note'},
            {'arrivalCity': '杭州', 'isReturn': True},
        ]
        return result

    runtime.business.get_draft = get_draft
    asyncio.run(runtime.execute('r'))
    events = tool_events(store)
    assert events[-1]['itinerary'] == {'destination': '南京', 'transport': '高铁二等座'}
    assert 'private-itinerary-note' not in json.dumps(events)


def assert_run_window(store, event_kind, *, initial_event=True):
    saved = saved_message(store)
    run = store.run('r')
    start, end = saved['runStartedAt'], saved['runFinishedAt']
    events = store.events('r')
    terminal = next(e['data'] for e in reversed(events) if e['kind'] == event_kind)
    assert type(start) is int and type(end) is int and start <= end
    assert (start, end) == (run['runStartedAt'], run['runFinishedAt'])
    assert (start, end) == (terminal['runStartedAt'], terminal['runFinishedAt'])
    if initial_event:
        assert next(e['data'] for e in events if e['kind'] == 'status')['runStartedAt'] == start


def test_step_finding_reaches_stream_and_history_without_return_payload(tmp_path, monkeypatch):
    async def script(tools, store, business):
        assert saved_message(store)['runStartedAt'] == store.run('r')['runStartedAt']
        assert 'runFinishedAt' not in saved_message(store)
        business.search_knowledge = lambda q: {'items': [{'title': '/private/internal-path'}]}
        await tools['search_policies']('query not intended for progress')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    events = tool_events(store)
    assert 'finding' not in events[0]
    assert events[1]['finding'] == '检索到 1 份本地示例制度。'
    assert saved_message(store)['tools'][0]['finding'] == events[1]['finding']
    assert 'internal-path' not in json.dumps(events)
    assert_run_window(store, 'result')


@pytest.mark.parametrize(('name', 'result', 'expected'), [
    ('list_materials', {'files': [{}, {}]}, '已列出 2 份材料。'),
    ('query_documents', {'items': [], 'unavailableSources': ['internal-only']},
     '可用来源中查到 0 张单据，另有 1 个来源未返回。'),
    ('get_submission_draft', {'draft': {'type': 'travel', 'legs': [{}, {}]}},
     '差旅申请中已有 2 段行程。'),
    ('validate_submission', {'check': {'issues': [{}]}, 'canSubmit': False}, '草稿有 1 项字段需要核对。'),
    ('summarize_expense_csv', {'result': {'rowCount': 2, 'currency': 'CNY', 'total': '900.00'}},
     '2 条费用记录合计 900.00 元。'),
    ('read_current_rules', {'rules': []}, '当前规则清单中有 0 条规则。'),
    ('read_work_document', {'document': {'expenses': [{'id': '/private'}], 'files': ['secret.pdf']}},
     '这张单据有 1 条费用明细、1 份附件。'),
    ('analyze_expenses', {'items': [{}, {}], 'count': 2, 'totalMinor': '10019'},
     '本地合成样例中，2 条费用汇总记录合计 100.19 元。'),
    ('analyze_expenses', {'items': [{}], 'count': 2, 'totalMinor': '8'}, None),
    ('extract_expense_materials', {'groupCount': 1, 'unassignedCount': 2},
     '识别出 1 组费用，另有 2 份材料待归组。'),
    ('extract_expense_materials', {'files': [{'extractionStatus': 'unreadable'}], 'items': []},
     '1 份材料未能识别。'),
    ('extract_expense_materials', {'files': [{'extractionStatus': 'needs_review'}, {'extractionStatus': 'failed'}],
                                  'items': [{}]},
     '当前有 1 条费用记录，1 份材料未能识别，1 份材料待核对。'),
    ('validate_submission', {'check': {}, 'canSubmit': False}, None),
    ('summarize_expense_csv', {'result': {'rowCount': True, 'currency': 'CNY', 'total': '900.00'}}, None),
    ('summarize_expense_csv', {'result': {'rowCount': 2, 'currency': 'CNY', 'total': '/secret/path'}}, None),
    ('read_uploaded_file', {'text': 'private-reasoning', 'path': '/private'}, None),
])
def test_progress_facts_use_validated_business_values(name, result, expected):
    from progress_findings import tool_finding
    assert tool_finding(name, result) == expected
