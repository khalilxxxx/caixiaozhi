import copy
import json
from pathlib import Path

import pytest

from business import Business, BusinessError, rules_for, signature
from store import Store, Conflict


def semantic_rule(system='oa'):
    return {'id': 'test-semantic', 'name': '事由检查', 'metric': 'semantic',
            'system': system, 'scope': 'both', 'effect': 'warn', 'origin': 'personal',
            'enabled': True, 'version': 1, 'description': '事由涉及私人活动时提醒',
            'instruction': '事由涉及私人活动时命中，否定表述不命中。',
            'requiredFields': ['purpose'],
            'documentTypes': ['travel'] if system == 'oa' else ['expense', 'personal']}


class Evaluator:
    def __init__(self, callback=None):
        self.calls = []
        self.callback = callback

    def evaluate(self, document, rules):
        self.calls.append((copy.deepcopy(document), copy.deepcopy(rules)))
        if self.callback:
            self.callback()
        return {'status': 'attention', 'findings': [{
            'rule': rule, 'state': 'hit', 'actual': document['purpose'],
            'expected': rule['instruction'], 'detail': '事由明确涉及私人活动。',
            'engine': 'llm', 'evidence': [{'path': 'purpose', 'quote': document['purpose']}],
        } for rule in rules], 'passed': [], 'inapplicable': [], 'applicable': rules,
            'engine': 'llm', 'model': 'test-model'}


@pytest.fixture
def store(tmp_path):
    seed = json.loads(Path(__file__).resolve().parents[1].joinpath('seed.json').read_text())
    rule = semantic_rule()
    seed['data']['rulesSubmission']['rules'] = [rule]
    seed['data'].pop('srsRuleCenterV1', None)  # 此组只验证执行集成，不运行场景目录迁移。
    return Store(tmp_path / 'state.db', seed)


def travel(business):
    return business.update_draft('travel', {'purpose': '客户会议后安排私人游玩', 'legs': [
        {'id': 'go', 'departureCity': '杭州', 'arrivalCity': '上海', 'departureDate': '2026-11-19', 'arrivalDate': '2026-11-19', 'transport': '高铁'},
        {'id': 'back', 'departureCity': '上海', 'arrivalCity': '杭州', 'departureDate': '2026-11-20', 'arrivalDate': '2026-11-20', 'transport': '高铁'},
    ]})['draft']


def test_submission_uses_semantic_context_and_preserves_model_evidence(store):
    evaluator = Evaluator()
    business = Business(store, rule_service=evaluator)
    draft = travel(business)
    result = business.validate_draft('travel')
    assert evaluator.calls[0][0]['purpose'] == draft['purpose']
    assert evaluator.calls[0][0]['legs'][0]['arrivalCity'] == '上海'
    assert result['check']['review']['findings'][0]['evidence'][0]['quote'] == draft['purpose']
    assert result['canSubmit']  # 个人风险提醒不升级为拦截。
    business.submit_draft('travel', draft['version'], 'semantic-submit')
    assert len(evaluator.calls) == 1  # 同一快照的已检查结果可复用。


def test_edit_during_inference_rejects_stale_check_and_keeps_new_draft(store):
    def change():
        Business(store).update_draft('travel', {'purpose': '新的客户拜访事由'})
    business = Business(store, rule_service=Evaluator(change))
    travel(business)
    with pytest.raises(BusinessError, match='变化'):
        business.validate_draft('travel')
    assert store.get_state()['data']['submissions']['drafts']['travel']['purpose'] == '新的客户拜访事由'
    assert 'travel' not in store.get_state()['data']['submissions']['checks']


def test_rule_edit_during_inference_rejects_old_result(store):
    def change():
        store.mutate(lambda s: s['data']['rulesSubmission']['rules'][0].update(instruction='新的条件'))
    business = Business(store, rule_service=Evaluator(change))
    travel(business)
    with pytest.raises(BusinessError, match='变化'):
        business.validate_draft('travel')


def test_unavailable_semantic_model_is_unknown_not_pass(store):
    business = Business(store)
    travel(business)
    result = business.validate_draft('travel')
    assert result['check']['review']['status'] == 'unknown'
    assert not result['check']['review']['passed']
    assert result['canSubmit']


