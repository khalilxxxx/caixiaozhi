"""规则迁移的数据保护与目录契约。"""
from copy import deepcopy
import json
from pathlib import Path

from rule_catalog import demo_cases, demo_rules, migrate_rules

SERVICE = Path(__file__).resolve().parents[1]


def seeded():
    return json.loads((SERVICE / 'seed.json').read_text())['data']


def test_demo_catalog_has_complete_editable_personal_rules_and_isolated_copies():
    rules = demo_rules()
    assert len(rules) == len({rule['id'] for rule in rules}) == 6
    for rule in rules:
        assert rule['metric'] == 'semantic'
        assert rule['origin'] == 'personal' and rule['effect'] == 'warn'
        assert rule['enabled'] is True and rule['scope'] == 'both'
        assert rule['version'] == 1 and rule['stage'] == 'published'
        assert rule['source'] == '场景示例'
        assert rule['documentTypes'] == (['travel'] if rule['system'] == 'oa' else ['expense', 'personal'])
        assert set(rule['requiredFields']) <= {'purpose', 'expenses', 'legs', 'activities', 'files', 'days', 'amountCents', 'mealCents', 'hotelNightCents', 'invoiceUnique', 'attachment'}
        for field in ('instruction', 'logic', 'description', 'evidence', 'output', 'missing', 'revisions', 'applicability', 'updatedAt'):
            assert rule[field]
    rules[0]['requiredFields'].clear()
    assert demo_rules()[0]['requiredFields']


def test_synthetic_cases_have_three_scenarios_per_rule_and_no_embedded_verdict():
    cases = demo_cases()
    assert len(cases) == len({case['id'] for case in cases}) == 18
    for rule in demo_rules():
        selected = [case for case in cases if case['ruleId'] == rule['id']]
        assert {case['scenario'] for case in selected} == {'hit', 'clear', 'unknown'}
        for case in selected:
            assert case['system'] == rule['system']
            assert case['documentType'] in rule['documentTypes']
            assert '合成' in case['name']
            assert not any(word in json.dumps(case['document']) for word in ('expected', 'MATCHED', 'INSUFFICIENT_EVIDENCE'))
    assert '未点高档酒水' in next(case for case in cases if case['id'] == 'SEM-EXPENSE-001-clear')['document']['expenses'][0]['reason']


def test_migration_preserves_useful_rule_values_drafts_history_and_snapshots():
    data = seeded()
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        rules = data[key]['rules']
        next(rule for rule in rules if rule['id'] == 'R002').update(enabled=False, thresholdMinor=75000, version=8, custom={'a': 1})
        next(rule for rule in rules if rule['id'] == 'P001').update(thresholdMinor=123400, version=6)
        rules.append({'id': 'my-rule', 'name': '自建', 'metric': 'semantic', 'instruction': '自定义', 'enabled': False, 'custom': ['keep']})
    data['srsRuleCenterV1']['drafts'] = {'my-rule': {'text': '草稿', 'generated': None}}
    data['srsRuleCenterV1']['editingId'] = 'my-rule'
    data['submissions']['checks'] = {'travel': {'canSubmit': True}, 'personal': {'canSubmit': True}}
    data['rulesSubmission']['reviewedAt'] = {'oa': '已检查', 'expense': '已检查', 'custom': '保留'}
    before = deepcopy(data)
    assert migrate_rules(data)
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        for original in before[key]['rules']:
            current = next(rule for rule in data[key]['rules'] if rule['id'] == original['id'])
            if original['id'] != 'R005':
                assert current == original
        migrated = next(rule for rule in data[key]['rules'] if rule['id'] == 'R005')
        assert migrated['enabled'] is False and migrated['version'] == 2
        assert [revision['version'] for revision in migrated['revisions']][-2:] == [1, 2]
        assert '所有差旅申请' in migrated['revisions'][-1]['summary']
        assert data['ruleMigration']['originals'][key] == before[key]['rules']
    assert data['submissions']['checks'] == {}
    assert data['rulesSubmission']['reviewedAt'] == {'oa': '', 'expense': '', 'custom': '保留'}
    assert data['rulesSubmission']['reviewedRules'] == before['rulesSubmission']['reviewedRules']
    assert data['srsRuleCenterV1']['drafts'] == before['srsRuleCenterV1']['drafts']
    assert data['srsRuleCenterV1']['editingId'] == 'my-rule'
    for field in ('auditDocuments', 'receipts'):
        assert data.get(field) == before.get(field)
    assert all(rule['metric'] != 'validInvoice' for rule in data['rulesSubmission']['rules'])


