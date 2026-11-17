import asyncio
from types import SimpleNamespace

from agent_runtime import Runtime
from business import Business
from file_service import save_file
from store import Store


def test_csv_tool_executes_and_persists_serializable_trace(tmp_path, monkeypatch):
    import agent_runtime
    import config
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    file = save_file(store, tmp_path / 'files', '费用.csv', 'text/csv', '费用类型,金额\n办公,80.50\n'.encode())

    class ExecutingAgent:
        def __init__(self, **kwargs):
            self.tool = next(tool for tool in kwargs['tools'] if tool.__name__ == 'summarize_expense_csv')

        async def arun(self, *args, **kwargs):
            result = await self.tool(file['id'])
            assert result['result']['totalMinor'] == '8050'
            yield SimpleNamespace(event='RunContent', content='费用合计80.50元，结果已保存。')

    monkeypatch.setattr(agent_runtime, 'Agent', ExecutingAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'activeRunId': 'r', 'messages': [{'role': 'user', 'text': '汇总附件'}]}))
    store.create_run('r', 't', {'message': '汇总附件', 'refs': []})
    asyncio.run(Runtime(store, Business(store)).execute('r'))
    assert store.run('r')['status'] == 'completed'
    events = store.events('r')
    assert any(event['kind'] == 'tool' and event['data']['status'] == 'completed' for event in events)
    card = next(event['data']['cards'][0] for event in events if event['kind'] == 'result')
    assert card['kind'] == 'tool'
    assert card['id'] in store.get_state()['data']['toolResults']


def test_material_listing_retains_explicit_reference_scope():
    from agent_runtime import material_listing
    materials = {'files': [{'id': 'a', 'text': 'private-a'}, {'id': 'b', 'text': 'private-b'}],
                 'items': [{'id': 'ia', 'sourceFileId': 'a'}, {'id': 'ib', 'sourceFileId': 'b'}]}
    listing = material_listing(materials, [{'kind': 'materials', 'id': 'batch-selection', 'fileIds': ['a']}])
    assert listing['files'] == [{'id': 'a'}]
    assert [item['id'] for item in listing['items']] == ['ia']
    assert listing['cards'][0]['data']['fileIds'] == ['a']
    missing = material_listing(materials, [{'kind': 'materials', 'id': 'unknown-selection'}])
    assert missing['files'] == [] and missing['items'] == []
