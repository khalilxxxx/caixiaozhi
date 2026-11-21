import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import agent_runtime
import config
from file_service import save_file
from server import create_app
from store import Store


REVIEW = 'finance-review-team'
ANALYSIS = 'finance-analysis-team'
CATALOG = '/api/local/expert-teams'


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'API_KEY', 'unit-test')
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    app = create_app(store)
    runtime = app.state.runtime
    monkeypatch.setattr(runtime, 'launch', lambda _: None)
    return store, runtime, TestClient(app)


def custom(**overrides):
    return dict({'name': '制度核对小组', 'description': '核对报销制度', 'baseTeamId': REVIEW,
                 'skillIds': ['review-policy'], 'connectorIds': ['policy-library']}, **overrides)


def execute(service, monkeypatch, capability, script, refs=None, message='请核对现有资料', **options):
    store, runtime, client = service
    results, tool_names, instructions = [], set(), []
    class Provider:
        def __init__(self, **kwargs):
            self.tools = {(getattr(tool, '__name__', None) or tool.name): getattr(tool, 'entrypoint', tool)
                          for tool in kwargs['tools']}
            tool_names.update(self.tools)
            instructions.extend(kwargs['instructions'])

        async def arun(self, *args, **kwargs):
            results.append(await script(self.tools))
            yield SimpleNamespace(event='RunContent', content='已按可用数据核对。')

    monkeypatch.setattr(agent_runtime, 'Agent', Provider)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    run = client.post('/api/local/runs', json={
        'taskId': 't', 'capability': capability, 'message': message, 'refs': refs or [], **options,
    })
    assert run.status_code == 200, run.text
    rid = run.json()['runId']
    asyncio.run(runtime.execute(rid))
    message = store.get_state()['tasks'][0]['messages'][-1]
    return store.run(rid), message, results, tool_names, instructions


def test_catalog_and_private_team_survive_reload_without_workspace_override(service):
    store, _, client = service
    response = client.get(CATALOG)
    assert response.status_code == 200
    review, analysis = response.json()['teams']
    assert [review['id'], analysis['id']] == [REVIEW, ANALYSIS]
    assert next(c for c in review['connectors'] if c['id'] == 'qichacha')['status'] == 'unavailable'
    response = client.post(CATALOG, json=custom())
    assert response.status_code == 201, response.text
    team = response.json()['team']
    assert team['id'].startswith('expert-team-') and team['baseTeamId'] == REVIEW
    assert [s['id'] for s in team['skills']] == ['review-policy']
    assert [c['id'] for c in team['connectors']] == ['policy-library']
    assert all('供应商' not in item for item in team['examples'])
    client.patch('/api/local/workspace', json={'baseRevision': store.snapshot()['revision'],
                 'data': {'expertTeams': [{**team, 'skills': analysis['skills']}]}})
    reloaded = TestClient(create_app(Store(store.path))).get(CATALOG).json()['teams']
    assert reloaded[-1] == team
    assert client.post(CATALOG, json=custom()).status_code == 409


@pytest.mark.parametrize('change', [
    {'name': ' '}, {'description': ''}, {'baseTeamId': 'unknown'}, {'skillIds': []},
    {'skillIds': ['run_skill_script']}, {'skillIds': ['analyze-csv'], 'connectorIds': ['expense-csv']},
    {'connectorIds': []}, {'connectorIds': ['policy-library', 'business-documents']},
    {'skillIds': ['review-supplier'], 'connectorIds': ['qichacha']},
    {'tools': ['prepare_personal_rule']},
])
def test_creation_rejects_invalid_or_wider_permissions(service, change):
    _, _, client = service
    assert client.post(CATALOG, json=custom(**change)).status_code == 422


def test_unknown_team_never_falls_back_to_unrestricted_agent(service):
    store, _, client = service
    result = client.post('/api/local/runs', json={'taskId': 't', 'message': '查单据', 'capability': 'expert-team-missing'})
    assert result.status_code == 404
    assert not store.get_state()['tasks']


