import time

import pytest
from fastapi.testclient import TestClient

import config
from business_analytics import business_options, query_board
from server import create_app
from store import Store


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'API_KEY', '')
    db = tmp_path / 'workspace.db'
    with TestClient(create_app(Store(db))) as client:
        yield client, db


def ask(client, question, task='analysis-task', **options):
    response = client.post('/api/local/runs', json={'taskId': task, 'message': question, **options})
    assert response.status_code == 200, response.text
    run_id = response.json()['runId']
    for _ in range(200):
        run = client.get('/api/local/runs/' + run_id).json()
        if run['status'] != 'running':
            break
        time.sleep(0.02)
    assert run['status'] == 'completed', run
    state = client.get('/api/local/workspace').json()['state']
    current = next(item for item in state['tasks'] if item['id'] == task)
    return current['messages'][-1]


def test_direct_question_ranking_and_persisted_multiturn_report(service):
    client, db = service
    message = ask(client, '我想看一下我九月份部门的一个费用使用情况跟部门差旅情况')
    assert [card['data']['snapshot']['scope']['system'] for card in message['cards']] == ['expense', 'travel']
    september = message['cards'][0]['data']['snapshot']
    assert september == query_board('expense', '2026-09-01', '2026-09-30', ['finance'])
    ranking = ask(client, '那我部门里面谁出差费最多？')
    assert ranking['cards'][0]['data']['focus'] == 'ranking'
    leader = september['ranking'][0]
    assert leader['name'] in ranking['text'] and f"{leader['amount']:,.2f}" in ranking['text']
    card = ask(client, '请根据本次会话的数据分析结果生成可视化报告。')['cards'][0]
    assert card['kind'] == 'report'
    report = card['data']['report']
    assert [item['focus'] for item in report['sections']] == ['overview', 'overview', 'ranking']
    assert report['sections'][0]['snapshot'] == september
    assert report['sections'][-1]['question'] == '那我部门里面谁出差费最多？'
    with TestClient(create_app(Store(db))) as reopened:
        assert reopened.get('/api/local/analytics/business/reports/' + report['id']).json() == {'report': report}


def test_bound_scope_switches_and_history_isolates_conversations(service):
    client, _ = service
    source = {'kind': 'business-board', 'id': 'expense', 'title': '费用报销看板',
              'scope': dict(system='expense', startDate='2026-09-04', endDate='2026-09-15', departmentIds=['sales'])}
    first = ask(client, '查看费用趋势', refs=[source])['cards'][0]['data']
    assert first['snapshot']['scope'] == source['scope']
    second = ask(client, '换成十月，只看研发部', refs=[source])['cards'][0]['data']['snapshot']
    assert second['scope'] == dict(system='expense', startDate='2026-10-01', endDate='2026-10-31', departmentIds=['research'])
    third = ask(client, '谁的差旅费最高？', refs=[source])['cards'][0]['data']['snapshot']
    assert third['scope'] == {**second['scope'], 'system': 'travel'}
    other = ask(client, '我部门九月报销情况', task='another-task')['cards'][0]['data']['snapshot']
    assert other['scope']['departmentIds'] == ['finance']
    view = ask(client, '生成报告', task='another-task')['cards'][0]['data']['report']
    assert len(view['sections']) == 1 and view['sections'][0]['snapshot'] == other


def test_unsupported_questions_do_not_get_a_guessed_board(service):
    client, _ = service
    scope = business_options()['defaultScope']
    ref = {'kind': 'business-board', 'id': 'expense', 'title': '费用报销', 'scope': scope}
    for question in ['为什么九月费用变高？', '对比九月和十月的费用趋势', '九月上海差旅情况', '帮我填差旅报销单', '我部门谁出差次数最多', '谁的报销费用最高']:
        res = client.post('/api/local/runs', json={'taskId': 'bound', 'message': question, 'refs': [ref]})
        assert res.status_code == 503, (question, res.json())
    for question in ['只看运营部', '分析运营部报销情况']:
        response = client.post('/api/local/runs', json={'taskId': 'bound', 'message': question, 'refs': [ref]})
        assert response.status_code == 403
    denied = client.post('/api/local/runs', json={'taskId': 'denied', 'message': '查看费用趋势',
                         'refs': [{**ref, 'scope': {**scope, 'departmentIds': ['operations']}}]})
    assert denied.status_code == 403


@pytest.mark.parametrize('question,focus,systems', [
    ('看看这段时间的部门费用和差旅情况', 'overview', ['expense', 'travel']),
    ('费用主要花在哪里？', 'breakdown', ['expense']),
    ('看看这段时间的差旅情况', 'overview', ['travel']),
    ('谁的差旅费最高？', 'ranking', ['travel']),
    ('查看费用趋势', 'trend', ['expense']),
    ('九月份我们部门的费用和差旅情况怎么样？', 'overview', ['expense', 'travel']),
])
def test_board_suggestions_run_without_model(service, question, focus, systems):
    client, _ = service
    ref = {'kind': 'business-board', 'id': 'expense', 'title': '费用报销', 'scope': business_options()['defaultScope']}
    cards = ask(client, question, refs=[ref])['cards']
    assert [card['data']['focus'] for card in cards] == [focus] * len(systems)
    assert [card['data']['snapshot']['scope']['system'] for card in cards] == systems


