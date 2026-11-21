import asyncio
import json
from types import SimpleNamespace

import agent_runtime
import config
from business import Business
from fastapi.testclient import TestClient
from server import create_app
from store import Store


def test_source_window_returns_exact_document_without_mutation(tmp_path):
    store = Store(tmp_path / 'workspace.db')
    with TestClient(create_app(store)) as client:
        before = store.snapshot()
        record = before['state']['data']['auditDocuments'][0]
        response = client.get('/api/local/business/work-documents/' + record['id'])
        assert response.status_code == 200
        assert response.json()['document'] == record
        assert '模拟' in response.json()['dataSource']
        assert client.get('/api/local/business/work-documents/missing').status_code == 404
        assert store.snapshot()['revision'] == before['revision']


def test_work_document_questions_read_current_facts_and_leave_checks_untouched(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'workspace.db')
    business = Business(store)
    record = store.get_state()['data']['auditDocuments'][0]
    refs = [{'kind': 'audit', 'id': record['id'], 'title': record['title']}]
    store.mutate(lambda s: s['tasks'].append({
        'id': 'bound-task', 'refs': refs, 'messages': [], 'input': '', 'status': '待开始',
    }))
    snapshots = []

    class ReadOnlyAgent:
        def __init__(self, **kwargs):
            assert 'query_documents' in '\n'.join(kwargs['instructions'])

        async def arun(self, messages, **kwargs):
            facts = json.loads(messages[-1].content.split('\n', 1)[1])
            snapshots.append(facts)
            doc = facts['items'][0] if 'items' in facts else facts['document']
            yield SimpleNamespace(event='RunContent', content=doc['title'])

    monkeypatch.setattr(agent_runtime, 'Agent', ReadOnlyAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    original = store.get_state()['data']['rulesSubmission']['reviewResults']
    for turn, question in enumerate(['这张单的风险是什么？', '再核对一下这张单的风险', '现在由谁处理？']):
        run_id = f'run-{turn}'
        if turn:
            store.mutate(lambda s: s['data']['auditDocuments'][0].update(stage='财务复核', version=record['version'] + 1))
        def begin(s):
            task = s['tasks'][0]
            task['activeRunId'] = run_id
            task['messages'].append({'id': f'u-{turn}', 'role': 'user', 'text': question})
        store.create_run(run_id, 'bound-task', {'message': question, 'refs': refs}, initialize=begin)
        asyncio.run(agent_runtime.Runtime(store, business).execute(run_id))
        assert store.run(run_id)['status'] == 'completed'
        reply = store.get_state()['tasks'][0]['messages'][-1]
        expected_tool = 'query_documents' if turn == 2 else 'read_work_document'
        assert [(step['name'], step['status']) for step in reply['tools']] == [(expected_tool, 'completed')]
        if turn == 2:
            progress, = reply['cards']
            assert progress['kind'] == 'documents'
            assert progress['data']['items'][0]['workDocumentId'] == record['id']
            assert progress['data']['items'][0]['sourceStatus'] == '财务复核'
    assert snapshots[0]['document'] == record
    assert snapshots[1]['document']['id'] == record['id']
    assert snapshots[1]['document']['stage'] == '财务复核'
    assert snapshots[1]['review']['checked'] is False
    assert store.get_state()['data']['rulesSubmission']['reviewResults'] == original


def test_retries_keep_reference_until_user_removes_it(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'API_KEY', 'test-key')
    store = Store(tmp_path / 'workspace.db')
    app = create_app(store)
    runtime = app.state.runtime
    monkeypatch.setattr(runtime, 'launch', lambda run_id: None)
    record = store.get_state()['data']['auditDocuments'][0]
    refs = [{'kind': 'audit', 'id': record['id'], 'title': record['title']}]
    with TestClient(app) as client:
        for attempt, status in enumerate(['cancelled', 'failed', 'cancelled']):
            payload = {'taskId': 'bound', 'message': '重新核对这张单'}
            if attempt == 0:
                payload['refs'] = refs
            elif attempt == 2:
                payload['refs'] = []
            result = client.post('/api/local/runs', json=payload)
            assert result.status_code == 200
            run_id = result.json()['runId']
            expected = refs if attempt < 2 else []
            assert store.run(run_id)['request']['refs'] == expected
            runtime.fail(run_id, 'bound', '本次任务已停止。', status)
            task = store.get_state()['tasks'][0]
            assert task['input'] == '' and task['refs'] == expected
