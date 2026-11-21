import copy
import gzip
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from store import Store


EXPECTED = {
    2023: (89341177610.40, 49732768547.57, 11392948404.47, 13517569279.46, 16039575528.98, 15155901763.21, 14107726276.26, 16622209721.05),
    2024: (92495525118.30, 51953857912.21, 11864013392.27, 15147157746.54, 14312246696.51, 13141022060.51, 11977327023.54, 13264092022.73),
    2025: (92507796069.94, 50067436550.36, 11752624736.80, 15342400929.72, 16963083174.72, 15433655239.83, 14195371894.42, 25339411083.10),
}
METRICS = ('revenue', 'costOfRevenue', 'researchAndDevelopment', 'sellingGeneralAndAdministrative', 'operatingIncome', 'netIncome', 'attributableNetIncome', 'operatingCashFlow')


@pytest.mark.parametrize('year', [2023, 2024, 2025])
def test_official_annual_values_periods_and_reconciliation(year):
    from financial_analytics import query_financials
    result = query_financials(year)
    assert tuple(result['totals'][key] for key in METRICS) == EXPECTED[year]
    assert tuple(metric['value'] for metric in result['metrics']) == EXPECTED[year]
    totals = result['totals']
    assert totals['operatingExpenses'] == pytest.approx(EXPECTED[year][2] + EXPECTED[year][3])
    assert totals['totalCosts'] == pytest.approx(sum(EXPECTED[year][1:4]))
    assert totals['grossProfit'] == pytest.approx(EXPECTED[year][0] - EXPECTED[year][1])
    assert totals['revenue'] - totals['totalCosts'] + totals['otherOperatingNet'] == pytest.approx(totals['operatingIncome'])
    assert totals['financialExpenses'] < 0
    assert totals['sellingExpenses'] + totals['administrativeExpenses'] == pytest.approx(totals['sellingGeneralAndAdministrative'])
    assert totals['profitBeforeTax'] - totals['incomeTaxExpense'] == pytest.approx(totals['netIncome'])
    assert totals['netIncome'] == pytest.approx(totals['attributableNetIncome'] + totals['minorityInterest'])
    assert totals['operatingMargin'] == pytest.approx(EXPECTED[year][4] / EXPECTED[year][0] * 100)
    assert totals['netMargin'] == pytest.approx(EXPECTED[year][5] / EXPECTED[year][0] * 100)
    assert result['dataset']['currency'] == 'CNY'
    assert result['dataset']['displayUnit'] == '亿元'
    assert result['dataset']['shortName'] == '海康威视'
    assert result['dataset']['label'] == '海康威视 2023—2025年度合并财报'
    assert result['period']['label'] == (f'{year} 年度（已重述）' if year == 2023 else f'{year} 年度')
    assert result['dataset']['source']['accession'] == '1225123062'
    assert result['dataset']['source']['filedAt'] == '2026-04-18'
    assert result['dataset']['source']['url'] == 'https://static.cninfo.com.cn/finalpage/2026-04-18/1225123062.PDF'
    assert result['metrics'][1]['unit'] == 'CNY'
    assert result['metrics'][5]['label'] == '合并净利润'
    assert [(r['year'], r['periodStart'], r['periodEnd']) for r in result['trend']] == [
        (2023, '2023-01-01', '2023-12-31'), (2024, '2024-01-01', '2024-12-31'), (2025, '2025-01-01', '2025-12-31'),
    ]
    card = result['cards'][0]['data']
    assert card['publicFinance'] is True and card['year'] == year
    assert card['datasetId'] == 'cninfo-hikvision-2025'
    assert card['datasetVersion'] == result['dataset']['version']
    assert card['snapshot'] == {key: value for key, value in result.items() if key != 'cards'}