@pytest.mark.parametrize('question,focus', [
    ('看看研发部九月份的费用结构', 'breakdown'),
    ('九月份财务部的出差目的地有哪些？', 'travel'),
    ('本月我们部门谁的差旅费最高？', 'ranking'),
])
def test_direct_capability_examples(service, question, focus):
    client, _ = service
    message = ask(client, question, capability='analysis')
    assert message['cards'][0]['data']['focus'] == focus


def test_report_explicit_period_and_coverage(service):
    client, _ = service
    ask(client, '九月部门费用使用情况')
    card = ask(client, '请生成十月销售部费用分析报告')['cards'][-1]
    assert [s['snapshot']['scope']['startDate'] for s in card['data']['report']['sections']] == ['2026-10-01']
    outside = ask(client, '换成2024年九月')
    assert '超出台账覆盖期' in outside['text']
    assert outside['cards'][0]['data']['snapshot']['coverageStatus'] == 'outside'
    assert client.get('/api/local/analytics/business/reports/not-found').status_code == 404


def test_cost_rank_and_unavailable_spend_breakdown(service):
    client, _ = service
    scope = business_options()['defaultScope']
    ref = {'kind': 'business-board', 'id': 'expense', 'title': '费用报销', 'scope': scope}
    message = ask(client, '九月财务部差旅费用最多的路线', refs=[ref])
    data = message['cards'][0]['data']
    first = max(data['snapshot']['routes'], key=lambda row: row['amount'])
    assert data['focus'] == 'routeSpend'
    assert first['name'] in message['text'] and f"{first['amount']:,.2f}" in message['text']
    unavailable = ask(client, '差旅费用构成')
    assert '无法按费用类型拆分' in unavailable['text'] and unavailable['cards'] == []


def test_mixed_conversation_report_uses_query_snapshots_and_keeps_sources_isolated(service, monkeypatch):
    from types import SimpleNamespace
    import agent_runtime

    client, _ = service
    ask(client, '我部门九月费用使用情况')
    ask(client, '谁的差旅费最高？')
    upload = client.post('/api/local/files', files={'file': ('部门.csv', '类别,金额\n办公,80.50\n差旅,510.60\n'.encode(), 'text/csv')}).json()['file']
    ref = {'kind': 'file', 'id': upload['id'], 'title': upload['name']}

    class AnalysisAgent:
        def __init__(self, **kwargs):
            self.tools = {getattr(t, '__name__', None) or t.name: getattr(t, 'entrypoint', t) for t in kwargs['tools']}

        async def arun(self, messages, **kwargs):
            last_user = next(m.content for m in reversed(messages) if m.role == 'user')
            if '海康' in last_user:
                result = await self.tools['query_public_financials'](2025, 'revenue')
                assert result['year'] == 2025
            else:
                result = await self.tools['summarize_expense_csv'](upload['id'])
                assert result['result']['totalMinor'] == '59110'
            yield SimpleNamespace(event='RunContent', content='已完成查询。')

    monkeypatch.setattr(config, 'API_KEY', 'test-configured')
    monkeypatch.setattr(agent_runtime, 'Agent', AnalysisAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    ask(client, '海康公开财报营收如何？')
    ask(client, '请汇总上传的CSV', refs=[ref])
    monkeypatch.setattr(config, 'API_KEY', '')
    mixed = ask(client, '根据本次会话的费用分析生成报告', refs=[ref])['cards'][0]['data']['report']
    sections = mixed['sections']
    assert [s.get('kind', 'businessBoard') for s in sections] == ['businessBoard', 'businessBoard', 'publicFinance', 'expenseCsv']
    assert sections[1]['focus'] == 'ranking'
    assert sections[2]['snapshot']['metrics'][0]['value'] == pytest.approx(925.0779606994)
    assert sections[2]['snapshot']['scopeLabel'].startswith('2025')
    csv = sections[3]['snapshot']
    assert csv['metrics'][0]['value'] == 591.10
    assert csv['breakdown'] == [{'name': '办公', 'value': 80.5}, {'name': '差旅', 'value': 510.6}]
    assert client.get('/api/local/analytics/business/reports/' + mixed['id']).json()['report'] == mixed
    ask(client, '九月部门费用情况', task='another')
    independent = ask(client, '生成报告', task='another')['cards'][0]['data']['report']
    assert len(independent['sections']) == 1 and independent['sections'][0]['focus'] == 'overview'
