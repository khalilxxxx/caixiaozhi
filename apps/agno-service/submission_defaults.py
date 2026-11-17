"""可追溯的草稿补全。只由写事务调用；来源和抑制记录由服务端持有。"""
from __future__ import annotations

from copy import deepcopy
from datetime import date
import json
from pathlib import Path
from uuid import uuid4


LEG_FIELDS = 'id departureCity arrivalCity departureDate arrivalDate transport'.split()
EXPENSE_FIELDS = 'id categoryId name currency amount reason reasonOption date tripId departureDate arrivalDate departureCity arrivalCity transport checkIn checkOut city rooms nights rental coResidents people quantity standard oaId'.split()
LABELS = {'applicant':'申请人', 'department':'部门', 'paymentCompany':'付款公司', 'travelType':'差旅类型',
          'departureCity':'出发城市', 'arrivalCity':'到达城市', 'transport':'交通方式', 'arrivalDate':'到达日期',
          'currency':'币种', 'rental':'是否租房'}


def load_config():
    return json.loads(Path(__file__).with_suffix('.json').read_text())


def submission_context(draft, config=None):
    config = config if config is not None else load_config()
    current = next((p for p in config['employees'] if p['id'] == config['currentEmployeeId']), None)
    matches = [p for p in config['employees'] if p.get('name') == draft.get('applicant')]
    return deepcopy({'employee': matches[0] if len(matches) == 1 else None, 'currentEmployee': current,
                     'profileSource': config['profileSource'], 'routeSource': config['routeSource'],
                     'rules': config['rules'], 'routes': config['routes'], 'config': config['policy']})


def merge_draft_patch(previous, patch):
    """数组表示完整集合；已有项按稳定 ID 合并，省略字段不清除已有内容。"""
    if 'returnDatePending' in patch and not isinstance(patch['returnDatePending'], bool):
        raise ValueError('返程日期待定标志必须为布尔值。')
    result = deepcopy(previous)
    result.update({k: deepcopy(v) for k, v in patch.items() if k != 'autoFill'})
    for collection in ('legs', 'expenses', 'activities'):
        if collection not in patch:
            continue
        rows = patch[collection]
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError('行程、费用或活动内容格式无效。')
        originals = {row.get('id'): row for row in previous.get(collection, [])}
        seen, normalized = set(), []
        for row in rows:
            identifier = row.get('id') or str(uuid4())
            if not isinstance(identifier, str) or identifier in seen:
                raise ValueError('行程、费用或活动标识须唯一。')
            seen.add(identifier)
            fields = LEG_FIELDS if collection == 'legs' else EXPENSE_FIELDS if collection == 'expenses' else []
            item = {**dict.fromkeys(fields, ''), **deepcopy(originals.get(identifier, {})), **deepcopy(row), 'id': identifier}
            if any(not isinstance(item.get(field, ''), str) or len(item.get(field, '')) > 8000 for field in fields):
                raise ValueError('行程和费用字段必须为不超过8000字的文本。')
            if collection == 'legs':
                for flag in ('isReturn', 'isOvernight'):
                    if flag in item and not isinstance(item[flag], bool):
                        raise ValueError('返程和跨日标志必须为布尔值。')
            normalized.append(item)
        result[collection] = normalized
    return result


def _locations(draft):
    locations = {key: (draft, key) for key in ('applicant','department','paymentCompany','travelType')}
    for collection in ('legs','expenses'):
        seen = set()
        for row in draft.get(collection, []):
            identifier = row.get('id')
            if not isinstance(identifier, str) or not identifier or identifier in seen:
                raise ValueError('行程和费用标识须唯一且不能为空。')
            seen.add(identifier)
            for field in (LEG_FIELDS[1:] if collection == 'legs' else EXPENSE_FIELDS[1:]):
                locations[f'{collection}.{identifier}.{field}'] = (row, field)
    return locations


def _valid_date(value):
    try:
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value
    except (ValueError, TypeError):
        return False


def _is_blank_profile_template(draft, config):
    if not draft or draft.get('autoFill') or draft.get('version') != 1 or draft.get('savedAt') is not None:
        return False
    if any(draft.get(key) for key in ('purpose','legs','expenses','activities','companions','files','materialIds','applicationId','subsidyCents','sourceImportKey')):
        return False
    current = submission_context(draft, config)['currentEmployee']
    return bool(current and all(draft.get(key) == current.get(field) for key, field in
                               (('applicant','name'),('department','department'),('paymentCompany','paymentCompany')))
                and draft.get('travelType') == config['policy']['travelType'])


