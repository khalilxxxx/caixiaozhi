"""同类草稿实例必须彼此隔离，保持历史编辑、校验和提交关联。"""
from copy import deepcopy

import pytest

from business import Business
from test_business import MemoryStore


@pytest.fixture
def business(tmp_path):
    return Business(MemoryStore())


def test_new_instance_preserves_old_saved_draft_unsaved_edit_and_check(business):
    old = business.update_draft('travel', {'purpose': '上海拜访'})['draft']
    business.validate_draft('travel')
    business.store.mutate(lambda s: s['data']['submissions']['edits'].update(
        travel={**deepcopy(old), 'purpose': '上海拜访，尚未保存的补充'}))
    before = business.store.get_state()['data']['submissions']

    created = business.new_draft('travel')
    fresh = created['draft']
    after = business.store.get_state()['data']['submissions']
    assert fresh['id'] != 'travel'
    assert fresh['type'] == 'travel'
    assert after['drafts']['travel'] == before['drafts']['travel']
    assert after['edits'] == before['edits']
    assert after['checks'] == before['checks']
    assert created['cards'][0]['id'] == fresh['id']


@pytest.mark.parametrize('kind', ['travel', 'expense', 'personal'])
def test_new_instance_has_no_seed_trip_materials_or_previous_business_fields(business, kind):
    business.update_draft(kind, {'purpose': '上海行程', 'applicationId': 'OLD-TR',
        'legs': [{'arrivalCity': '上海'}], 'companions': ['张伟'], 'files': [{'id': 'old'}]})
    fresh = business.new_draft(kind)['draft']
    assert fresh['id'] != kind
    assert fresh['version'] == 1
    assert fresh['status'] == 'draft'
    for key in ('purpose', 'applicationId'):
        assert fresh[key] == ''
    for key in ('legs', 'expenses', 'activities', 'files', 'materialIds', 'companions'):
        assert fresh[key] == []
    assert fresh['subsidyCents'] is None
    assert business.get_draft(fresh['id'])['draft'] == fresh
    assert business.new_draft(fresh['id'])['draft']['type'] == kind


def test_instance_update_validation_submission_and_receipt_use_real_id(business):
    fresh = business.new_draft('travel')['draft']
    id = fresh['id']
    invalid = business.validate_draft(id)
    assert not invalid['canSubmit']
    assert any(issue['path'] == 'legs' for issue in invalid['check']['issues'])
    draft = business.update_draft(id, {'purpose': '北京客户拜访', 'legs': [
        {'departureCity': '杭州', 'arrivalCity': '北京', 'departureDate': '2026-11-20', 'arrivalDate': '2026-11-20', 'transport': '高铁'},
        {'departureCity': '北京', 'arrivalCity': '杭州', 'departureDate': '2026-11-22', 'arrivalDate': '2026-11-22', 'transport': '高铁'},
    ]})['draft']
    assert business.validate_draft(id)['canSubmit']
    result = business.submit_draft(id, draft['version'], 'instance-submit')
    assert result['request']['draftId'] == id
    assert result['request']['snapshot']['id'] == id
    assert result['receipt']['draftId'] == id
    assert result['document']['typeId'] == 'travel_application'
    assert business.get_receipt(result['request']['id'])['receipt'] == result['receipt']
    assert business.get_draft('travel')['draft']['status'] == 'draft'
    assert business.get_draft(id)['draft']['status'] == 'awaiting_receipt'


def test_instance_uses_its_type_for_expense_categories_and_rules(business):
    fresh = business.new_draft('personal')['draft']
    result = business.get_draft(fresh['id'])
    assert result['expenseCategories']
    assert all('personal' in row['draftTypes'] for row in result['expenseCategories'])
    check = business.validate_draft(fresh['id'])['check']
    assert check['inputSnapshot']['documentType'] == 'personal'
    assert any(rule['metric'] == 'invoiceUnique' for rule in check['review']['applicable'])