def test_preaudit_persists_authoritative_results_and_avoids_out_of_scope_leave(store):
    store.mutate(lambda s: s['data'].update(auditDocuments=[
        {'id': 'travel-doc', 'version': 1, 'system': 'oa', 'kind': '出差申请', 'purpose': '私人旅行'},
        {'id': 'leave-doc', 'version': 1, 'system': 'oa', 'kind': '请假申请', 'purpose': '年休假'},
    ]))
    evaluator = Evaluator()
    result = Business(store, rule_service=evaluator).preaudit('oa')
    assert len(evaluator.calls) == 1
    assert result['counts'] == {'attention': 1, 'unknown': 0, 'clear': 1}
    saved = store.get_state()['data']['rulesSubmission']['reviewResults']['travel-doc']
    assert saved['review']['findings'][0]['engine'] == 'llm'
    assert saved['documentVersion'] == 1
    assert saved['signature'] == signature(rules_for(store.get_state()['data'], scope='review', system='oa'))


def test_signature_covers_semantic_instruction_evidence_and_document_scope():
    rule = semantic_rule()
    original = signature([rule])
    for key, value in [('instruction', '新条件'), ('requiredFields', ['legs']), ('documentTypes', ['personal'])]:
        changed = copy.deepcopy(rule)
        changed[key] = value
        assert signature([changed]) != original


def test_browser_cannot_forge_model_results_or_personal_block(store):
    rule = semantic_rule()
    rule['effect'] = 'block'
    with pytest.raises(Conflict):
        store.patch({'baseRevision': store.snapshot()['revision'], 'data': {'rulesSubmission': {'rules': [rule]}}})
    before = store.get_state()['data']['rulesSubmission'].get('reviewResults')
    store.patch({'baseRevision': store.snapshot()['revision'], 'data': {'rulesSubmission': {'reviewResults': {'fake': {'review': {'status': 'clear'}}}}}})
    assert store.get_state()['data']['rulesSubmission'].get('reviewResults') == before


def test_cancelled_check_never_publishes_result(store):
    import asyncio
    business = Business(store, rule_service=Evaluator())
    travel(business)
    def cancelled():
        raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        business.validate_draft('travel', cancel_check=cancelled)
    assert 'travel' not in store.get_state()['data']['submissions']['checks']


def test_preaudit_rejects_document_change_during_model_call(store):
    store.mutate(lambda s: s['data'].update(auditDocuments=[
        {'id': 'travel-doc', 'version': 1, 'system': 'oa', 'kind': '出差申请', 'purpose': '私人旅行'},
    ]))
    def change():
        store.mutate(lambda s: s['data']['auditDocuments'][0].update(purpose='新的业务事由'))
    with pytest.raises(BusinessError, match='变化'):
        Business(store, rule_service=Evaluator(change)).preaudit('oa')
    assert not store.get_state()['data']['rulesSubmission'].get('reviewResults')


def test_saved_semantic_rule_keeps_conditions_and_cannot_overwrite_migration(store):
    rule = semantic_rule()
    store.patch({'baseRevision': store.snapshot()['revision'], 'data': {
        'rulesSubmission': {'rules': [rule]}, 'ruleMigration': {'version': 999},
    }})
    saved = store.get_state()['data']
    assert saved['rulesSubmission']['rules'][0]['instruction'] == rule['instruction']
    assert saved.get('ruleMigration') is None


def test_rule_test_endpoint_uses_model_and_has_no_workspace_side_effects(store):
    from fastapi.testclient import TestClient
    from server import create_app
    from rule_catalog import demo_rules, demo_cases
    evaluator = Evaluator()
    rule = demo_rules()[0]
    case = next(c for c in demo_cases() if c['ruleId'] == rule['id'] and c['scenario'] == 'hit')
    before = store.snapshot()
    with TestClient(create_app(store, rule_service=evaluator)) as client:
        catalog = client.get('/api/local/rules/demo-cases')
        assert catalog.status_code == 200
        response = client.post('/api/local/rules/test', json={'rule': rule, 'caseId': case['id']})
        assert response.status_code == 200, response.text
        assert response.json()['review']['findings'][0]['engine'] == 'llm'
        assert client.post('/api/local/rules/test', json={'rule': rule, 'caseId': 'missing'}).status_code == 422
    assert len(evaluator.calls) == 1
    assert 'scenario' not in evaluator.calls[0][0]
    assert store.snapshot() == before
