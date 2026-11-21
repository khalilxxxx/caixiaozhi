"""真实上传、材料提取与去除有效性查验的业务回归。"""
import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from business import Business, BusinessError, evaluate
from file_service import save_file
from store import Conflict, Store


def uploaded(store, tmp_path, text='办公用品 80.50元 2026-11-17 打印资料', name='费用.txt'):
    return save_file(store, tmp_path / 'uploads', name, 'text/plain', text.encode())


def proposal():
    return {'items': [{'name': '办公用品', 'category': '办公', 'amount': 8050,
        'date': '2026-11-17', 'purpose': '打印资料', 'group': 'daily',
        'evidence': {'name': '办公用品', 'category': '办公用品', 'amount': '80.50',
                     'date': '2026-11-17', 'purpose': '打印资料', 'group': '办公用品'}}]}


def mock_extractor(monkeypatch, data=None, error=None, before_result=None):
    import agno.agent
    import agent_runtime
    class FakeAgent:
        def __init__(self, **kwargs):
            self.schema = kwargs['output_schema']
        async def arun(self, text):
            if before_result:
                before_result()
            if error:
                raise error
            return SimpleNamespace(content=self.schema.model_validate(data))
    monkeypatch.setattr(agno.agent, 'Agent', FakeAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())


def extract(store, ids, **kwargs):
    from material_service import extract_materials
    return asyncio.run(extract_materials(store, ids, **kwargs))


@pytest.mark.parametrize(('service', 'category_id', 'hint'), [
    ('出租车发票', 'taxi', None),
    ('地铁乘车费', 'metro', None),
    ('公交车票', 'bus', None),
    ('停车费', 'other-parking', None),
    ('车辆充电费', 'other-charging', None),
    ('汽油费', 'other-fuel', None),
    ('办公用品', 'other-office', None),
    ('快递服务费', 'other-express', None),
    ('签证办理费', 'other-visa', None),
    ('手机话费充值', 'other-telecom', None),
    ('宽带服务费', 'other-network', None),
    ('入场券', 'reception-ticket', None),
    ('餐饮服务', None, 'meal-purpose'),
    ('餐饮服务，实际用途：客户招待', 'reception-meal', None),
    ('餐饮服务，客户招待，OA申请', None, 'meal-oa'),
    ('销售方：某某酒店', None, 'unclear'),
    ('停车费、餐饮服务', None, 'mixed'),
    ('铁路电子客票、机票', None, 'mixed'),
])
def test_material_category_requires_a_unique_supported_service(tmp_path, monkeypatch, service, category_id, hint):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text=f'服务项目：{service}\n合计：80.50元')
    data = proposal()
    line = data['items'][0]
    line['evidence'].update(category=service, amount='80.50元')
    # A copied excerpt is not proof of the coarse type suggested by the model.
    line['category'] = '办公'
    mock_extractor(monkeypatch, data)
    item = extract(store, [file['id']])['items'][0]
    assert item['categoryId'] == category_id
    assert item.get('categoryHint') == hint
    assert item['amount'] == 8050