def test_comparison_has_no_invented_base_and_metric_filter_preserves_totals():
    from financial_analytics import query_financials
    first = query_financials(2023)
    assert all(m['previousValue'] is None and m['yoy'] is None for m in first['metrics'])
    latest = query_financials(2025, 'revenue')
    assert len(latest['metrics']) == 1
    assert latest['metrics'][0]['previousValue'] == 92495525118.30
    assert latest['metrics'][0]['valueMinor'] == '9250779606994'
    assert latest['metrics'][0]['previousValueMinor'] == '9249552511830'
    assert latest['metrics'][0]['yoy'] == pytest.approx(0.0132665350)
    assert latest['totals']['netIncome'] == 15433655239.83
    assert len(query_financials(2025, '')['metrics']) == 8
    assert len(query_financials(2025, 'all')['metrics']) == 8


def test_sources_preserve_2023_restatement_and_per_metric_pages():
    from financial_analytics import query_financials
    result = query_financials(2024)
    assert result['trend'][0]['restated'] is True
    assert result['trend'][0]['sources']['revenue'][0]['documentId'] == 'hikvision-2024'
    assert result['trend'][0]['sources']['revenue'][0]['page'] == 161
    assert result['trend'][2]['sources']['operatingCashFlow'][0]['page'] == 153
    assert {source['year'] for source in result['metrics'][0]['sources']} == {2023, 2024}
    assert result['metrics'][3]['formula'] == 'sellingExpenses + administrativeExpenses'
    text = ' '.join(result['limitations'])
    assert '同一控制' in text and '赋睿' in text and '95,712,702.24' in text and '2022' in text


@pytest.mark.parametrize('year,metric', [(2022, None), (2026, None), (True, None), (2025.0, None), ('2025', None), (2025, 'profit'), (2025, 'REVENUE')])
def test_unknown_or_coerced_parameters_are_rejected(year, metric):
    from financial_analytics import query_financials
    with pytest.raises(ValueError):
        query_financials(year, metric)


def copy_snapshot(tmp_path, monkeypatch):
    import financial_analytics as finance
    original = finance.SNAPSHOT_PATH
    manifest = json.loads(original.read_text())
    for document in manifest['dataset']['source']['documents']:
        raw_name = document['rawFile']
        (tmp_path / raw_name).write_bytes((original.parent / raw_name).read_bytes())
    target = tmp_path / original.name
    target.write_text(json.dumps(manifest))
    monkeypatch.setattr(finance, 'SNAPSHOT_PATH', target)
    return finance, manifest, target


def test_raw_snapshot_sha256_and_normalized_contents_are_checked(tmp_path, monkeypatch):
    finance, manifest, target = copy_snapshot(tmp_path, monkeypatch)
    raw_path = tmp_path / manifest['dataset']['source']['documents'][0]['rawFile']
    original_raw = raw_path.read_bytes()
    assert finance.query_financials()['totals']['revenue'] == 92507796069.94
    raw_path.write_bytes(gzip.compress(b'{}'))
    with pytest.raises(ValueError, match='校验'):
        finance.query_financials()
    raw_path.unlink()
    with pytest.raises(ValueError, match='缺失'):
        finance.query_financials()
    raw_path.write_bytes(original_raw)
    manifest['records'][0]['values']['revenue'] += 1
    target.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match='校验'):
        finance.query_financials()


def test_deflate_corruption_returns_validation_instead_of_internal_error(tmp_path, monkeypatch):
    finance, manifest, target = copy_snapshot(tmp_path, monkeypatch)
    raw_path = tmp_path / manifest['dataset']['source']['documents'][0]['rawFile']
    damaged = bytearray(raw_path.read_bytes())
    damaged[10] = 0x07
    raw_path.write_bytes(damaged)
    with pytest.raises(ValueError, match='校验'):
        finance.query_financials()