def test_private_policy_only_team_executes_only_chosen_read_even_with_cross_team_refs(service, monkeypatch):
    store, _, client = service
    made = client.post(CATALOG, json=custom())
    assert made.status_code == 201
    team = made.json()['team']
    document = store.get_state()['data']['auditDocuments'][0]
    refs = [{'kind': 'skill', 'id': 'missing-skill'}, {'kind': 'audit', 'id': document['id']}]
    async def script(tools):
        return await tools['search_policies']('差旅')

    run, answer, results, tools, instructions = execute(
        service, monkeypatch, team['id'], script, refs, '生成PDF，并告诉我差旅标准')
    assert (run['status'], answer['capability'], answer['expertTeamName']) == ('completed', team['id'], team['name'])
    assert tools == {'search_policies', 'ask_user'}
    assert [(s['name'], s['status']) for s in answer['tools']] == [('search_policies', 'completed')]
    assert results[0]['dataSource'] == '本地合成制度' and answer['cards']
    assert not any('missing-skill' in i for i in instructions)


def test_review_refs_limit_material_and_document_access(service, monkeypatch, tmp_path):
    store, _, _ = service
    chosen = save_file(store, tmp_path / 'files', '甲.txt', 'text/plain', b'A')
    private = save_file(store, tmp_path / 'files', '乙.txt', 'text/plain', b'B')
    async def script(tools):
        return [await tools['list_materials'](), await tools['read_uploaded_file'](chosen['id']),
                await tools['read_uploaded_file'](private['id']), await tools['list_materials']([private['id']]),
                await tools['read_work_document']('not-bound')]
    run, answer, results, tools, _ = execute(service, monkeypatch, REVIEW, script, [{'kind': 'file', 'id': chosen['id']}])
    assert tools == {'list_materials', 'read_uploaded_file', 'query_documents', 'read_work_document', 'search_policies', 'ask_user'}
    listing, content, *rejected = results[0]
    assert [f['id'] for f in listing['files']] == [chosen['id']]
    assert content['text'] == 'A' and all('error' in r for r in rejected)
    assert run['status'] == 'failed' and answer['capability'] == REVIEW
    assert all(step['status'] == 'failed' for step in answer['tools'][-3:])


def test_analysis_reads_referenced_csv_and_financials_without_writing_reports_or_results(service, monkeypatch, tmp_path):
    store, _, _ = service
    chosen = save_file(store, tmp_path / 'files', '费用.csv', 'text/csv', '费用类型,金额\n办公,12.55\n'.encode())
    old = store.get_state()['data']
    async def script(tools):
        return [await tools['summarize_expense_csv'](chosen['id']), await tools['query_public_financials'](2024, 'revenue')]
    run, answer, results, tools, _ = execute(service, monkeypatch, ANALYSIS, script, [{'kind': 'file', 'id': chosen['id']}])
    assert tools == {'analyze_expenses', 'summarize_expense_csv', 'read_expense_summary',
                     'query_public_financials', 'read_public_financial_report', 'ask_user'}
    assert run['status'] == 'completed' and answer['capability'] == ANALYSIS
    csv, report = results[0]
    assert csv['result']['total'] == '12.55' and csv['result']['fileId'] == chosen['id']
    assert report['year'] == 2024 and report['metrics'][0]['sources']
    assert old == store.get_state()['data']


def test_team_question_remembers_team_and_reference_while_resuming(service, monkeypatch):
    store, _, client = service
    async def script(tools):
        return await tools['ask_user']('希望核对哪项制度？')
    _, answer, _, _, _ = execute(service, monkeypatch, REVIEW, script)
    assert answer['runStatus'] == 'awaiting_input' and answer['capability'] == REVIEW
    result = client.post('/api/local/runs', json={'taskId': 't', 'message': '', 'capability': ANALYSIS,
                         'questionAnswer': {'questionId': answer['question']['id'], 'text': '差旅住宿'}})
    assert store.run(result.json()['runId'])['request']['capability'] == REVIEW