def test_migration_is_idempotent_and_does_not_restore_user_deleted_or_edited_examples():
    data = seeded()
    assert migrate_rules(data)
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        next(rule for rule in data[key]['rules'] if rule['id'] == 'SEM-TRAVEL-001').update(enabled=False, instruction='用户修改', version=4)
        data[key]['rules'] = [rule for rule in data[key]['rules'] if rule['id'] != 'SEM-EXPENSE-003']
    data['submissions']['checks'] = {'new': {'result': '用户后来检查'}}
    before = deepcopy(data)
    assert migrate_rules(data) is False
    assert data == before


def test_existing_example_id_never_overwritten_and_other_slice_receives_missing_examples():
    data = seeded()
    custom = {'id': 'SEM-TRAVEL-001', 'name': '自定义同ID', 'instruction': '自定义逻辑', 'enabled': False, 'version': 12}
    data['rulesSubmission']['rules'].append(deepcopy(custom))
    assert migrate_rules(data)
    assert next(rule for rule in data['rulesSubmission']['rules'] if rule['id'] == custom['id']) == custom
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        ids = [rule['id'] for rule in data[key]['rules']]
        assert len(ids) == len(set(ids))
        assert set(rule['id'] for rule in demo_rules()) <= set(ids)


def test_substantially_modified_oa_attachment_rule_not_disabled_in_either_slice():
    data = seeded()
    rule = next(rule for rule in data['srsRuleCenterV1']['rules'] if rule['id'] == 'R005')
    rule.update(logic='仅国际签证申请需要邀请函。', version=5)
    before = {key: deepcopy(next(rule for rule in data[key]['rules'] if rule['id'] == 'R005')) for key in ('rulesSubmission', 'srsRuleCenterV1')}
    assert migrate_rules(data)
    for key, original in before.items():
        assert next(rule for rule in data[key]['rules'] if rule['id'] == 'R005') == original
    decision = next(item for item in data['ruleMigration']['decisions'] if item['id'] == 'R005')
    assert decision['action'] == 'preserved'


def test_partial_empty_seed_does_not_inject_catalog_or_migration_record():
    for data in ({}, {'rulesSubmission': {}}, {'rulesSubmission': {'rules': []}}, {'rulesSubmission': {'rules': []}, 'srsRuleCenterV1': {}}):
        before = deepcopy(data)
        assert migrate_rules(data) is False
        assert data == before


def test_empty_rule_lists_are_not_a_runtime_workspace():
    data = {'rulesSubmission': {'rules': []}, 'srsRuleCenterV1': {'rules': []}}
    before = deepcopy(data)
    assert migrate_rules(data) is False
    assert data == before


def test_minimum_required_fields_do_not_force_optional_attachments_or_activities():
    rules = {rule['id']: rule for rule in demo_rules()}
    for rule_id in ('SEM-TRAVEL-001', 'SEM-TRAVEL-002', 'SEM-EXPENSE-001'):
        assert rules[rule_id]['requiredFields'] == ['purpose']
    for rule_id in ('SEM-EXPENSE-002', 'SEM-EXPENSE-003'):
        assert rules[rule_id]['requiredFields'] == ['purpose', 'expenses']
    assert '计划安排' in rules['SEM-EXPENSE-001']['instruction']
    high_end = [case for case in demo_cases() if case['ruleId'] == 'SEM-EXPENSE-001']
    assert all(case['document'].get('purpose') for case in high_end)
    assert '计划安排高档白酒' in next(case for case in high_end if case['scenario'] == 'hit')['document']['purpose']


def test_v1_upgrade_preserves_original_snapshots_and_any_edited_default_rule():
    from rule_catalog import _v1_demo_rules
    data = seeded()
    originals = {key: deepcopy(data[key]['rules']) for key in ('rulesSubmission', 'srsRuleCenterV1')}
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        data[key]['rules'].extend(_v1_demo_rules())
        next(rule for rule in data[key]['rules'] if rule['id'] == 'SEM-TRAVEL-002')['enabled'] = False
        next(rule for rule in data[key]['rules'] if rule['id'] == 'SEM-EXPENSE-003')['instruction'] = '用户编辑'
    data['ruleMigration'] = {'version': 1, 'at': '保留时间', 'originals': deepcopy(originals), 'decisions': []}
    data['submissions']['checks'] = {'old': {}}
    assert migrate_rules(data)
    assert data['ruleMigration']['version'] == 2
    assert data['ruleMigration']['at'] == '保留时间'
    assert data['ruleMigration']['originals'] == originals
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        rules = {rule['id']: rule for rule in data[key]['rules']}
        assert rules['SEM-EXPENSE-001']['requiredFields'] == ['purpose']
        assert rules['SEM-EXPENSE-001']['version'] == 2
        assert len(rules['SEM-EXPENSE-001']['revisions']) == 2
        assert rules['SEM-TRAVEL-002']['enabled'] is False
        assert rules['SEM-TRAVEL-002']['version'] == 1
        assert rules['SEM-EXPENSE-003']['instruction'] == '用户编辑'
    before = deepcopy(data)
    assert migrate_rules(data) is False
    assert data == before
