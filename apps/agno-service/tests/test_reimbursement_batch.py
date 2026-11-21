import json
from pathlib import Path

import pytest

from business import BusinessError
from reimbursement_batch import build_reimbursement_batch


CATEGORIES = json.loads(Path(__file__).parents[1].joinpath('seed.json').read_text())['data']['expenseCategories']
DRAFT = {'id': 'personal-123', 'type': 'personal', 'expenses': [], 'legs': [], 'activityMode': 'optional'}


def receipt(fid, role='invoice', **facts):
    return {'id': fid, 'name': fid + '.png', 'type': 'image/png', 'size': 256, 'status': 'recognized',
            'recognition': {'role': role, 'facts': facts,
                            'evidence': {'role': role, **{k: f'{k}: {v}' for k, v in facts.items()}}}}


def preview(files, groups=None, draft=DRAFT, items=()):
    return build_reimbursement_batch(files, items, draft, CATEGORIES, groups)


def test_multi_invoice_one_meal_one_payment_and_unrelated_expense():
    meal = dict(orderId='W77', merchant='东湖餐厅', service='餐饮服务', currency='CNY')
    f1 = receipt('i1', **meal, invoiceNumber='5581', amount=8000)
    f2 = receipt('i2', **meal, invoiceNumber='5582', amount=1000)
    p = receipt('pay', 'payment', merchant='东湖餐厅', orderId='W77', date='2026-11-17', amount=9000,
                purpose='与客户商讨交付事宜的业务招待', people='4', standard='100元/人',
                activityName='验收交流', activityNumber='A123', oaNumber='OA01', effectiveDate='2026-11-01')
    taxi = receipt('taxi', service='出租车费', date='2026-11-15', amount=3580, currency='CNY')
    result = preview([p, f1, f2, taxi])
    assert result['unassignedFileIds'] == []
    meal, ride = [g['expense'] for g in result['groups']]
    assert [x['id'] for x in meal['files']] == ['i1', 'i2']
    assert [x['id'] for x in meal['attachments']] == ['pay']
    assert (meal['amount'], ride['amount']) == ('90.00', '35.80')
    assert (meal['categoryId'], meal['people'], meal['standard']) == ('reception-meal', '4', '100元/人')
    assert meal['date'] == '2026-11-17' and ride['categoryId'] == 'taxi' and ride['transport'] == '出租车'
    assert result['groups'][0]['evidence']['people'][0]['fileId'] == 'pay'
    assert meal['oaId'] == ''
    assert result['header']['activities'][0]['activityNumber'] == 'A123'
    assert result['header']['activities'][0]['expiryDate'] == ''
    assert '客户商讨交付事宜' in result['header']['purpose']
    assert result['groups'][0]['id'] == preview([f2, f1])['groups'][0]['id']


def test_unique_split_payment_requires_date_and_no_conflicting_orders():
    common = dict(merchant='商户', date='2026-11-08', currency='CNY')
    a = receipt('a', **common, amount=1200)
    b = receipt('b', **common, amount=3500)
    p = receipt('p', 'payment', **common, amount=4700)
    batch = preview([a, b, p])
    assert len(batch['groups']) == 1
    assert batch['groups'][0]['expense']['amount'] == '47.00'
    assert batch['groups'][0]['attachmentFileIds'] == ['p']
    b['recognition']['facts']['date'] = '2026-11-10'
    assert preview([a, b, p])['unassignedFileIds'] == ['p']


def test_same_category_same_shop_and_amount_do_not_merge_ambiguously():
    common = dict(service='餐饮服务', merchant='同一商户', date='2026-11-14', currency='CNY', amount=3200)
    a, b = receipt('a', **common), receipt('b', **common)
    pay = receipt('p', 'payment', **common, purpose='客户接待用餐')
    batch = preview([a, b, pay])
    assert len(batch['groups']) == 2
    assert batch['unassignedFileIds'] == ['p']
    assert not batch['unavailableFileIds']
    assert all(g['expense']['categoryId'] == '' for g in batch['groups'])
    assert '客户接待' not in batch['header']['purpose']
    adjusted = preview([a, b, pay], [{'invoiceFileIds': ['a'], 'attachmentFileIds': ['p']},
                                     {'invoiceFileIds': ['b'], 'categoryId': 'reception-meal-oa'}])
    assert adjusted['groups'][0]['expense']['categoryId'] == 'reception-meal'
    assert adjusted['groups'][1]['categoryId'] == 'reception-meal-oa'
    assert adjusted['groups'][1]['expense']['oaId'] == ''
    assert adjusted['groups'][0]['expense']['amount'] == '32.00'