def test_team_question_cannot_be_resumed_with_wider_tools_by_editing_composer(service, monkeypatch):
    store, _, client = service
    async def script(tools):
        return await tools['ask_user']('核对哪项费用？')
    _, answer, *rest = execute(service, monkeypatch, ANALYSIS, script)
    change = client.patch('/api/local/workspace', json={'baseRevision': store.snapshot()['revision'],
                          'tasks': [{'id': 't', 'capability': None}]})
    assert change.status_code == 200
    run = client.post('/api/local/runs', json={'taskId': 't', 'message': '', 'capability': None,
                      'questionAnswer': {'questionId': answer['question']['id'], 'text': '差旅费'}})
    assert store.run(run.json()['runId'])['request']['capability'] == ANALYSIS


def test_unavailable_document_source_cannot_be_read_through_bound_work_reference(service, monkeypatch):
    store, _, _ = service
    doc = store.get_state()['data']['auditDocuments'][0]
    store.mutate(lambda s: s['data']['documentSources']['states'].update({doc['system']: 'offline'}))
    async def script(tools):
        return await tools['read_work_document'](doc['id'])
    run, answer, results, *_ = execute(service, monkeypatch, REVIEW, script, [{'kind': 'audit', 'id': doc['id']}])
    assert run['status'] == 'failed'
    assert results[0]['code'] == 'SOURCE_UNAVAILABLE' and 'document' not in results[0]
    assert answer['tools'][0]['expertConnector'] == '业务单据'


def test_unavailable_team_error_precedes_missing_model(service, monkeypatch):
    _, _, client = service
    monkeypatch.setattr(config, 'API_KEY', '')
    response = client.post('/api/local/runs', json={'taskId': 't', 'capability': 'expert-team-gone', 'message': '继续'})
    assert response.status_code == 404


def test_team_reads_referenced_expense_result_or_report_only(service, monkeypatch):
    store, _, _ = service
    async def script(tools):
        return [await tools['read_expense_summary']('unbound'), await tools['read_public_financial_report']('unbound')]
    _, _, results, *_ = execute(service, monkeypatch, ANALYSIS, script)
    assert [item['code'] for item in results[0]] == ['UNBOUND_REFERENCE', 'UNBOUND_REFERENCE']


def test_readonly_csv_returns_only_selected_rows_and_records_skill_source(service, monkeypatch, tmp_path):
    store, _, _ = service
    file = save_file(store, tmp_path / 'files', '参考.csv', 'text/csv', '费用类型,金额\n差旅,888\n'.encode())
    async def script(tools):
        return await tools['summarize_expense_csv'](file['id'])
    run, answer, results, *_ = execute(service, monkeypatch, ANALYSIS, script)
    assert run['status'] == 'failed' and results[0]['code'] == 'UNBOUND_FILE'
    assert 'cards' not in results[0]
    assert answer['tools'][0]['expertSkill'] == 'CSV 费用汇总'


def test_invalid_creation_explains_field_in_chinese(service):
    _, _, client = service
    response = client.post(CATALOG, json=custom(name=' '))
    assert response.status_code == 422 and '名称' in response.json().get('message', '')


def test_team_draft_and_identity_survive_cancel_and_restart(service):
    store, runtime, client = service
    store.mutate(lambda s: s['tasks'].append({'id': 't', 'messages': [], 'input': '另一个未发问题'}))
    for finish in ('cancel', 'restart'):
        response = client.post('/api/local/runs', json={'taskId': 't', 'capability': REVIEW,
                               'message': '核对引用单据', 'preserveComposerDraft': True})
        rid = response.json()['runId']
        if finish == 'cancel':
            asyncio.run(runtime.cancel(rid))
        else:
            store.recover()
        task = store.get_state()['tasks'][0]
        assert task['input'] == '另一个未发问题'
        answer = next(m for m in task['messages'] if m['id'] == 'assistant-' + rid)
        assert answer['capability'] == REVIEW and answer['expertTeamName'] == '财务核验专家团'
        assert answer['runStatus'] in ('cancelled', 'interrupted')


