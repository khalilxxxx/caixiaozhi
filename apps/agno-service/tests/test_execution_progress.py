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
    assert message['runStatus'] == 'interrupted'
    assert message['tools'][0]['status'] == 'cancelled'
    assert message['tools'][0]['finishedAt'] >= 1000
    assert message['cards'] == [card]
    assert tool_events(store)[-1]['id'] == 's'
    assert tool_events(store)[-1]['status'] == 'cancelled'


def test_ask_user_has_one_complete_step_and_waiting_run_status(tmp_path, monkeypatch):
    async def script(tools, store, business):
        await tools['ask_user']('哪一天出发？')

    store, runtime = setup_run(tmp_path, monkeypatch, script)
    asyncio.run(runtime.execute('r'))
    message = saved_message(store)
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
