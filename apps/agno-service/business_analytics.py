"""费用看板、差旅看板与对话共用的只读演示台账。金额聚合使用人民币分。"""
from collections import Counter
import csv
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from pathlib import Path

from business import BusinessError, is_date
import work_decisions


SYSTEMS = {'expense': '费用报销', 'travel': '差旅管理'}
DEPARTMENTS = {'finance': '财务部', 'sales': '销售部', 'research': '研发部', 'operations': '运营部'}
# 与工作台共用本机登录席位。首项是主管所属部门，其余为额外授权部门。
DEPARTMENT_GRANTS = {'吴侠': ('finance', 'sales', 'research')}
LEDGER = Path(__file__).with_name('data') / 'business-board-demo.csv'
SOURCE = '费用报销与差旅台账（本地合成数据）'
COVERAGE_START = date(2026, 8, 1)
AS_OF = date(2026, 11, 22)


@dataclass(frozen=True)
class Claim:
    day: date
    department: str
    employee: str
    category: str
    cents: int
    route: str
    transport: str
    trip_days: int


@cache
def _ledger():
    with LEDGER.open(encoding='utf-8', newline='') as source:
        return tuple(Claim(
            day=date.fromisoformat(row['activity_date']), department=row['department_id'],
            employee=row['employee'], category=row['category'], cents=int(row['amount_cents']),
            route=row['route'], transport=row['transport'], trip_days=int(row['trip_days'] or 0)
        ) for row in csv.DictReader(source))


def business_options():
    allowed = DEPARTMENT_GRANTS.get(work_decisions.WORK_APPROVER, ())
    if not allowed:
        raise BusinessError('ANALYTICS_FORBIDDEN', '当前身份无权查看部门业务看板。')
    return {
        'systems': [{'id': key, 'name': label} for key, label in SYSTEMS.items()],
        'departments': [{'id': key, 'name': DEPARTMENTS[key]} for key in allowed],
        'defaultScope': {
            'system': 'expense', 'startDate': AS_OF.replace(day=1).isoformat(),
            'endDate': AS_OF.isoformat(), 'departmentIds': [allowed[0]],
        },
        'coverage': {'startDate': COVERAGE_START.isoformat(), 'endDate': AS_OF.isoformat()},
        'source': SOURCE,
    }


def _group_values(amounts, *, money):
    return [{'name': name, 'value': value / 100 if money else value}
            for name, value in sorted(amounts.items(), key=lambda item: (-item[1], item[0]))]


def _trend(daily, start, end, *, money):
    if not daily:
        return []
    span = (end - start).days + 1
    interval = 1 if span <= 45 else 7
    # 不将台账覆盖期之外的日期绘制成零值。
    current = max(start, COVERAGE_START)
    last = min(end, AS_OF)
    result = []
    while current <= last:
        if span > 185:
            following = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
            label = f'{current.year}/{current.month:02}'
        else:
            following = current + timedelta(days=interval)
            label = f'{current.month}/{current.day}'
        length = (min(following, last + timedelta(days=1)) - current).days
        value = sum(daily[current + timedelta(days=i)] for i in range(length))
        result.append({'date': current.isoformat(), 'label': label, 'value': value / 100 if money else value})
        current = following
    return result


def _metric(key, label, value, unit):
    return {'id': key, 'label': label, 'value': value, 'unit': unit}


def query_board(system=None, start_date=None, end_date=None, department_ids=None):
    options = business_options()
    default = options['defaultScope']
    system = default['system'] if system is None else system
    if not isinstance(system, str) or system not in SYSTEMS:
        raise ValueError('请选择有效的业务系统。')
    requested = default['departmentIds'] if department_ids is None else department_ids
    if not isinstance(requested, (list, tuple)) or not requested or any(not isinstance(d, str) or not d for d in requested):
        raise ValueError('请至少选择一个部门。')
    allowed = [department['id'] for department in options['departments']]
    if not set(requested).issubset(allowed):
        raise BusinessError('ANALYTICS_FORBIDDEN', '无权查看所选部门的数据。')
    selected = [department for department in allowed if department in requested]
    start_date = default['startDate'] if start_date is None else start_date
    end_date = default['endDate'] if end_date is None else end_date
    if not is_date(start_date) or not is_date(end_date):
        raise ValueError('日期须使用有效的年、月、日（YYYY-MM-DD）。')
    start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    if start > end:
        raise ValueError('结束日期不能早于开始日期。')
    coverage_status = 'complete'
    if start < COVERAGE_START or end > AS_OF:
        coverage_status = 'outside' if end < COVERAGE_START or start > AS_OF else 'partial'

    expense = system == 'expense'
    daily, breakdown, departments = Counter(), Counter(), Counter()
    employee_amounts, employee_trips = Counter(), Counter()
    route_amounts, route_trips = Counter(), Counter()
    record_count = total_cents = travel_cents = trip_days = 0
    for claim in _ledger():
        if claim.department not in selected or not start <= claim.day <= end:
            continue
        if not expense and not claim.trip_days:
            continue
        record_count += 1
        total_cents += claim.cents
        value = claim.cents if expense else 1
        daily[claim.day] += value
        breakdown[claim.category if expense else claim.transport] += value
        departments[DEPARTMENTS[claim.department]] += value
        if claim.trip_days:
            travel_cents += claim.cents
            trip_days += claim.trip_days
            employee = (claim.employee, claim.department)
            employee_amounts[employee] += claim.cents
            employee_trips[employee] += 1
            route_amounts[claim.route] += claim.cents
            route_trips[claim.route] += 1

    trip_count = sum(employee_trips.values())
    travel_amount = _metric('travelAmount', '差旅费用', travel_cents / 100, '元')
    trips = _metric('tripCount', '出差行程', trip_count, '次')
    if expense:
        metrics = [_metric('expenseAmount', '报销总额', total_cents / 100, '元'), travel_amount,
                   _metric('claimCount', '报销单数', record_count, '笔'), trips]
    else:
        metrics = [trips, _metric('travelerCount', '出差人数', len(employee_trips), '人'),
                   travel_amount, _metric('tripDays', '出差人天', trip_days, '天')]
    ranking = [{'name': name, 'department': DEPARTMENTS[department], 'amount': cents / 100,
                'trips': employee_trips[name, department]}
               for (name, department), cents in sorted(employee_amounts.items(), key=lambda item: (-item[1], item[0]))]
    routes = [{'name': route, 'trips': count, 'amount': route_amounts[route] / 100}
              for route, count in sorted(route_trips.items(), key=lambda item: (-item[1], -route_amounts[item[0]], item[0]))]
    return {
        'scope': {'system': system, 'startDate': start_date, 'endDate': end_date, 'departmentIds': selected},
        'title': SYSTEMS[system] + '看板', 'departmentLabel': '、'.join(DEPARTMENTS[dept] for dept in selected),
        'source': SOURCE, 'coverage': options['coverage'], 'coverageStatus': coverage_status,
        'recordCount': record_count, 'metrics': metrics,
        'trend': _trend(daily, start, end, money=expense), 'breakdown': _group_values(breakdown, money=expense),
        'departments': _group_values(departments, money=expense), 'ranking': ranking, 'routes': routes,
    }
