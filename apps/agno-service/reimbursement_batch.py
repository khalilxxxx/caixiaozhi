"""将本单选中的、经过识别的发票与凭证整理为费用草稿。"""
from __future__ import annotations

from collections import defaultdict
from datetime import date
import hashlib
import json
import re
import unicodedata

from business import ACTIVITY_FIELDS, EXPENSE_FIELDS, LABELS, BusinessError, draft_type, is_date
from material_service import NON_RECEPTION, RECEPTION, category_signals, classify_service, match_trip, transport_mode


def stable_id(prefix, keys):
    encoded = json.dumps(sorted(keys), ensure_ascii=False).encode()
    return prefix + '-' + hashlib.sha256(encoded).hexdigest()[:24]


def attachment(file):
    return {key: file[key] for key in ('id', 'name', 'type', 'size') if key in file}


def identity(value):
    return ''.join(unicodedata.normalize('NFKC', str(value or '')).casefold().split())


def receipt_records(files):
    records, unavailable = {}, {}
    digests, invoice_numbers = set(), set()
    for file in files:
        fid = file['id']
        recognized = file.get('recognition') or {}
        role = recognized.get('role', 'unknown')
        evidence = recognized.get('evidence') or {}
        facts = {k: v for k, v in (recognized.get('facts') or {}).items()
                 if evidence.get(k) and type(v) in (str, int) and v != ''}
        quotes = {k: evidence[k] for k in facts}
        if recognized.get('multipleDocuments'):
            unavailable[fid] = '一个文件中有多张票据，请拆分后重新上传。'
        elif file.get('extractionStatus') in ('failed', 'unreadable') or file.get('status') == 'failed':
            unavailable[fid] = file.get('extractionError') or '识别失败，请重新识别或上传。'
        elif not recognized:
            unavailable[fid] = '缺少票面识别结果，请重新识别。'
        elif file.get('status') == 'duplicate' or (file.get('sha256') and file['sha256'] in digests):
            unavailable[fid] = '本次材料已包含相同原件。'
        invoice_number = identity(facts.get('invoiceNumber'))
        if role == 'invoice' and invoice_number and invoice_number in invoice_numbers:
            unavailable[fid] = '本次材料已包含相同发票号码。'
        if fid not in unavailable:
            if file.get('sha256'):
                digests.add(file['sha256'])
            if role == 'invoice' and invoice_number:
                invoice_numbers.add(invoice_number)
        records[fid] = {'id': fid, 'file': file, 'role': role, 'facts': facts, 'quotes': quotes}
    return records, unavailable


def values(records, field):
    return list(dict.fromkeys(r['facts'][field] for r in records if field in r['facts']))


def references(records, field):
    return {identity(v) for v in values(records, field) if identity(v)}


def compatible(receipt, invoices):
    for field in ('merchant', 'orderId', 'transactionId', 'invoiceNumber'):
        left, right = references([receipt], field), references(invoices, field)
        if left and right and left.isdisjoint(right):
            return False
    return True


def linked(receipt, invoices, fields):
    return any(references([receipt], field) & references(invoices, field) for field in fields)


def conflicting_invoices(invoices):
    services = values(invoices, 'service')
    categories = category_signals(services)
    return (len(categories) > 1 or
            any(len(references(invoices, key)) > 1 for key in ('merchant', 'orderId', 'transactionId', 'currency')))


def invoice_clusters(invoices):
    # 同一事项跨票开具，只能凭实际交易标识合并。商户或费用类型相同均不足以合并。
    components = []
    for receipt in invoices:
        joins = [part for part in components if linked(receipt, part, ('orderId', 'transactionId'))]
        for part in joins:
            components.remove(part)
        components.append([r for part in joins for r in part] + [receipt])
    result = []
    for part in components:
        if conflicting_invoices(part):
            result.extend([r] for r in part)
        else:
            result.append(part)
    return result