def test_short_model_quotes_cannot_use_seller_opening_date_or_tax_as_expense_fields(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    text = '销售方：某某出租车有限公司\n开票日期：2026-11-17\n税额：80.50元\n价税合计：180.50元'
    file = uploaded(store, tmp_path, text=text)
    data = proposal()
    data['items'][0]['evidence'].update(category='出租车', amount='80.50元')
    mock_extractor(monkeypatch, data)
    item = extract(store, [file['id']])['items'][0]
    assert item['categoryId'] is None
    assert item['date'] == ''
    assert item['amount'] is None


@pytest.mark.parametrize(('draft_id', 'alternatives', 'expected'), [
    ('expense', [], ('long-distance', 'matched')),
    ('expense', ['汽车-客车'], ('long-distance', 'matched')),
    ('expense', ['火车-一等座'], ('other-long-distance', None)),
    ('other-expense', [], ('other-long-distance', None)),
    ('flight-expense', [], ('other-long-distance', None)),
    ('personal', [], ('other-long-distance', None)),
    (None, [], ('other-long-distance', None)),
])
def test_train_suggestion_uses_only_unique_available_legs_from_current_draft(
    tmp_path, monkeypatch, draft_id, alternatives, expected,
):
    store = Store(tmp_path / 'test.db')
    route = '上海至杭州'
    text = f'铁路电子客票\n{route}\n乘车日期：2026-11-17\n票款合计：80.50元'
    file = uploaded(store, tmp_path, text=text)
    data = proposal()
    line = data['items'][0]
    line.update(category='交通', departureCity='上海', arrivalCity='杭州')
    line['evidence'].update(category='铁路电子客票', date='乘车日期：2026-11-17',
                            departureCity=route, arrivalCity=route, amount='80.50元')
    mock_extractor(monkeypatch, data)

    def add_drafts(state):
        submissions = state['data']['submissions']
        leg = {'id': 'matched', 'departureCity': '上海市', 'arrivalCity': '杭州',
               'departureDate': '2026-11-17', 'transport': '火车-二等座'}
        draft = submissions['drafts']['expense']
        submissions.setdefault('edits', {})['expense'] = {
            **draft, 'legs': [
                leg,
                {**leg, 'id': 'used'},
                *[{**leg, 'id': f'alt-{index}', 'transport': transport}
                  for index, transport in enumerate(alternatives)],
            ], 'expenses': [{'id': 'existing', 'tripId': 'used'}],
        }
        submissions['drafts']['other-expense'] = {
            **draft, 'id': 'other-expense', 'type': 'expense',
            'legs': [{**leg, 'departureDate': '2026-11-18'}],
        }
        submissions['drafts']['flight-expense'] = {
            **draft, 'id': 'flight-expense', 'type': 'expense',
            'legs': [{**leg, 'transport': '飞机-经济舱'}],
        }
    store.mutate(add_drafts)

    item = extract(store, [file['id']], draft_id=draft_id)['items'][0]
    assert (item['categoryId'], item.get('tripId')) == expected
    assert item['tripMode'] == '火车'
    assert item.get('matchedDraftId') == ('expense' if expected[1] else None)


def complete_personal(business, file, draft_id='personal'):
    return business.update_draft(draft_id, {'purpose': '办公采购', 'files': [file], 'expenses': [
        {'id': 'e', 'categoryId': 'other-office', 'currency': 'CNY', 'amount': '80.50',
         'reason': '打印资料', 'date': '2026-11-17', 'files': []}]})['draft']


def test_new_upload_can_submit_without_invoice_verification(tmp_path):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    business = Business(store)
    draft = complete_personal(business, file)
    result = business.validate_draft('personal')
    assert result['canSubmit'], result['check']
    assert all(rule['metric'] != 'validInvoice' for rule in result['check']['review']['passed'])
    submitted = business.submit_draft('personal', draft['version'], 'real-upload')
    assert submitted['receipt']['externalStatus'] == 'not_connected'
    next_id = business.new_draft('personal')['draft']['id']
    complete_personal(business, file, next_id)
    assert not business.validate_draft(next_id)['canSubmit']


def test_equal_uploaded_contents_cannot_be_reused_under_new_ids(tmp_path):
    store = Store(tmp_path / 'test.db')
    business = Business(store)
    first = uploaded(store, tmp_path)
    draft = complete_personal(business, first)
    business.submit_draft('personal', draft['version'], 'first')
    next_id = business.new_draft('personal')['draft']['id']
    second = uploaded(store, tmp_path, name='副本.txt')
    complete_personal(business, second, next_id)
    check = business.validate_draft(next_id)
    assert not check['canSubmit']
    assert any(f['rule']['metric'] == 'invoiceUnique' for f in check['check']['review']['findings'])


def test_legacy_rules_migrate_once_preserving_receipt_history(tmp_path):
    legacy = json.loads(Path(__file__).resolve().parents[1].joinpath('seed.json').read_text())
    invalid = {'id': 'R003', 'metric': 'validInvoice', 'origin': 'builtin', 'system': 'expense', 'enabled': True}
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        legacy['data'][key]['rules'].append(copy.deepcopy(invalid))
    legacy['data']['rulesSubmission']['reviewedRules'].append(copy.deepcopy(invalid))
    legacy['data']['rulesSubmission']['ruleForms']['R003'] = {'logic': '旧草稿'}
    legacy['data']['srsRuleCenterV1']['drafts']['R003'] = {'logic': '旧草稿'}
    legacy['data']['srsRuleCenterV1']['drafts']['personal-old'] = {'metric': 'validInvoice'}
    legacy['data']['srsRuleCenterV1']['editingId'] = 'R003'
    legacy['data']['submissions']['checks']['personal'] = {'review': {'passed': [invalid]}}
    history = {'id': 'history', 'snapshot': {'validInvoice': False}, 'check': {'rule': invalid}}
    legacy['data']['submissions']['requests'].append(history)
    legacy['data']['receipts']['history'] = {'status': 'accepted'}
    store = Store(tmp_path / 'old.db', legacy)
    state = store.get_state()['data']
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        assert all(r.get('metric') != 'validInvoice' for r in state[key]['rules'])
    assert state['rulesSubmission']['ruleForms'] == {}
    assert state['srsRuleCenterV1']['drafts'] == {}
    assert state['srsRuleCenterV1']['editingId'] is None
    assert state['submissions']['checks'] == {}
    assert state['submissions']['requests'][-1] == history
    assert state['receipts']['history'] == {'status': 'accepted'}
    assert Store(tmp_path / 'old.db').snapshot() == store.snapshot()


def test_removed_rule_cannot_be_created_or_executed(tmp_path):
    store = Store(tmp_path / 'test.db')
    invalid = {'id': 'new-validity', 'metric': 'validInvoice', 'system': 'expense', 'scope': 'both', 'enabled': True}
    with pytest.raises(Conflict):
        store.patch({'baseRevision': store.snapshot()['revision'], 'data': {'rulesSubmission': {'rules': [invalid]}}})
    assert evaluate({}, [invalid])['findings'] == []


def test_extract_persists_unconfirmed_source_fields_and_retains_seed(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    mock_extractor(monkeypatch, proposal())
    result = extract(store, [file['id']])
    item = result['items'][0]
    assert (item['amount'], item['category'], item['date'], item['purpose']) == (8050, '办公', '2026-11-17', '打印资料')
    assert item['sourceFileId'] == file['id']
    assert item['confirmed'] is False
    assert item['evidence']['amount'] == '80.50'
    assert result['cards'][0]['kind'] == 'materials'
    persisted = Store(tmp_path / 'test.db').get_state()['data']['materials']['items']
    assert any(row['id'] == item['id'] for row in persisted)
    assert any(row['id'] == 'rail' for row in persisted)


@pytest.mark.parametrize('ids', [[], ['missing'], ['file-x'] * 11, [1], 'file-x'])
def test_invalid_file_ids_have_no_material_side_effects(tmp_path, ids):
    store = Store(tmp_path / 'test.db')
    before = store.snapshot()
    with pytest.raises(BusinessError):
        extract(store, ids)
    assert store.snapshot() == before


def test_unreadable_or_failed_extraction_does_not_invent_items(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    image = uploaded(store, tmp_path, text='', name='扫描件.png')
    before = store.get_state()['data']['materials']['items']
    result = extract(store, [image['id']])
    assert result['items'] == []
    assert result['files'][0]['extractionError']
    text = uploaded(store, tmp_path)
    mock_extractor(monkeypatch, error=RuntimeError('provider unavailable'))
    result = extract(store, [text['id']])
    assert result['items'] == []
    assert result['files'][0]['extractionStatus'] == 'failed'
    assert store.get_state()['data']['materials']['items'] == before


def test_unknown_or_unsupported_fields_require_manual_completion(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    data = proposal()
    data['items'][0].update(name='虚构店名', amount=99900, purpose='未记载用途', date='2026-11-18', end='2026-11-19')
    data['items'][0]['evidence']['name'] = '虚构店名'
    data['items'][0]['evidence']['purpose'] = '未记载用途'
    data['items'][0]['evidence']['date'] = '2026-11-18'
    data['items'][0]['evidence']['amount'] = '80.50'
    mock_extractor(monkeypatch, data)
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] is None
    assert item['name'] == item['purpose'] == item['date'] == ''
    assert not item.get('end')
    assert {'name', 'amount', 'purpose', 'date'} <= set(item['issues'])
    assert item['confirmed'] is False


def test_repeat_extract_preserves_manual_changes_and_confirmation(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    mock_extractor(monkeypatch, proposal())
    first = extract(store, [file['id'], file['id']])['items'][0]
    def edit(state):
        item = next(row for row in state['data']['materials']['items'] if row['id'] == first['id'])
        item.update(purpose='人工补全用途', amount=10000, confirmed=True)
    store.mutate(edit)
    mock_extractor(monkeypatch, error=AssertionError('重复请求应直接读取已有条目'))
    second = extract(store, [file['id']])['items']
    assert len(second) == 1
    assert (second[0]['purpose'], second[0]['amount'], second[0]['confirmed']) == ('人工补全用途', 10000, True)


def test_concurrent_manual_edit_wins_over_inflight_extraction(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    manual = {**proposal()['items'][0], 'id': 'manual', 'sourceFileId': file['id'], 'confirmed': False, 'amount': 12300}
    mock_extractor(monkeypatch, proposal(), before_result=lambda: store.mutate(
        lambda state: state['data']['materials']['items'].append(manual)))
    result = extract(store, [file['id']])
    assert len(result['items']) == 1
    assert result['items'][0]['id'] == 'manual'
    assert result['items'][0]['amount'] == 12300


def test_numeric_evidence_cannot_be_a_substring_or_negative_amount(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text='办公用品 -80.50元 2026-11-17 打印资料')
    mock_extractor(monkeypatch, proposal())
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] is None
    assert 'amount' in item['issues']


def test_model_cannot_turn_non_rmb_into_rmb(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text='办公用品 USD 80.50 2026-11-17 打印资料')
    mock_extractor(monkeypatch, proposal())
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] is None
    assert 'amount' in item['issues']


def test_at_text_extraction_limit_requires_split_and_has_no_side_effects(tmp_path):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text='a' * 60001)
    before = store.snapshot()
    with pytest.raises(BusinessError):
        extract(store, [file['id']])
    assert store.snapshot() == before


def test_patch_does_not_restore_obsolete_rule_drafts_or_forge_tool_results(tmp_path):
    store = Store(tmp_path / 'test.db')
    store.mutate(lambda state: state['data'].update(toolResults={'real': {'amount': 123}}))
    store.patch({'baseRevision': store.snapshot()['revision'], 'data': {
        'toolResults': {'fake': {'amount': 1}},
        'srsRuleCenterV1': {'drafts': {'legacy': {'metric': 'validInvoice'}}, 'editingId': 'legacy'},
        'rulesSubmission': {'ruleForms': {'legacy': {'metric': 'validInvoice'}}},
    }})
    data = store.get_state()['data']
    assert data['toolResults'] == {'real': {'amount': 123}}
    assert data['srsRuleCenterV1']['drafts'] == {}
    assert data['srsRuleCenterV1']['editingId'] is None
    assert data['rulesSubmission']['ruleForms'] == {}


def test_model_response_supports_json_and_missing_fields(tmp_path, monkeypatch):
    import agno.agent
    import agent_runtime
    class JsonAgent:
        def __init__(self, **kwargs):
            pass
        async def arun(self, text):
            return SimpleNamespace(content=json.dumps({'items': [{'name': '办公用品', 'evidence': {'name': '办公用品'}}]}))
    monkeypatch.setattr(agno.agent, 'Agent', JsonAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    item = extract(store, [file['id']])['items'][0]
    assert item['name'] == '办公用品'
    assert item['category'] is item['group'] is item['amount'] is None
    assert set(item['issues']) == {'category', 'group', 'amount', 'date', 'purpose'}


def test_empty_model_result_and_partial_batch_failures_remain_explicit(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    empty = uploaded(store, tmp_path, text='', name='空白.pdf')
    before = store.get_state()['data']['materials']['items']
    mock_extractor(monkeypatch, {'items': []})
    result = extract(store, [file['id'], empty['id']])
    assert result['items'] == []
    assert {file['extractionStatus'] for file in result['files']} == {'needs_review', 'unreadable'}
    assert store.get_state()['data']['materials']['items'] == before


def test_unknown_file_in_valid_batch_rejects_entire_request(tmp_path):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path)
    before = store.snapshot()
    with pytest.raises(BusinessError):
        extract(store, [file['id'], 'missing'])
    assert store.snapshot() == before


def test_minus_separated_by_space_cannot_become_positive_expense(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text='办公用品 - 80.50元 2026-11-17 打印资料')
    mock_extractor(monkeypatch, proposal())
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] is None


def test_live_policy_migration_preserves_submitted_policy_snapshot(tmp_path):
    import sqlite3
    policy_text = '申请人需对费用真实性与归属负责。查验结果不明确的票据应补充核验。'
    legacy = json.loads(Path(__file__).resolve().parents[1].joinpath('seed.json').read_text())
    legacy['data']['policies'][0]['clauses'][0]['text'] = policy_text
    legacy['data']['submissions']['requests'].append({'id': 'history', 'snapshot': {'policy': policy_text}})
    path = tmp_path / 'old.sqlite'
    with sqlite3.connect(path) as db:
        db.execute('CREATE TABLE workspace (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)')
        db.execute('INSERT INTO workspace VALUES(1,17,?)', (json.dumps(legacy),))
    store = Store(path)
    data = store.get_state()['data']
    assert '由本人补充并核对' in data['policies'][0]['clauses'][0]['text']
    assert data['submissions']['requests'][-1]['snapshot']['policy'] == policy_text
    assert store.snapshot()['revision'] == 18
    assert Store(path).snapshot()['revision'] == 18


def test_csv_delimiters_allow_full_numeric_amount_evidence(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text='名称,金额,日期,用途\n办公用品,80.50,2026-11-17,打印资料\n', name='费用.csv')
    mock_extractor(monkeypatch, proposal())
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] == 8050


def test_thousands_amount_cannot_be_verified_with_partial_digits(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text='办公用品 1,080.50元 2026-11-17 打印资料')
    mock_extractor(monkeypatch, proposal())
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] is None