def test_resending_keeps_saved_composer_while_run_uses_original_team_and_refs(service):
    store, _, client = service
    composer = {'input': '草稿中的新问题', 'refs': [], 'capability': ANALYSIS, 'expertTeamName': '财务分析专家团'}
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'messages': [], **composer}))
    refs = [{'kind': 'file', 'id': 'original-file', 'title': '原材料.csv'}]
    response = client.post('/api/local/runs', json={'taskId': 't', 'message': '再次核对材料', 'refs': refs,
                                                    'capability': REVIEW, 'useSavedComposer': True})
    assert response.status_code == 200
    body = response.json()
    request = store.run(body['runId'])['request']
    assert request['refs'] == refs and request['capability'] == REVIEW
    task = body['workspace']['state']['tasks'][0]
    assert {key: task[key] for key in composer} == composer
    assert (task['messages'][-1]['capability'], task['messages'][-1]['expertTeamName']) == (REVIEW, '财务核验专家团')


def test_resending_plain_chat_does_not_inherit_new_team_or_refs(service):
    store, _, client = service
    refs = [{'kind': 'file', 'id': 'later'}]
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'messages': [], 'capability': ANALYSIS, 'refs': refs}))
    response = client.post('/api/local/runs', json={'taskId': 't', 'message': '这是一条普通问候', 'useSavedComposer': True})
    assert response.status_code == 200
    request = store.run(response.json()['runId'])['request']
    assert request['capability'] is None and request['refs'] == []
    task = store.get_state()['tasks'][0]
    assert task['capability'] == ANALYSIS and task['refs'] == refs


def test_resending_submission_uses_original_draft_through_completion(service, monkeypatch):
    store, runtime, _ = service
    original = runtime.business.new_draft('travel')['draft']
    newer = runtime.business.new_draft('personal')['draft']
    ref = lambda draft: {'kind': 'submission', 'id': draft['id'], 'title': draft['title']}
    refs = [ref(original), {'kind': 'report', 'id': 'public-report-original'}]
    composer = {'input': '下一条草稿', 'refs': [ref(newer), {'kind': 'report', 'id': 'public-report-next'}],
                'capability': ANALYSIS, 'expertTeamName': '财务分析专家团'}
    history = [{'id': 'previous', 'role': 'assistant', 'text': '已保存草稿。', 'cards': [ref(original), ref(newer)]}]
    store.mutate(lambda state: state['tasks'].append({'id': 't', 'messages': history, **composer}))
    async def text_only(tools):
        pass
    run, message, _, _, instructions = execute(service, monkeypatch, 'submission', text_only, refs,
                                                '继续核对原来的草稿', useSavedComposer=True)
    assert run['status'] == 'completed'
    assert [card['id'] for card in message['cards']] == [original['id']]
    assert not any('public-report-next' in line or newer['id'] in line for line in instructions)
    task = store.get_state()['tasks'][0]
    assert {key: task[key] for key in composer} == composer


@pytest.mark.parametrize(('before', 'after', 'want'), [
    ('我先查制度。', '## 住宿标准', '我先查制度。\n\n## 住宿标准'),
    ('我先查制度。\n', '\n## 住宿标准', '我先查制度。\n\n## 住宿标准'),
])
def test_streamed_answer_separates_text_on_either_side_of_a_tool(service, monkeypatch, before, after, want):
    store, runtime, client = service
    class Provider:
        def __init__(self, **kwargs):
            self.search = next(fn for fn in kwargs['tools'] if getattr(fn, '__name__', None) == 'search_policies')
        async def arun(self, *args, **kwargs):
            yield SimpleNamespace(event='RunContent', content=before)
            await self.search('差旅')
            yield SimpleNamespace(event='RunContent', content=after)
    monkeypatch.setattr(agent_runtime, 'Agent', Provider)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    response = client.post('/api/local/runs', json={'taskId': 't', 'capability': REVIEW, 'message': '查住宿标准'})
    rid = response.json()['runId']
    asyncio.run(runtime.execute(rid))
    assert store.get_state()['tasks'][0]['messages'][-1]['text'] == want
    assert ''.join(event['data']['text'] for event in store.events(rid) if event['kind'] == 'delta') == want