def invoice_total(invoices):
    amounts = [r['facts'].get('amount') for r in invoices]
    currencies = values(invoices, 'currency')
    if len(currencies) > 1 or not amounts or any(type(v) is not int or not 0 <= v <= 10_000_000_000 for v in amounts):
        return None
    total = sum(amounts)
    return total if total <= 10_000_000_000 else None


def supporting_candidates(receipt, clusters):
    ref_fields = ('orderId', 'transactionId', 'invoiceNumber')
    strong = [i for i, part in enumerate(clusters) if linked(receipt, part, ref_fields)]
    if strong:
        if len(strong) == 1 and compatible(receipt, clusters[strong[0]]):
            return strong
        return []
    merchant = references([receipt], 'merchant')
    amount = receipt['facts'].get('amount')
    if not merchant or type(amount) is not int or amount <= 0:
        return []
    matches = []
    for i, part in enumerate(clusters):
        if (merchant != references(part, 'merchant') or not compatible(receipt, part)
                or len(values([receipt, *part], 'currency')) > 1):
            continue
        dates = references(part, 'date')
        if receipt['facts'].get('date') and dates and references([receipt], 'date') != dates:
            continue
        total = invoice_total(part)
        if total is not None and 0 < total <= amount:
            matches.append((i, total))
    # 单笔支付可能覆盖同一商户多张分开发票。仅采纳唯一金额组合，多票还须同日消费。
    # 至多保存两种组合，足以识别歧义。按上传上限控制最坏情况下的遍历量。
    if len(matches) > 12:
        return []
    solutions = []
    def search(pos, remaining, selected):
        if len(solutions) >= 2:
            return
        if remaining == 0:
            solutions.append(selected)
            return
        for n in range(pos, len(matches)):
            index, total = matches[n]
            if total <= remaining:
                search(n + 1, remaining - total, selected + [index])
    search(0, amount, [])
    if len(solutions) != 1:
        return []
    result = solutions[0]
    if len(result) > 1:
        day = receipt['facts'].get('date')
        if not day or any(set(values(clusters[i], 'date')) != {day} for i in result):
            return []
        merged = [r for i in result for r in clusters[i]]
        if conflicting_invoices(merged):
            return []
    return result


def auto_assign(records):
    clusters = invoice_clusters([r for r in records if r['role'] == 'invoice'])
    proposals = {}
    for receipt in records:
        if receipt['role'] in ('payment', 'supporting'):
            indices = supporting_candidates(receipt, clusters)
            if indices:
                proposals[receipt['id']] = frozenset(indices)
    # 重叠但不同的支付组合意味着不止一种分组；保留独立发票，等待员工调整。
    combinations = set(proposals.values())
    disputed = {a for a in combinations for b in combinations if a != b and not a.isdisjoint(b)}
    grouped, consumed = [], set()
    for i in range(len(clusters)):
        if i in consumed:
            continue
        subset = next((s for s in combinations if s not in disputed and i in s), frozenset([i]))
        grouped.append({'invoiceFileIds': [r['id'] for j in sorted(subset) for r in clusters[j]],
                        'attachmentFileIds': [fid for fid, s in proposals.items() if s == subset and s not in disputed]})
        consumed.update(subset)
    return grouped


