from datetime import date

import pytest
from fastapi.testclient import TestClient

from business_analytics import _previous_period, business_options, query_board
from server import create_app
from store import Store


def values(board):
    return {entry['id']: entry['value'] for entry in board['metrics']}


def test_department_scope_default_and_permissions():
    options = business_options()
    assert [dept['id'] for dept in options['departments']] == ['finance', 'sales', 'research']
    assert options['defaultScope']['departmentIds'] == ['finance']
    assert query_board()['scope'] == options['defaultScope']
    with pytest.raises(ValueError, match='无权'):
        query_board(department_ids=['finance', 'operations'])
    with pytest.raises(ValueError, match='至少'):
        query_board(department_ids=[])


def test_expense_and_travel_reconcile_with_rankings_and_trends():
    args = ('2026-09-01', '2026-09-30', ['finance', 'sales'])
    expense = query_board('expense', *args)
    travel = query_board('travel', *args)
    money, trips = values(expense), values(travel)
    assert money['claimCount'] == expense['recordCount'] > travel['recordCount'] > 0
    assert trips['tripCount'] == travel['recordCount'] == money['tripCount']
    assert money['travelAmount'] == trips['travelAmount']
    assert sorted(row['amount'] for row in travel['ranking'])[::-1] == [row['amount'] for row in expense['ranking']]
    assert sum(row['amount'] for row in travel['ranking']) == pytest.approx(trips['travelAmount'])
    assert sum(row['trips'] for row in travel['routes']) == sum(item['value'] for item in travel['trend']) == trips['tripCount']
    assert sum(row['amount'] for row in travel['routes']) == pytest.approx(trips['travelAmount'])
    for key in ('trend', 'breakdown', 'departments'):
        assert sum(row['value'] for row in expense[key]) == pytest.approx(money['expenseAmount'])
        assert sum(row['value'] for row in travel[key]) == trips['tripCount']
    assert len(expense['trend']) == 30
    assert all(row['department'] in {'财务部', '销售部'} for row in expense['ranking'])
    assert {row['name'] for row in expense['departments']} == {'财务部', '销售部'}


def test_boundary_dates_and_empty_selection():
    all_month = query_board('expense', '2026-09-01', '2026-09-30', ['research'])
    first_day = all_month['trend'][0]
    daily = query_board('expense', first_day['date'], first_day['date'], ['research'])
    assert values(daily)['expenseAmount'] == first_day['value']
    empty = query_board('expense', '2025-09-01', '2025-09-30', ['finance'])
    assert empty['recordCount'] == 0
    assert empty['coverageStatus'] == 'outside'
    assert all_month['coverageStatus'] == 'complete'
    assert not any(values(empty).values())
    assert not any(empty[key] for key in ('trend', 'ranking', 'routes', 'breakdown', 'departments'))


def test_september_finance_story_and_extended_date_range():
    september = query_board('expense', '2026-09-01', '2026-09-30', ['finance'])
    assert values(september) == {'expenseAmount': 82812.9, 'travelAmount': 48053.2, 'claimCount': 43, 'tripCount': 20}
    assert september['ranking'][0] == {'name': '宋欣', 'department': '财务部', 'amount': 20796.1, 'trips': 6}
    year = query_board('expense', '2026-01-01', '2026-12-31', ['finance'])
    assert year['coverageStatus'] == 'partial'
    assert year['coverage'] == {'startDate': '2026-08-01', 'endDate': '2026-11-22'}
    assert [row['date'] for row in year['trend']] == [f'2026-{month:02}-01' for month in range(8, 12)]
    assert year['trend'][1]['value'] == values(september)['expenseAmount']
    assert year['trendGrain'] == 'month'
    assert year['trend'][-1]['endDate'] == '2026-11-22'