@pytest.mark.parametrize('quote', ['金额：80.50元', '80.50元', '人民币80.50元'])
def test_amount_evidence_accepts_single_amount_with_label_and_unit(tmp_path, monkeypatch, quote):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text=f'办公用品 {quote} 2026-11-17 打印资料')
    data = proposal()
    data['items'][0]['evidence']['amount'] = quote
    mock_extractor(monkeypatch, data)
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] == 8050
    assert item['evidence']['amount'] == quote


@pytest.mark.parametrize('quote', ['金额：80.50元，税额：1.00元', '金额：-80.50元', '金额：- 80.50元', 'USD 80.50', '金额80.50美元'])
def test_ambiguous_signed_or_foreign_amount_evidence_requires_manual_review(tmp_path, monkeypatch, quote):
    store = Store(tmp_path / 'test.db')
    file = uploaded(store, tmp_path, text=f'办公用品 {quote} 2026-11-17 打印资料')
    data = proposal()
    data['items'][0]['evidence']['amount'] = quote
    mock_extractor(monkeypatch, data)
    item = extract(store, [file['id']])['items'][0]
    assert item['amount'] is None
    assert 'amount' in item['issues']


def confirmed_multi_expense_file(store, tmp_path, monkeypatch, name='多项费用.txt'):
    text = '办公用品 80.50元 2026-11-17 打印资料\n办公用品 96.00元 2026-11-17 出差装订资料'
    file = uploaded(store, tmp_path, text=text, name=name)
    data = proposal()
    second = copy.deepcopy(data['items'][0])
    second.update(amount=9600, purpose='出差装订资料', group='travel')
    second['evidence'].update(amount='96.00', purpose='出差装订资料', group='出差')
    data['items'].append(second)
    mock_extractor(monkeypatch, data)
    items = extract(store, [file['id']])['items']
    store.mutate(lambda state: [item.update(confirmed=True) for item in state['data']['materials']['items'] if item['sourceFileId'] == file['id']])
    return file, items


