import asyncio
import sys
from types import SimpleNamespace

import agent_runtime
import config
from business import Business
from store import Store


def run_public_financial_tools(tmp_path, monkeypatch, script, financials, refs=None):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setitem(sys.modules, 'financial_analytics', financials)
    store = Store(tmp_path / 'state.db')
    store.mutate(lambda state: state['tasks'].append({
        'id': 't', 'activeRunId': 'r',
        'messages': [{'id': 'u', 'role': 'user', 'text': '分析海康威视2025年度公开财报'}],
        'refs': refs or [],
    }))
    store.create_run('r', 't', {
        'message': '分析海康威视2025年度公开财报', 'capability': 'analysis', 'refs': refs or [],
    })
    available = set()
    returned = []

    class FakeAgent:
        def __init__(self, **kwargs):
            instructions = '\n'.join(kwargs['instructions'])
            assert '海康威视' in instructions and '人民币' in instructions
            assert '重述' in instructions and '归母' in instructions
            self.tools = {(getattr(tool, '__name__', None) or tool.name):
                          getattr(tool, 'entrypoint', tool) for tool in kwargs['tools']}
            available.update(self.tools)

        async def arun(self, *args, **kwargs):
            returned.append(await script(self.tools, store))
            yield SimpleNamespace(event='RunContent', content='已核对公开财报数据。')

    monkeypatch.setattr(agent_runtime, 'Agent', FakeAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    asyncio.run(agent_runtime.Runtime(store, Business(store)).execute('r'))
    return store, available, returned


def test_public_query_tool_preserves_metric_period_and_analysis_card(tmp_path, monkeypatch):
    def query_financials(year, metric):
        assert (year, metric) == (2024, 'netIncome')
        return {
            'year': 2024,
            'period': {'start': '2024-01-01', 'end': '2024-12-31', 'label': '2024年度'},
            'metrics': [{'id': 'netIncome', 'value': 13141022060.51, 'unit': 'CNY'}],
            'cards': [{'kind': 'analysis', 'id': 'public-finance-2024', 'title': '海康威视公开财报',
                       'data': {'publicFinance': True, 'year': 2024}}],
        }

    async def script(tools, store):
        return await tools['query_public_financials'](2024, 'netIncome')

    store, available, returned = run_public_financial_tools(
        tmp_path, monkeypatch, script, SimpleNamespace(query_financials=query_financials))
    assert 'query_public_financials' in available
    assert store.run('r')['status'] == 'completed'
    assert returned[0]['metrics'][0]['value'] == 13141022060.51
    assert returned[0]['metrics'][0]['unit'] == 'CNY'
    assert returned[0]['period']['end'] == '2024-12-31'
    message = store.get_state()['tasks'][-1]['messages'][-1]
    assert message['cards'][0]['data'] == {'publicFinance': True, 'year': 2024}
    assert message['tools'][0]['name'] == 'query_public_financials'
    assert message['tools'][0]['status'] == 'completed'


def test_public_report_tool_uses_store_and_default_fiscal_year(tmp_path, monkeypatch):
    def create_report(store, year):
        assert year == 2025
        assert store.run('r')['status'] == 'running'
        return {
            'report': {'id': 'public-report-a', 'title': '海康威视2025年度报告',
                       'snapshot': {'year': 2025, 'totals': {'revenue': 92507796069.94}}},
            'cards': [{'kind': 'report', 'id': 'public-report-a', 'title': '海康威视2025年度报告',
                       'data': {'publicFinance': True, 'year': 2025}}],
        }

    async def script(tools, store):
        return await tools['create_public_financial_report']()

    store, available, returned = run_public_financial_tools(
        tmp_path, monkeypatch, script, SimpleNamespace(create_report=create_report))
    assert 'create_public_financial_report' in available
    assert store.run('r')['status'] == 'completed'
    assert returned[0]['report']['snapshot']['totals']['revenue'] == 92507796069.94
    message = store.get_state()['tasks'][-1]['messages'][-1]
    assert message['cards'][0]['id'] == 'public-report-a'
    assert message['cards'][0]['data'] == {'publicFinance': True, 'year': 2025}


def test_public_report_creation_preserves_queried_dataset_constraints(tmp_path, monkeypatch):
    def create_report(store, year, **options):
        assert year == 2025
        assert options == {'dataset_id': 'cninfo-hikvision-2025', 'dataset_version': 'version-1'}
        return {'report': {'id': 'public-report-bound', 'snapshot': {'year': year}}, 'cards': []}

    async def script(tools, store):
        return await tools['create_public_financial_report'](
            2025, dataset_id='cninfo-hikvision-2025', dataset_version='version-1')

    store, _, returned = run_public_financial_tools(
        tmp_path, monkeypatch, script, SimpleNamespace(create_report=create_report))
    assert store.run('r')['status'] == 'completed'
    assert returned[0]['report']['id'] == 'public-report-bound'


def test_public_report_read_uses_saved_snapshot_and_returns_report_card(tmp_path, monkeypatch):
    def get_report(store, report_id):
        assert report_id == 'public-report-saved'
        assert store.run('r')['status'] == 'running'
        return {'id': report_id, 'title': '苹果公司2023财年报告', 'version': 1,
                'snapshot': {'year': 2023, 'totals': {'revenue': 383285000000}}}

    async def script(tools, store):
        return await tools['read_public_financial_report']('public-report-saved')

    refs = [{'kind': 'report', 'id': 'public-report-saved', 'title': '苹果公司2023财年报告'}]
    store, available, returned = run_public_financial_tools(
        tmp_path, monkeypatch, script, SimpleNamespace(get_report=get_report), refs)
    assert 'read_public_financial_report' in available
    assert store.run('r')['status'] == 'completed'
    assert returned[0]['report']['snapshot']['totals']['revenue'] == 383285000000
    message = store.get_state()['tasks'][-1]['messages'][-1]
    assert message['cards'][0]['data'] == {'publicFinance': True, 'year': 2023}
    assert message['cards'][0]['id'] == 'public-report-saved'


def test_public_query_error_keeps_failed_trace_and_no_synthetic_card(tmp_path, monkeypatch):
    def query_financials(year, metric):
        raise ValueError('仅支持海康威视2023、2024、2025年度。')

    async def script(tools, store):
        return await tools['query_public_financials'](2022)

    store, available, returned = run_public_financial_tools(
        tmp_path, monkeypatch, script, SimpleNamespace(query_financials=query_financials))
    assert 'query_public_financials' in available
    assert returned[0]['error'] == '仅支持海康威视2023、2024、2025年度。'
    assert store.run('r')['status'] == 'failed'
    message = store.get_state()['tasks'][-1]['messages'][-1]
    assert message.get('cards', []) == []
    assert message['tools'][0]['name'] == 'query_public_financials'
    assert message['tools'][0]['status'] == 'failed'