def test_missing_amount_not_partially_summed_and_no_payment_fallback():
    batch = preview([receipt('a', orderId='o1', amount=800), receipt('b', orderId='o1'),
                     receipt('p', 'payment', orderId='o1', amount=1800)])
    expense = batch['groups'][0]['expense']
    assert expense['amount'] == expense['currency'] == ''
    assert len(expense['files']) == 2
    assert expense['reason'] == '' and batch['header']['purpose'] == ''


def test_duplicate_source_number_unreadable_pdf_multiple_documents_and_legacy():
    a = receipt('a', invoiceNumber='1', amount=800)
    b = receipt('b', invoiceNumber='1', amount=800)
    c = receipt('c')
    c['recognition']['multipleDocuments'] = True
    d = receipt('d')
    d['status'] = 'failed'
    old = {'id': 'old', 'name': '发票.png', 'status': 'recognized'}
    old_rows = [{'sourceFileId': 'old', 'amount': 999999, 'evidence': {'amount': '人工编辑'}}]
    out = preview([a, b, c, d, old], items=old_rows)
    assert len(out['groups']) == 1
    assert out['unavailableFileIds'] == ['b', 'c', 'd', 'old']
    with pytest.raises(BusinessError):
        preview([a, b], [{'invoiceFileIds': ['b']}])


def test_invoices_use_ocr_facts_only_even_if_material_item_edited():
    f = receipt('invoice', invoiceNumber='110')
    row = {'sourceFileId': 'invoice', 'amount': 999999, 'purpose': '编造事由', 'categoryId': 'taxi',
           'evidence': {'amount': '0.01', 'purpose': '篡改', 'category': '出租车'}}
    expense = preview([f], items=[row])['groups'][0]['expense']
    assert expense['amount'] == expense['reason'] == expense['categoryId'] == ''


def test_hotel_fields_do_not_use_invoice_date_or_payment_date_or_guess_rental():
    f = receipt('a', service='住宿服务', invoiceDate='2026-11-14', orderId='h27', amount=53000, city='杭州')
    p = receipt('p', 'payment', orderId='h27', date='2026-11-14', amount=53000)
    out = preview([f, p])['groups'][0]['expense']
    assert out['categoryId'] == 'other-hotel'
    assert out['checkIn'] == out['checkOut'] == ''
    detail = receipt('bill', 'supporting', orderId='h27', checkIn='2026-11-09', checkOut='2026-11-11', rooms='2')
    expense = preview([f, p, detail], draft={**DRAFT, 'type': 'expense'})['groups'][0]['expense']
    assert (expense['checkIn'], expense['checkOut'], expense['rooms'], expense['nights']) == ('2026-11-09', '2026-11-11', '2', '2')
    assert expense['rental'] == '' and expense['categoryId'] == 'hotel'


def test_multiple_currencies_leave_amount_blank():
    a = receipt('a', orderId='x', currency='CNY', amount=3000)
    b = receipt('b', orderId='x', currency='USD', amount=1000)
    batch = preview([a, b], [{'invoiceFileIds': ['a', 'b']}])
    group = batch['groups'][0]
    assert group['expense']['amount'] == group['expense']['currency'] == ''
    assert any('币种不同' in issue for issue in group['issues'])


def test_field_conflicts_and_missing_citations_do_not_produce_facts():
    a = receipt('a', orderId='o', service='餐饮服务', amount=3000, purpose='客户接待', people='2')
    b = receipt('b', 'supporting', orderId='o', people='4', standard='500元/人')
    del b['recognition']['evidence']['standard']
    g = preview([a, b])['groups'][0]
    assert g['expense']['people'] == g['expense']['standard'] == ''
    assert any('不一致' in issue for issue in g['issues'])


def test_payment_is_never_invoice_and_no_double_assignment():
    a, p = receipt('a', service='餐饮服务', amount=300), receipt('p', 'payment', amount=300)
    for assignment in ([{'invoiceFileIds': ['p']}], [{'invoiceFileIds': ['a', 'a']}],
                       [{'invoiceFileIds': ['unknown']}], [{'attachmentFileIds': ['p']}],
                       [{'invoiceFileIds': ['a'], 'categoryId': 'long-distance'}]):
        with pytest.raises(BusinessError):
            preview([a, p], assignment)
    assert preview([p])['groups'] == []
    unknown = receipt('u', 'unknown', amount=1050)
    assert preview([unknown])['groups'] == []
    assert preview([unknown], [{'invoiceFileIds': ['u']}])['groups'][0]['expense']['amount'] == '10.50'


def test_available_trip_requires_matching_date_and_is_not_claimed_by_two_groups():
    rail = dict(service='铁路电子客票', departureDate='2026-11-09', departureCity='杭州', arrivalCity='上海', amount=2900)
    leg = {'id': 'L9', 'departureCity': '杭州', 'arrivalCity': '上海', 'departureDate': '2026-11-09', 'transport': '火车-二等座'}
    draft = {**DRAFT, 'type': 'expense', 'legs': [leg]}
    f = receipt('train1', **rail)
    g = preview([f], draft=draft)['groups'][0]
    assert (g['expense']['categoryId'], g['expense']['tripId']) == ('long-distance', 'L9')
    together = preview([f, receipt('train2', **rail)], draft=draft)
    assert all(x['expense']['categoryId'] == 'other-long-distance' for x in together['groups'])
    assert all(x['expense']['departureDate'] == '2026-11-09' for x in together['groups'])