def validate_assignments(assignments, records, blocked, catalog):
    if not isinstance(assignments, list) or len(assignments) > len(records):
        raise BusinessError('VALIDATION_ERROR', '请核对费用分组。')
    assigned, invoice_numbers = set(), set()
    for group in assignments:
        if not isinstance(group, dict):
            raise BusinessError('VALIDATION_ERROR', '费用分组格式无效。')
        for field in ('invoiceFileIds', 'attachmentFileIds'):
            ids = group.get(field, [])
            if not isinstance(ids, list) or (field == 'invoiceFileIds' and not ids):
                raise BusinessError('VALIDATION_ERROR', '每笔费用至少需要一张发票。')
            for fid in ids:
                if not isinstance(fid, str) or fid not in records or fid in blocked or fid in assigned:
                    raise BusinessError('VALIDATION_ERROR', '材料不可用或已分配，请核对分组。')
                role = records[fid]['role']
                if (role in ('payment', 'supporting') and field == 'invoiceFileIds'
                        or role == 'invoice' and field == 'attachmentFileIds'):
                    raise BusinessError('VALIDATION_ERROR', '请分别选择发票和补充附件。')
                if field == 'invoiceFileIds':
                    number = identity(records[fid]['facts'].get('invoiceNumber'))
                    if number and number in invoice_numbers:
                        raise BusinessError('VALIDATION_ERROR', '同一发票号码只能计入一次。')
                    if number:
                        invoice_numbers.add(number)
                assigned.add(fid)
        category_id = group.get('categoryId')
        if category_id is not None and (not isinstance(category_id, str) or category_id and category_id not in catalog):
            raise BusinessError('VALIDATION_ERROR', '该费用类型不适用于当前单据。')


def source_quotes(records, *fields):
    return [{'fileId': r['id'], 'quote': r['quotes'][field]} for r in records for field in fields
            if r['quotes'].get(field)]


def infer_category(records, kind, catalog):
    service_quotes = [r['facts']['service'] for r in records if r['facts'].get('service')]
    purpose = '\n'.join(values(records, 'purpose'))
    services = '\n'.join(service_quotes)
    category_id, broad, hint = classify_service(services, purpose, '', False)
    reception = bool(RECEPTION.search(purpose) and not NON_RECEPTION.search(purpose))
    # 用餐申请号可识别 OA 费用分支，但具体 OA 的可用状态仍需在报销系统核对。
    if broad == '餐饮' and len(values(records, 'mealOaNumber')) == 1 and not NON_RECEPTION.search(purpose):
        category_id, hint = 'reception-meal-oa', None
    candidates = set()
    if category_id == 'hotel':
        category_id = 'reception-hotel' if reception else ('other-hotel' if kind == 'personal' else 'hotel')
    if category_id:
        candidates.add(category_id)
    if re.search(r'纪念品|纪念礼品', services) and reception:
        candidates.add('reception-gift')
    # 其余“其他”项目仅按本单真实目录中的具体服务名称匹配。
    for cid, definition in catalog.items():
        if (cid.startswith('other-') and definition['template'] == 'T10'
                and definition['label'] and definition['label'] in services):
            candidates.add(cid)
    if hint in ('mixed', 'meal-purpose', 'meal-oa') or len(candidates) != 1:
        return '', broad
    selected = candidates.pop()
    return selected if selected in catalog else '', broad


BUSINESS_DATES = {
    'checkIn': ('date', r'入住|住宿开始'), 'checkOut': ('end', r'退房|离店|住宿结束'),
    'departureDate': ('date', r'出发|乘车|起飞|乘机|乘船|开车日期'),
    'arrivalDate': ('end', r'到达|抵达|落地'),
}


def fact_for_field(records, field, source):
    sources = records
    if source in BUSINESS_DATES and not values(records, source):
        source, label = BUSINESS_DATES[source]
        sources = [r for r in records if re.search(label, r['quotes'].get(source, ''))]
    found = values(sources, source)
    if len(found) > 1:
        return '', [], f'{LABELS.get(field, field)}在材料中不一致，请核对。'
    if not found:
        return '', [], ''
    return str(found[0]), source_quotes(sources, source), ''