def material_expense(item, file):
    return {'id': item['id'], 'categoryId': 'other-office', 'currency': 'CNY',
            'amount': f"{item['amount'] / 100:.2f}", 'reason': item['purpose'], 'date': item['date'],
            'sourceFileId': file['id'], 'files': [file]}


def test_distinct_confirmed_expenses_in_same_file_can_submit(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file, items = confirmed_multi_expense_file(store, tmp_path, monkeypatch)
    business = Business(store)
    draft = business.update_draft('personal', {'purpose': '办公采购', 'files': [file], 'expenses': [material_expense(item, file) for item in items]})['draft']
    check = business.validate_draft('personal')
    assert check['canSubmit'], check['check']
    receipt = business.submit_draft('personal', draft['version'], 'two-items')['receipt']
    assert receipt['status'] == 'accepted'


@pytest.mark.parametrize('second_draft_id', ['personal', 'expense'])
def test_distinct_confirmed_file_items_can_be_submitted_separately(tmp_path, monkeypatch, second_draft_id):
    store = Store(tmp_path / 'test.db')
    file, items = confirmed_multi_expense_file(store, tmp_path, monkeypatch)
    business = Business(store)
    first = business.update_draft('personal', {'purpose': '办公采购', 'files': [file], 'expenses': [material_expense(items[0], file)]})['draft']
    business.submit_draft('personal', first['version'], 'first-item')
    if second_draft_id == 'personal':
        second_draft_id = business.new_draft('personal')['draft']['id']
    patch = {'purpose': '出差资料', 'files': [file], 'expenses': [material_expense(items[1], file)]}
    if second_draft_id == 'expense':
        patch.update(applicationId='TA-20261113-015', legs=[
            {'departureCity': '杭州', 'arrivalCity': '上海', 'departureDate': '2026-11-17', 'arrivalDate': '2026-11-17', 'transport': '高铁'},
            {'departureCity': '上海', 'arrivalCity': '杭州', 'departureDate': '2026-11-18', 'arrivalDate': '2026-11-18', 'transport': '高铁'},
        ])
    second = business.update_draft(second_draft_id, patch)['draft']
    check = business.validate_draft(second_draft_id)
    assert check['canSubmit'], check['check']
    business.submit_draft(second_draft_id, second['version'], 'second-item')
    assert len(store.get_state()['data']['submissions']['requests']) == 2


def test_same_confirmed_material_item_repeated_in_one_draft_is_blocked(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file, items = confirmed_multi_expense_file(store, tmp_path, monkeypatch)
    expense = material_expense(items[0], file)
    business = Business(store)
    duplicate = {**expense, 'id': expense['id'] + '-duplicate'}
    business.update_draft('personal', {'purpose': '办公采购', 'files': [file], 'expenses': [expense, duplicate]})
    assert not business.validate_draft('personal')['canSubmit']


def test_same_confirmed_material_item_cannot_be_submitted_again(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    file, items = confirmed_multi_expense_file(store, tmp_path, monkeypatch)
    business = Business(store)
    patch = {'purpose': '办公采购', 'files': [file], 'expenses': [material_expense(items[0], file)]}
    first = business.update_draft('personal', patch)['draft']
    business.submit_draft('personal', first['version'], 'first-item')
    next_id = business.new_draft('personal')['draft']['id']
    business.update_draft(next_id, patch)
    assert not business.validate_draft(next_id)['canSubmit']


def test_renamed_duplicate_file_with_new_material_ids_cannot_bypass_history(tmp_path, monkeypatch):
    store = Store(tmp_path / 'test.db')
    first_file, first_items = confirmed_multi_expense_file(store, tmp_path, monkeypatch)
    business = Business(store)
    draft = business.update_draft('personal', {'purpose': '办公采购', 'files': [first_file], 'expenses': [material_expense(first_items[0], first_file)]})['draft']
    business.submit_draft('personal', draft['version'], 'original')
    second_file, second_items = confirmed_multi_expense_file(store, tmp_path, monkeypatch, name='换名副本.txt')
    next_id = business.new_draft('personal')['draft']['id']
    business.update_draft(next_id, {'purpose': '办公采购', 'files': [second_file], 'expenses': [material_expense(second_items[0], second_file)]})
    assert not business.validate_draft(next_id)['canSubmit']


@pytest.mark.parametrize('untrusted', ['unconfirmed', 'unknown-id'])
def test_multiple_shared_file_lines_need_confirmed_material_identity(tmp_path, monkeypatch, untrusted):
    store = Store(tmp_path / 'test.db')
    file, items = confirmed_multi_expense_file(store, tmp_path, monkeypatch)
    if untrusted == 'unconfirmed':
        store.mutate(lambda state: [item.update(confirmed=False) for item in state['data']['materials']['items'] if item['id'] == items[1]['id']])
    else:
        items[1]['id'] = 'arbitrary-expense-id'
    business = Business(store)
    business.update_draft('personal', {'purpose': '办公采购', 'files': [file], 'expenses': [material_expense(item, file) for item in items]})
    assert not business.validate_draft('personal')['canSubmit']