def test_normalization_rejects_overlapping_year_disagreement_and_bad_reconciliation():
    import financial_analytics as finance
    manifest = json.loads(finance.SNAPSHOT_PATH.read_text())
    payloads = {d['id']: gzip.decompress((finance.SNAPSHOT_PATH.parent / d['rawFile']).read_bytes())
                for d in manifest['dataset']['source']['documents']}
    normalized = finance.normalize_reports(payloads, 'different retrieval date')
    assert normalized['dataset']['version'] == manifest['dataset']['version']
    text = finance.extract_report_pages(payloads['hikvision-2024'], 2024)
    text['income'] = text['income'].replace('92,495,525,118.30', '92,495,525,118.31')
    with pytest.raises(ValueError, match='勾稽|一致'):
        finance.parse_report_pages(text, 2024)
    text = finance.extract_report_pages(payloads['hikvision-2025'], 2025)
    text['income'] = text['income'].replace('合并利润表', '母公司利润表')
    with pytest.raises(ValueError, match='合并'):
        finance.parse_report_pages(text, 2025)


def test_reports_are_protected_persistent_and_independent_of_current_dataset(tmp_path, monkeypatch):
    import financial_analytics as finance
    store = Store(tmp_path / 'finance.sqlite', {'data': {}, 'tasks': [], 'activeTask': None})
    report = finance.create_report(store, 2025)['report']
    second = finance.create_report(store, 2024)['report']
    assert report['id'].startswith('public-report-')
    assert report['version'] == 1
    assert 'cards' not in report['snapshot']
    assert second['snapshot']['year'] == 2024
    before = copy.deepcopy(report)
    report['snapshot']['totals']['revenue'] = 0
    store.patch({'baseRevision': store.snapshot()['revision'], 'data': {'publicFinancialReports': {before['id']: report}}})
    monkeypatch.setattr(finance, 'SNAPSHOT_PATH', tmp_path / 'missing.json')
    reopened = Store(store.path)
    assert finance.get_report(reopened, before['id']) == before
    assert {item['year'] for item in finance.list_reports(reopened)} == {2024, 2025}
    assert all('snapshot' not in item and item['currency'] == 'CNY' and item['shortName'] == '海康威视' for item in finance.list_reports(reopened))
    with pytest.raises(ValueError, match='不存在'):
        finance.get_report(reopened, 'missing')


def test_concurrent_report_creation_preserves_each_snapshot(tmp_path):
    from financial_analytics import create_report, get_report, list_reports
    store = Store(tmp_path / 'finance.sqlite', {'data': {}, 'tasks': [], 'activeTask': None})
    with ThreadPoolExecutor(max_workers=4) as executor:
        reports = list(executor.map(lambda year: create_report(store, year)['report'], [2023, 2024, 2025, 2025]))
    assert len(list_reports(store)) == 4
    assert all(get_report(store, report['id']) == report for report in reports)


def test_public_financial_routes_validate_inputs_and_persist_reports(tmp_path):
    from server import create_app
    store = Store(tmp_path / 'finance.sqlite', {'data': {}, 'tasks': [], 'activeTask': None})
    with TestClient(create_app(store)) as client:
        response = client.get('/api/local/analytics/public/query?year=2025&metric=revenue')
        assert response.status_code == 200
        assert response.json()['metrics'][0]['value'] == 92507796069.94
        for query in ('year=2022', 'year=2025.0', 'metric=unknown', 'month=10', 'company=Microsoft', 'year=2024&year=2025'):
            assert client.get('/api/local/analytics/public/query?' + query).status_code == 422
        for body in ({'year': True}, {'year': '2025'}, {'year': 2022}, {'year': 2025, 'company': 'Microsoft'}):
            assert client.post('/api/local/analytics/public/reports', json=body).status_code == 422
        created = client.post('/api/local/analytics/public/reports', json={'year': 2025})
        assert created.status_code == 200
        report = created.json()['report']
        assert client.get('/api/local/analytics/public/reports/' + report['id']).json()['report'] == report
        assert client.get('/api/local/analytics/public/reports').json()['reports'][0]['datasetVersion'] == report['snapshot']['dataset']['version']
        assert client.get('/api/local/analytics/public/reports/missing').status_code == 404


