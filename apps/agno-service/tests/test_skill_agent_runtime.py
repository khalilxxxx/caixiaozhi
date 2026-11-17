import asyncio
import pytest
from types import SimpleNamespace
from file_service import save_file
from store import Store
from business import Business


@pytest.mark.parametrize('ending,script_status', [('completed', 'success'), ('failed', 'success'), ('cancelled', 'success'), ('completed', 'resource_limit')])
def test_uploaded_text_skill_can_create_execute_and_publish_real_file(tmp_path, monkeypatch, ending, script_status):
    import config
    import agent_runtime
    from skill_executor import LocalSkillExecutor
    if not LocalSkillExecutor().environment()['available']:
        pytest.skip('此平台没有可用的本机隔离执行器')
    if script_status != 'success':
        original_execute = LocalSkillExecutor.execute
        async def limited_execute(self, *args, **kwargs):
            result = await original_execute(self, *args, **kwargs)
            result['status'] = script_status
            return result
        monkeypatch.setattr(LocalSkillExecutor, 'execute', limited_execute)
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    file = save_file(store, tmp_path / 'files', 'SKILL.md', 'text/markdown', b'---\nname: hello\ndescription: Write a result\n---\nCreate a text file with Python.')
    version = {'version': '1.0', 'status': 'published', 'mode': 'runnable', 'business': 'pass', 'security': 'pass', 'technical': 'pass', 'compatibility': 'pass', 'file': file}
    def setup(state):
        state['data']['skillsHub'] = {'skills': [{'id': 'hello', 'title': 'Hello', 'view': True, 'call': True, 'versions': [version]}]}
        state['tasks'].append({'id': 't', 'activeRunId': 'r', 'messages': [{'id': 'u', 'role': 'user', 'text': '生成文件'}]})
    store.mutate(setup)
    store.create_run('r', 't', {'message': '生成文件', 'refs': [{'kind': 'skill', 'id': 'hello', 'version': '1.0'}]})
    class ScriptedModelAgent:
        def __init__(self, **kwargs):
            self.tools = {(getattr(tool, '__name__', None) or tool.name): getattr(tool, 'entrypoint', tool) for tool in kwargs['tools']}
        async def arun(self, *args, **kwargs):
            await self.tools['write_skill_file']('work/create.py', "from pathlib import Path\nPath('output/result.txt').write_text('真实生成')\n")
            executed = await self.tools['run_skill_script']('work/create.py')
            assert executed['exitCode'] == 0, executed
            result = await self.tools['publish_skill_artifact']('output/result.txt')
            assert result['artifact']['name'] == 'result.txt'
            if ending == 'failed':
                yield SimpleNamespace(event='RunError', content='模型连接中断')
                return
            if ending == 'cancelled':
                raise asyncio.CancelledError()
            yield SimpleNamespace(event='RunContent', content='文件已生成。')
    monkeypatch.setattr(agent_runtime, 'Agent', ScriptedModelAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    errors = []
    import traceback
    monkeypatch.setattr(agent_runtime.logger, 'warning', lambda *a, **k: errors.append(traceback.format_exc()))
    asyncio.run(agent_runtime.Runtime(store, Business(store)).execute('r'))
    assert store.run('r')['status'] == ending, errors
    message = store.get_state()['tasks'][-1]['messages'][-1]
    assert message['cards'][0]['kind'] == 'artifact'
    expected = 'completed' if script_status == 'success' else 'failed'
    assert any(event['kind'] == 'tool' and event['data']['name'] == 'run_skill_script' and event['data']['status'] == expected for event in store.events('r'))