def expense_transport(value, template, mode):
    if template == 'T02':
        for label, pattern in (('出租车', '出租|网约车'), ('地铁', '地铁'), ('公交车', '公交|公共汽车')):
            if re.search(pattern, value):
                return label
        return ''
    # 系统交通工具为“类别-席别/方式”。只把票面明示的席别映射进对应选项。
    details = {'火车': ('高级软卧', '高铁动卧', '特等座', '一等座', '二等座', '硬座', '软座', '硬卧', '软卧', '无座'),
               '飞机': ('经济舱', '自订机票'), '汽车': ('客车', '自驾车', '公司派车', '出租车'),
               '轮船': ('二等舱', '一等舱'), '其他': ('城际地铁', '免费搭车', '客户代订')}
    if value.startswith('其他-') or value in details['其他']:
        mode = '其他'
    for detail in details.get(mode, ()):
        if detail in value:
            return f'{mode}-{detail}'
    return ''


def assemble_group(assignment, records, draft, catalog):
    invoices = [records[fid] for fid in assignment['invoiceFileIds']]
    attachments = [records[fid] for fid in assignment.get('attachmentFileIds', [])]
    all_records = invoices + attachments
    gid = stable_id('receipt-expense', assignment['invoiceFileIds'])
    kind = draft_type(draft)
    inferred, broad = infer_category(all_records, kind, catalog)
    problems, evidence = [], {}
    for record in all_records:
        reading = record['file'].get('recognition') or {}
        for issue in reading.get('reviewIssues', []):
            if isinstance(issue, dict) and issue.get('message'):
                problems.append(issue['message'])
                field = issue.get('field')
                quote = reading.get('evidence', {}).get(field)
                if field and quote:
                    evidence.setdefault(field, []).append({'fileId': record['id'], 'quote': quote})

    def read(field, label=None):
        found = values(all_records, field)
        if len(found) == 1:
            return found[0]
        if len(found) > 1 and label:
            problems.append(f'{label}在材料中不一致，请核对。')
        return ''
    category_id = assignment.get('categoryId') or inferred
    route = {k: str(read(k)) for k in ('departureCity', 'arrivalCity', 'transport')}
    route['date'], _, date_conflict = fact_for_field(all_records, 'departureDate', 'departureDate')
    route['tripMode'] = transport_mode('\n'.join(values(all_records, 'service') + [route['transport']]))
    if category_id in ('other-long-distance', 'long-distance'):
        trip = match_trip(draft, route) if kind == 'expense' and not date_conflict else None
        if not assignment.get('categoryId'):
            category_id = 'long-distance' if trip and 'long-distance' in catalog else 'other-long-distance'
    else:
        trip = None
    definition = catalog.get(category_id, {})
    template = definition.get('template', '')
    if category_id in ('reception-meal', 'reception-meal-oa') and not attachments:
        problems.append('本笔餐饮招待尚未附消费凭证。')
    expense = {**dict.fromkeys(EXPENSE_FIELDS, ''), 'id': gid, 'categoryId': category_id,
               'group': 'travel' if kind == 'expense' else 'daily', 'generated': True,
               'sourceFileId': invoices[0]['id'], 'files': [attachment(r['file']) for r in invoices],
               'attachments': [attachment(r['file']) for r in attachments]}
    currencies = values(invoices, 'currency')
    if len(currencies) == 1:
        expense['currency'] = str(currencies[0])
        evidence['currency'] = source_quotes(invoices, 'currency')
    elif len(currencies) > 1:
        problems.append('发票币种不同，请拆分费用。')
    if category_id == 'long-distance' and trip:
        expense['tripId'] = trip
    evidence['categoryId'] = source_quotes(all_records, 'service', 'purpose')
    if values(all_records, 'mealOaNumber'):
        evidence['oaId'] = source_quotes(all_records, 'mealOaNumber')
        if category_id == 'reception-meal-oa':
            evidence['categoryId'] += evidence['oaId']

    total = invoice_total(invoices)
    if total is not None:
        expense['amount'] = f'{total // 100}.{total % 100:02d}'
        evidence['amount'] = source_quotes(invoices, 'amount')
        paid = [r['facts'].get('amount') for r in attachments if r['role'] == 'payment']
        if len(values(all_records, 'currency')) <= 1 and len(paid) == 1 and type(paid[0]) is int and paid[0] != total:
            problems.append('支付金额与发票合计不一致，请核对报销金额。')
    purpose = read('purpose', '实际用途')
    services = values(all_records, 'service')
    reason_sources = ('purpose',)
    if not purpose and not values(all_records, 'purpose'):
        if category_id in ('long-distance', 'other-long-distance') and route['departureCity'] and route['arrivalCity']:
            purpose = f"{route['departureCity']}至{route['arrivalCity']}交通费"
            reason_sources = ('departureCity', 'arrivalCity', 'service', 'category')
        elif category_id in ('hotel', 'other-hotel', 'reception-hotel') and read('city'):
            purpose = str(read('city')) + '住宿费'
            reason_sources = ('city', 'service', 'category')
        elif len(services) == 1:
            purpose = services[0]
            reason_sources = ('service',)
        elif definition:
            purpose = definition['label'] if inferred else ''
            reason_sources = ('category', 'service')
    if purpose:
        expense.update(reason=purpose, reasonOption='其他')
        evidence['reason'] = source_quotes(all_records, *reason_sources)
    expense['name'] = read('name') or read('merchant') or (services[0] if len(services) == 1 else '')
    field_map = {'date': 'date'}
    if template in ('T03', 'T09'):
        field_map = {k: k for k in ('checkIn', 'checkOut', 'city', 'rooms', 'coResidents')}
        if template == 'T03':
            field_map['rental'] = 'rental'
    elif template in ('T01', 'T08'):
        field_map = {'departureDate': 'departureDate', 'arrivalDate': 'arrivalDate', 'departureCity': 'departureCity',
                     'arrivalCity': 'arrivalCity', 'transport': 'transport'}
    elif template == 'T04':
        field_map.update(standard='standard', rooms='rooms', nights='nights', city='city')
    elif template in ('T05', 'T06', 'T07'):
        field_map.update(people='people')
        if template == 'T05':
            field_map['standard'] = 'standard'
        if template == 'T07':
            field_map['quantity'] = 'quantity'
    elif template == 'T02':
        field_map['transport'] = 'transport'
    for field, key in field_map.items():
        value, quotes, conflict = fact_for_field(all_records, field, key)
        if conflict:
            problems.append(conflict)
        if not value:
            continue
        if field in ('date', 'checkIn', 'checkOut', 'departureDate', 'arrivalDate') and not is_date(value):
            continue
        if field in ('rooms', 'people', 'nights', 'quantity') and not re.fullmatch(r'[1-9]\d{0,5}', str(value)):
            continue
        if field == 'rental' and value not in ('是', '否'):
            continue
        if field == 'transport':
            value = expense_transport(value, template, route['tripMode'])
            if not value:
                continue
        expense[field] = str(value)
        evidence[field] = quotes
    if template == 'T02' and not expense['transport'] and inferred == category_id and inferred in ('taxi', 'metro', 'bus'):
        expense['transport'] = {'taxi': '出租车', 'metro': '地铁', 'bus': '公交车'}[inferred]
        evidence['transport'] = evidence['categoryId']
    if template in ('T03', 'T09'):
        if expense['checkIn'] and expense['checkOut'] and expense['checkIn'] < expense['checkOut']:
            expense['nights'] = str((date.fromisoformat(expense['checkOut']) - date.fromisoformat(expense['checkIn'])).days)
        expense['aiCheckOut'] = expense['checkOut'] or None
    if not category_id:
        problems.append('请选择费用类型。' if broad != '餐饮' else '请核对用餐用途并选择费用类型。')
    missing = [LABELS.get(k, k) for k in definition.get('requiredFields', ('amount', 'reason')) if not expense.get(k)]
    if missing:
        problems.append('待补充' + '、'.join(missing) + '。')
    return {'id': gid, 'categoryId': assignment.get('categoryId') or '', 'invoiceFileIds': assignment['invoiceFileIds'], 'attachmentFileIds': assignment.get('attachmentFileIds', []),
            'expense': expense, 'issues': problems, 'evidence': {k: v for k, v in evidence.items() if v}}