@pytest.mark.parametrize('system', ['expense', 'travel'])
@pytest.mark.parametrize('start,end,prior_start,prior_end,kind', [
    ('2026-09-01', '2026-09-30', '2026-08-01', '2026-08-31', 'previousMonth'),
    ('2026-11-01', '2026-11-22', '2026-10-01', '2026-10-22', 'monthToDate'),
    ('2026-10-27', '2026-11-03', '2026-10-19', '2026-10-26', 'previousPeriod'),
])
def test_comparison_matches_independent_query_for_same_authorized_scope(system, start, end, prior_start, prior_end, kind):
    departments = ['finance', 'research']
    comparison = query_board(system, start, end, departments)['comparison']
    assert comparison['kind'] == kind
    assert (comparison['startDate'], comparison['endDate']) == (prior_start, prior_end)
    assert comparison['values'] == values(query_board(system, prior_start, prior_end, departments))


@pytest.mark.parametrize('start,end', [
    ('2026-07-01', '2026-07-31'), ('2026-08-01', '2026-08-31'), ('2026-11-01', '2026-11-30'),
])
def test_incomplete_source_periods_hide_comparison(start, end):
    assert query_board('expense', start, end, ['finance'])['comparison'] is None


def test_preceding_short_month_and_calendar_year_boundary():
    assert _previous_period(date(2026, 3, 1), date(2026, 3, 30)) == (
        date(2026, 1, 30), date(2026, 2, 28), 'previousPeriod')
    assert _previous_period(date(2026, 1, 1), date(2026, 1, 31)) == (
        date(2025, 12, 1), date(2025, 12, 31), 'previousMonth')


def test_zero_record_period_is_comparable_when_covered():
    empty = query_board('expense', '2026-11-02', '2026-11-02', ['finance'])
    assert empty['recordCount'] == 0
    assert empty['comparison']['values']['expenseAmount'] == 1766
    after_empty = query_board('expense', '2026-11-04', '2026-11-04', ['finance'])
    assert not any(after_empty['comparison']['values'].values())
    assert values(after_empty)['expenseAmount'] == 7572.3


def test_weekly_trend_labels_include_the_partial_final_bucket():
    result = query_board('expense', '2026-09-01', '2026-10-16', ['finance'])
    assert result['trendGrain'] == 'sevenDays'
    assert result['trend'][0]['endDate'] == '2026-09-07'
    assert result['trend'][-1]['date'] == '2026-10-13'
    assert result['trend'][-1]['endDate'] == '2026-10-16'


@pytest.mark.parametrize('start,end', [('2026-11-22', '2026-11-21'), ('2026-02-30', '2026-03-01'), ('20260901', '2026-09-02')])
def test_invalid_dates_rejected(start, end):
    with pytest.raises(ValueError, match='日期'):
        query_board('expense', start, end, ['finance'])


@pytest.mark.parametrize('arguments', [
    {'system': ['expense']}, {'system': {}}, {'start_date': 20261101}, {'end_date': False},
    {'department_ids': 'finance'}, {'department_ids': [None]}, {'department_ids': [[]]},
])
def test_malformed_arguments_are_domain_errors(arguments):
    with pytest.raises(ValueError):
        query_board(**arguments)


def test_http_options_scope_does_not_trust_viewer_overrides(tmp_path):
    base = '/api/local/analytics/business'
    with TestClient(create_app(Store(tmp_path / 'workspace.db'))) as client:
        assert client.get(base + '/options').json() == business_options()
        res = client.get(base + '/board', params={'system': 'travel', 'departmentIds': 'research,finance', 'startDate': '2026-09-01', 'endDate': '2026-09-30'})
        assert res.status_code == 200 and res.json() == query_board('travel', '2026-09-01', '2026-09-30', ['research', 'finance'])
        denied = client.get(base + '/board', params={'departmentIds': 'finance,operations', 'role': 'admin'})
        assert denied.status_code == 403 and '无权' in denied.json()['message']
        assert client.get(base + '/board', params={'system': 'public'}).status_code == 422
        assert client.get(base + '/board', params={'departmentIds': ''}).status_code == 422


@pytest.mark.parametrize('seat', [None, '林悦'])
def test_only_authorized_workbench_seats_can_query(monkeypatch, seat):
    import work_decisions
    monkeypatch.setattr(work_decisions, 'WORK_APPROVER', seat)
    for endpoint in (business_options, query_board):
        with pytest.raises(ValueError, match='无权'):
            endpoint()