def apply_submission_defaults(candidate, previous=None, config=None, adopt_defaults=False, manual_fields=None):
    """返回副本，不接受 candidate 自带来源。previous 必须来自服务端已存草稿/编辑。"""
    if candidate.get('status') != 'draft':
        return deepcopy(previous if previous is not None else candidate)
    config = config if config is not None else load_config()
    if _is_blank_profile_template(previous, config):
        previous = apply_submission_defaults(previous, config=config, adopt_defaults=True)
    draft = deepcopy(candidate)
    if 'returnDatePending' in draft and not isinstance(draft['returnDatePending'], bool):
        raise ValueError('返程日期待定标志必须为布尔值。')
    previous_meta = (previous or {}).get('autoFill', {})
    return_leg_id = previous_meta.get('returnLegId')
    if draft.get('type', draft.get('id')) == 'travel':
        trips = draft.setdefault('legs', [])
        # 已有待补段被用户删除或改为普通行程，视为取消；不能因下一次无关回复自动重建。
        if return_leg_id and not any(trip.get('id') == return_leg_id and trip.get('isReturn') is True for trip in trips):
            draft['returnDatePending'] = False
            return_leg_id = None
        if draft.get('returnDatePending') is True:
            returns = [trip for trip in trips if trip.get('isReturn') is True]
            if any(_valid_date(trip.get('departureDate')) for trip in returns):
                draft['returnDatePending'] = False
            elif returns:
                return_leg_id = returns[0]['id']
            elif any(trip.get('arrivalCity') for trip in trips):
                return_leg_id = 'return-' + uuid4().hex
                trips.append({**dict.fromkeys(LEG_FIELDS, ''), 'id':return_leg_id, 'isReturn':True})
            if draft.get('returnDatePending') is True and return_leg_id:
                # 新增目的地仍属于去程，把日期待补的回程保留在末尾，稳定 ID 与人工值不变。
                trips[:] = [trip for trip in trips if trip.get('id') != return_leg_id] + [trip for trip in trips if trip.get('id') == return_leg_id]
    locations = _locations(draft)
    if manual_fields is not None and (not isinstance(manual_fields, list) or len(manual_fields) > 500
                                      or any(not isinstance(path, str) or path not in locations for path in manual_fields)):
        raise ValueError('明确填写字段须使用存在的稳定行程或费用标识。')
    manual = set(manual_fields or [])
    # 新费用先在浏览器编辑器中填写，首次保存时尚无服务端旧行可做差异比较。
    # 仅接受字段名这一人工操作声明，来源、依据和规则标识仍由服务端维护。
    for expense in draft.get('expenses', []):
        touched = expense.get('manualFields', [])
        if (not isinstance(touched, list) or len(touched) > 100
                or any(not isinstance(field, str) or field not in ('currency', 'rental') for field in touched)):
            raise ValueError('费用人工填写标记只支持币种和是否租房字段。')
        if 'manualFields' in expense:
            expense['manualFields'] = list(dict.fromkeys(touched))
        manual.update('expenses.'+expense['id']+'.'+field for field in touched)
    old_locations = _locations(previous) if previous is not None else {}
    previous_fields = previous_meta.get('fields', {})
    suppressed = {p for p in previous_meta.get('suppressed', []) if p in locations}
    fields = {}

    # 比较业务值而非数组下标；重算时只撤销仍属于系统的值。
    for path, (obj, key) in locations.items():
        value = obj.get(key, '')
        old_obj, old_key = old_locations.get(path, ({}, key))
        old_value = old_obj.get(old_key, '')
        changed = path in old_locations and value != old_value
        if changed or path in manual:
            if not value and old_value:
                suppressed.add(path)
            elif value:
                suppressed.discard(path)
            elif path in manual:
                suppressed.add(path)
        metadata = previous_fields.get(path)
        if metadata and not changed and path not in manual and value == metadata.get('value'):
            # 席别来自明确交通类别，换路线不能把用户选的火车改成飞机。
            obj[key] = {'seat-train':'火车', 'seat-air':'飞机'}.get(metadata.get('ruleId'), '')

    def fill(path, value, rule, source, basis):
        if path not in locations or path in suppressed or path in manual or not value:
            return
        obj, key = locations[path]
        if obj.get(key):
            return
        obj[key] = str(value)
        fields[path] = {'value':str(value), 'label':LABELS.get(key,key), 'ruleId':rule, 'source':source, 'basis':basis}

    context = submission_context(draft, config)
    current = context['currentEmployee']
    if current:
        fill('applicant', current['name'], 'current-employee', config['profileSource'], '按当前本地登录员工填写；申请人可核对修改。')
    employee = submission_context(draft, config)['employee']
    if employee:
        for field in ('department','paymentCompany'):
            fill(field, employee.get(field), 'employee-'+field, config['profileSource'], '按匹配申请人的本地档案填写。')
    fill('travelType', config['policy']['travelType'], 'ordinary-travel', config['policy']['source'], '未指定差旅类型，默认普通差旅。')
    if adopt_defaults:
        for key, value in {'applicant':current and current['name'], 'department':employee and employee.get('department'),
                           'paymentCompany':employee and employee.get('paymentCompany'), 'travelType':config['policy']['travelType']}.items():
            if value and draft.get(key) == value and key not in suppressed and key not in fields:
                draft[key] = ''
                fill(key, value, 'current-employee' if key == 'applicant' else 'ordinary-travel' if key == 'travelType' else 'employee-'+key,
                     config['policy']['source'] if key == 'travelType' else config['profileSource'], '新建草稿的默认信息，请核对。')

    if draft.get('type', draft.get('id')) == 'travel':
        trips = draft.get('legs', [])
        policy = config['policy']
        for index, trip in enumerate(trips):
            prefix = 'legs.'+trip['id']+'.'
            if index == 0:
                fill(prefix+'departureCity', (employee or {}).get('baseCity'), 'employee-base', config['profileSource'], '首段未提供出发城市，采用匹配申请人的常驻地。')
            else:
                prior_city = next((prior.get('arrivalCity') for prior in reversed(trips[:index]) if prior.get('arrivalCity')), '') if trip['id'] == return_leg_id else trips[index-1].get('arrivalCity')
                fill(prefix+'departureCity', prior_city, 'previous-arrival', '当前申请行程', '沿用前段已知到达城市；前段变更后重新计算。')
            if index > 0 and trip.get('isReturn') is True:
                fill(prefix+'arrivalCity', trips[0].get('departureCity'), 'return-origin', '当前申请行程', '已有返程段返回本申请实际首段起点。')
            origin, destination = trip.get('departureCity',''), trip.get('arrivalCity','')
            matches = [r for r in config['routes'] if origin != destination and {r['from'],r['to']} == {origin,destination}]
            route = matches[0] if len(matches) == 1 else None
            transport = trip.get('transport','').strip()
            if prefix+'transport' not in manual and (transport in ('火车','高铁','动车','火车票') or transport in ('飞机','航班','机票')):
                is_train = transport in ('火车','高铁','动车','火车票')
                trip['transport'] = ''
                fill(prefix+'transport', policy['railTransport' if is_train else 'airTransport'], 'seat-train' if is_train else 'seat-air',
                     policy['source'], '保留已明确的交通类别，仅补充未指定的席别；可修改。')
            if route:
                short_rail = (route.get('railAvailable') is True and route.get('distanceKm', float('inf')) <= policy['railMaxKm']
                              and route.get('railHours', float('inf')) <= policy['railMaxHours'])
                mode = policy['railTransport'] if short_rail else policy['airTransport'] if route.get('flightAvailable') is True else ''
                basis = f"{origin}—{destination}本地参考约{route['distanceKm']}公里"
                if short_rail:
                    basis += f"、铁路约{route['railHours']}小时，满足本地推荐参数≤{policy['railMaxKm']}公里且≤{policy['railMaxHours']}小时。"
                else:
                    basis += '；参考样本有航空选项，建议经济舱。'
                fill(prefix+'transport', mode, 'route-transport', config['routeSource'], basis)
            if _valid_date(trip.get('departureDate')) and trip.get('isOvernight') is not True:
                fill(prefix+'arrivalDate', trip['departureDate'], 'departure-same-day', policy['source'],
                     '未明确到达日期或跨日，默认与本段出发日期相同；可按实际安排修改。')

    for expense in draft.get('expenses', []):
        prefix = 'expenses.'+expense['id']+'.'
        fill(prefix+'currency', config['policy']['currency'], 'default-currency', '本地表单默认', '未指定币种，默认人民币；按实际票据核对。')
        if expense.get('categoryId') in config['policy']['rentalCategoryIds']:
            fill(prefix+'rental', config['policy']['rental'], 'default-non-rental', '本地表单默认', '住宿费用未指定租房，默认非租房；按实际费用核对。')
    draft['autoFill'] = {'fields':fields, 'suppressed':sorted(suppressed)}
    if return_leg_id:
        draft['autoFill']['returnLegId'] = return_leg_id
    return draft