def header_suggestion(groups, records, draft):
    reasons = list(dict.fromkeys(g['expense']['reason'] for g in groups if g['expense']['reason']))
    activities = []
    activity_names = values(records, 'activityName')
    if len(activity_names) == 1 and not values(records, 'purpose') and not any(activity_names[0] in r for r in reasons):
        reasons.insert(0, activity_names[0])
    if draft.get('activityMode') != 'hidden':
        numbers_by_name = defaultdict(set)
        for r in records:
            facts = r['facts']
            if facts.get('activityNumber') and facts.get('activityName'):
                numbers_by_name[facts['activityName']].add(facts['activityNumber'])
        indexed = defaultdict(list)
        for r in records:
            facts = r['facts']
            name = facts.get('activityName')
            key = facts.get('activityNumber')
            if not key and name:
                # 只有名称的附件仅在描述唯一对应活动号时补充该活动。
                numbers = numbers_by_name[name]
                if len(numbers) > 1:
                    continue
                key = next(iter(numbers), name)
            if key:
                indexed[key].append(r)
        for key, rows in indexed.items():
            activity = {**dict.fromkeys(ACTIVITY_FIELDS, ''), 'id': stable_id('receipt-activity', [str(key)]),
                        'source': 'receipt'}
            for dest, source in (('activityNumber', 'activityNumber'), ('description', 'activityName'),
                                 ('oaNumber', 'oaNumber'), ('effectiveDate', 'effectiveDate'), ('expiryDate', 'expiryDate')):
                found = values(rows, source)
                if len(found) == 1 and (dest not in ('effectiveDate', 'expiryDate') or is_date(found[0])):
                    activity[dest] = str(found[0])
            activities.append(activity)
    return {'purpose': '、'.join(reasons)[:500], 'activities': activities}


