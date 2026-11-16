import asyncio
from types import SimpleNamespace
from store import Store
from business import Business
from agent_runtime import Runtime


def running(tmp_path):
    store=Store(tmp_path/'run.db')
    store.mutate(lambda s:s['tasks'].append({'id':'t','activeRunId':'r','messages':[{'id':'u','role':'user','text':'查询费用'}]}))
    store.create_run('r','t',{'message':'查询费用','refs':[]})
    return store,Runtime(store,Business(store))


def test_cancel_before_coroutine_starts_is_terminal(tmp_path):
    store,runtime=running(tmp_path)
    async def execute():
        runtime.launch('r')
        await runtime.cancel('r')
    asyncio.run(execute())
    assert store.run('r')['status']=='cancelled'
    assert store.get_state()['tasks'][0]['activeRunId'] is None
    assert [e['kind'] for e in store.events('r')][-1]=='done'
    assert 'r' not in runtime.cancelled


def test_error_and_in_progress_cancellation_are_persisted(tmp_path,monkeypatch):
    import agent_runtime
    class FakeAgent:
        def __init__(self,**kwargs): pass
        async def arun(self,*args,**kwargs):
            yield SimpleNamespace(event='RunContent',content='开始')
            await asyncio.sleep(30)
    monkeypatch.setattr(agent_runtime,'Agent',FakeAgent)
    monkeypatch.setattr(agent_runtime,'model',lambda:object())
    store,runtime=running(tmp_path)
    async def execute():
        runtime.launch('r')
        await asyncio.sleep(.02)
        await runtime.cancel('r')
        await runtime.cancel('r')
    asyncio.run(execute())
    assert store.run('r')['status']=='cancelled'
    assert len([e for e in store.events('r') if e['kind']=='done'])==1
    assert len(store.get_state()['tasks'][0]['messages'])==2