def test_report_creation_rejects_stale_or_different_dataset(tmp_path):
    from financial_analytics import create_report, list_reports
    store = Store(tmp_path / 'finance.sqlite', {'data': {}, 'tasks': [], 'activeTask': None})
    with pytest.raises(ValueError, match='重新查询'):
        create_report(store, 2025, dataset_id='sec-apple-2025-10k', dataset_version='old')
    assert list_reports(store) == []
    with TestClient(__import__('server').create_app(store)) as client:
        for body in ({'datasetId': 'sec-apple-2025-10k'}, {'datasetVersion': 'outdated'}, {'datasetId': 12}, {'datasetVersion': 'x' * 201}):
            response = client.post('/api/local/analytics/public/reports', json=body)
            assert response.status_code == 422
        query = client.get('/api/local/analytics/public/query').json()
        response = client.post('/api/local/analytics/public/reports', json={
            'year': 2025, 'datasetId': query['dataset']['id'], 'datasetVersion': query['dataset']['version']})
        assert response.status_code == 200
        assert response.json()['report']['snapshot']['dataset'] == query['dataset']


def test_refresh_failure_preserves_previous_snapshot(tmp_path, monkeypatch):
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('fetch_public_financials', Path(__file__).parents[3] / 'scripts/demos/fetch-public-financials.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / 'manifest.json'
    target.write_text('previous usable snapshot')
    monkeypatch.setattr(module, 'SNAPSHOT_PATH', target)
    class Response:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, limit):
            return b'broken official response'
    monkeypatch.setattr(module, 'urlopen', lambda request, timeout: Response())
    with pytest.raises(ValueError, match='校验'):
        module.refresh_snapshot()
    assert target.read_text() == 'previous usable snapshot'
    assert list(tmp_path.iterdir()) == [target]


def test_normalization_checks_every_overlapping_2024_component(monkeypatch):
    import financial_analytics as finance
    manifest = json.loads(finance.SNAPSHOT_PATH.read_text())
    payloads = {d['id']: gzip.decompress((finance.SNAPSHOT_PATH.parent / d['rawFile']).read_bytes())
                for d in manifest['dataset']['source']['documents']}
    parse = finance.parse_report_pages
    def altered_cash_components(pages, year):
        values = parse(pages, year)
        if year == 2024:
            values[2024]['operatingCashInflows'] += 1
            values[2024]['operatingCashOutflows'] += 1
        return values
    monkeypatch.setattr(finance, 'parse_report_pages', altered_cash_components)
    with pytest.raises(ValueError, match='不一致'):
        finance.normalize_reports(payloads, '2026-11-17')


def test_historical_apple_report_reopens_without_current_source(tmp_path, monkeypatch):
    import financial_analytics as finance
    store = Store(tmp_path / 'finance.sqlite', {'data': {}, 'tasks': [], 'activeTask': None})
    old = {'id': 'public-report-apple-old', 'title': '苹果公司 2025 财年财务分析报告',
           'createdAt': '2025-11-01T00:00:00+00:00', 'version': 1,
           'snapshot': {'year': 2025, 'dataset': {'id': 'sec-apple-2025-10k', 'version': 'old-version',
                        'entity': 'Apple Inc.', 'currency': 'USD', 'source': {'provider': 'SEC EDGAR'}},
                        'totals': {'revenue': 416161000000}}}
    store.mutate(lambda state: state.setdefault('data', {}).setdefault('publicFinancialReports', {}).update({old['id']: old}))
    monkeypatch.setattr(finance, 'SNAPSHOT_PATH', tmp_path / 'missing.json')
    assert finance.get_report(Store(store.path), old['id']) == old
    metadata = finance.list_reports(store)[0]
    assert metadata['currency'] == 'USD' and metadata['entity'] == 'Apple Inc.'
    assert metadata['sourceLabel'] == 'SEC EDGAR'