def build_reimbursement_batch(files, items, draft, categories, assignments=None):
    """返回可重算的分组与草稿建议。显式分组只接受文件标识、角色及目录内类型。"""
    kind = draft_type(draft)
    if kind not in ('expense', 'personal'):
        raise BusinessError('VALIDATION_ERROR', '请先选择差旅报销或个人费用报销单。')
    catalog = {c['id']: c for c in categories if kind in c.get('draftTypes', [])}
    records, blocked = receipt_records(files)
    if assignments is None:
        assignments = auto_assign([r for fid, r in records.items() if fid not in blocked])
    validate_assignments(assignments, records, blocked, catalog)
    groups = [assemble_group(a, records, draft, catalog) for a in assignments]
    # 同批两张票同时命中同一行程，不按文件顺序抢占行程。
    trips = defaultdict(list)
    for idx, group in enumerate(groups):
        if group['expense']['tripId']:
            trips[group['expense']['tripId']].append(idx)
    for indices in trips.values():
        if len(indices) > 1:
            for idx in indices:
                if assignments[idx].get('categoryId') == 'long-distance':
                    groups[idx]['expense']['tripId'] = ''
                else:
                    groups[idx] = assemble_group({**assignments[idx], 'categoryId': 'other-long-distance'}, records, draft, catalog)
                    groups[idx]['categoryId'] = ''
                groups[idx]['issues'].append('多笔费用匹配同一行程，请核对。')
    used = {fid for g in groups for fid in g['invoiceFileIds'] + g['attachmentFileIds']}
    reasons = {fid: blocked.get(fid, '请确认材料类型和所属费用。' if r['role'] == 'unknown' else '请确认这份材料属于哪笔费用。')
               for fid, r in records.items() if fid not in used}
    return {'groups': groups, 'unassignedFileIds': list(reasons), 'unassignedReasons': reasons,
            'unavailableFileIds': list(blocked),
            'header': header_suggestion(groups, [r for fid, r in records.items() if fid in used], draft)}