def test_activities_only_from_assigned_materials_and_visible_activity_section():
    a = receipt('a', service='餐饮服务')
    p = receipt('p', 'supporting', activityName='客户验收', activityNumber='ACT-002')
    assert preview([a, p])['header']['activities'] == []
    assigned = [{'invoiceFileIds': ['a'], 'attachmentFileIds': ['p']}]
    assert preview([a, p], assigned, {**DRAFT, 'activityMode': 'hidden'})['header']['activities'] == []


def test_explicit_meal_oa_selects_type_but_preserves_unverified_number_as_evidence():
    a = receipt('a', service='餐饮服务', orderId='O12')
    p = receipt('p', 'supporting', orderId='O12', mealOaNumber='OA-789',
                purpose='项目验收客户接待', people='4')
    g = preview([a, p])['groups'][0]
    assert g['expense']['categoryId'] == 'reception-meal-oa'
    assert g['expense']['oaId'] == ''
    assert g['evidence']['oaId'] == [{'fileId': 'p', 'quote': 'mealOaNumber: OA-789'}]


def test_invoice_with_conflicting_explicit_number_cannot_attach_via_order_or_amount():
    common = dict(orderId='s42', merchant='商户', amount=2900)
    a = receipt('invoice', invoiceNumber='foo', **common)
    b = receipt('receipt', 'payment', invoiceNumber='bar', **common)
    assert preview([a, b])['unassignedFileIds'] == ['receipt']


def test_same_order_for_different_services_requires_separate_expenses():
    a = receipt('a', orderId='same-order', service='住宿费', amount=2900)
    b = receipt('b', orderId='same-order', service='餐饮服务', amount=3100)
    p = receipt('p', 'payment', orderId='same-order', amount=6000)
    r = preview([a, b, p])
    assert len(r['groups']) == 2 and r['unassignedFileIds'] == ['p']


def test_activity_name_can_fill_header_and_enrich_matching_activity_once():
    a = receipt('a', orderId='X', service='会议费', activityName='项目验收', activityNumber='A001')
    p = receipt('p', 'supporting', orderId='X', activityName='项目验收', effectiveDate='2026-11-02')
    header = preview([a, p])['header']
    assert '项目验收' in header['purpose']
    assert [row['activityNumber'] for row in header['activities']] == ['A001']
    assert header['activities'][0]['effectiveDate'] == '2026-11-02'


def test_unknown_role_manually_identified_as_invoice_still_cannot_double_bill():
    a = receipt('normal', invoiceNumber='A999', amount=2000)
    b = receipt('unknown', 'unknown', invoiceNumber='A999', amount=2000)
    with pytest.raises(BusinessError, match='同一发票号码'):
        preview([a, b], [{'invoiceFileIds': ['normal']}, {'invoiceFileIds': ['unknown']}])


def test_cited_zero_is_not_a_missing_amount():
    assert preview([receipt('free', amount=0)])['groups'][0]['expense']['amount'] == '0.00'


def test_fields_exposed_by_travel_and_personal_lodging_templates_are_filled():
    rail = receipt('rail', service='铁路电子客票', departureDate='2026-11-09', departureCity='杭州',
                   arrivalCity='上海', transport='高铁二等座', amount=2900)
    leg = {'id': 'L9', 'departureCity': '杭州', 'arrivalCity': '上海', 'departureDate': '2026-11-09', 'transport': '火车-二等座'}
    group = preview([rail], draft={**DRAFT, 'type': 'expense', 'legs': [leg]})['groups'][0]['expense']
    assert (group['tripId'], group['departureCity'], group['departureDate'], group['transport']) == (
        'L9', '杭州', '2026-11-09', '火车-二等座')
    hotel = receipt('h', service='住宿费', rooms='2', coResidents='张某')
    expense = preview([hotel])['groups'][0]['expense']
    assert expense['rooms'] == '2' and expense['coResidents'] == '张某'


def test_unreliable_invoice_number_is_shown_only_as_warning_and_evidence():
    f = receipt('doc', amount=600)
    f['recognition'].update(reviewIssues=[{'field': 'invoiceNumber', 'message': '票面发票号码不完整，请核对原件。'}])
    f['recognition']['evidence']['invoiceNumber'] = '发票号：1234'
    group = preview([f])['groups'][0]
    assert any('发票号码不完整' in issue for issue in group['issues'])
    assert group['evidence']['invoiceNumber'][0]['fileId'] == 'doc'
