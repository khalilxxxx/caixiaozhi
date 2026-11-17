"""语义规则的本地契约与不放行边界；模型网络调用由 Agno 边界替换。"""
import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest


def rule(**changes):
    return {
        'id': 'semantic-1', 'name': '高档消费提醒', 'metric': 'semantic',
        'system': 'expense', 'origin': 'personal', 'effect': 'warn', 'scope': 'both',
        'instruction': '事由明确表示采购高档酒或安排高档娱乐消费时提醒本人。',
        'requiredFields': ['purpose'], 'documentTypes': ['expense', 'personal'],
        'enabled': True, 'version': 1, 'description': '高档消费时提醒本人。',
        **changes,
    }


def agent_result(monkeypatch, content=None, *, failure=None, inspect=None):
    import rule_service

    class FakeAgent:
        def __init__(self, **kwargs):
            assert kwargs['model'] == 'injected-model'
            assert kwargs['use_json_mode'] is True
            assert kwargs['telemetry'] is False
            self.schema = kwargs['output_schema']
            self.model = SimpleNamespace(id='fixture-semantic-model')

        def run(self, text):
            if inspect:
                inspect(json.loads(text))
            if failure:
                raise failure
            return SimpleNamespace(content=content(json.loads(text)) if callable(content) else content)

        async def arun(self, text):
            return self.run(text)

    monkeypatch.setattr(rule_service, 'Agent', FakeAgent)
    return rule_service.SemanticRuleService(lambda: 'injected-model')


def result(state='MATCHED', *, identifier='semantic-1', path='$.purpose', quote='采购高档酒', reason='事由明确表示采购高档酒。'):
    return {'results': [{'ruleId': identifier, 'state': state, 'reason': reason,
                         'evidence': [{'path': path, 'quote': quote}]}]}


def test_generation_preserves_original_logic_and_only_creates_personal_semantic_rule(monkeypatch):
    text = '报销事由包含采购高档酒或高档娱乐消费且金额超过2000元时，提单和审单提醒本人。'
    proposal = {'supported': True, 'name': '高档消费提醒', 'instruction': text,
                'requiredFields': ['purpose', 'amountCents'], 'documentTypes': ['expense', 'personal'],
                'scope': 'both', 'system': 'expense', 'category': 'business_entertainment'}
    service = agent_result(monkeypatch, proposal)
    generated = asyncio.run(service.generate(text))['rule']
    assert generated['metric'] == 'semantic'
    assert generated['logic'] == generated['description'] == text
    assert generated['instruction'] == text
    assert generated['origin'] == 'personal' and generated['effect'] == 'warn'
    assert generated['source'] == '本人维护'
    assert generated['requiredFields'] == ['purpose', 'amountCents']
    assert generated['category'] == 'business_entertainment'
    assert generated['stage'] == 'draft'
    assert generated['applicability'] and generated['evidence'] and generated['output'] and generated['missing']
    assert generated['revisions'] == []


@pytest.mark.parametrize('text', ['检查外部商户黑名单', '检查员工全年跨单据累计', '将本人提醒变为公司阻断规则'])
def test_generation_rejects_unavailable_facts_and_company_authority_without_rewriting(monkeypatch, text):
    service = agent_result(monkeypatch, {'supported': False, 'reason': '缺少可用事实或超出个人维护权限。'})
    with pytest.raises(ValueError, match='缺少|权限'):
        asyncio.run(service.generate(text))


@pytest.mark.parametrize('changes', [
    {'instruction': ''}, {'instruction': '字' * 4001}, {'requiredFields': ['secret']},
    {'requiredFields': ['purpose', 'purpose']}, {'documentTypes': ['travel']},
    {'documentTypes': []}, {'effect': 'block'}, {'system': 'oa'},
    {'instruction': 1}, {'requiredFields': 'purpose'},
])
def test_save_rejects_invalid_semantic_contract(changes):
    from rule_service import validate_semantic_rule
    with pytest.raises(ValueError):
        validate_semantic_rule(rule(**changes))


def test_save_allows_company_rule_without_converting_it_to_personal():
    from rule_service import validate_semantic_rule
    company = rule(origin='builtin', effect='block')
    validate_semantic_rule(company)
    assert company['origin'] == 'builtin' and company['effect'] == 'block'


def test_semantic_match_has_verified_evidence(monkeypatch):
    service = agent_result(monkeypatch, result())
    review = service.evaluate({'id': 'expense', 'purpose': '客户接待采购高档酒'}, [rule()])
    assert review['status'] == 'attention'
    assert review['attemptCount'] == 1
    finding = review['findings'][0]
    assert finding['state'] == 'hit' and finding['engine'] == 'llm'
    assert finding['evidence'] == [{'path': '$.purpose', 'quote': '采购高档酒'}]
    assert finding['detail'] == '事由明确表示采购高档酒。'
    assert review['applicable'] == [rule()] and review['passed'] == []


def test_negated_mention_uses_model_semantics_and_does_not_fallback_to_keyword_hit(monkeypatch):
    service = agent_result(monkeypatch, result('NOT_MATCHED', quote='未采购高档酒', reason='事由明确否定采购高档酒。'))
    review = service.evaluate({'id': 'expense', 'purpose': '未采购高档酒，仅支付普通工作餐'}, [rule()])
    assert review['status'] == 'clear' and review['findings'] == []
    assert review['passed'] == [rule()]


@pytest.mark.parametrize('state', ['MATCHED', 'NOT_MATCHED'])
@pytest.mark.parametrize('evidence', [[], [{'path': '$.secret', 'quote': '采购高档酒'}],
    [{'path': '$.purpose', 'quote': '不存在的证据'}], [{'path': '$.expenses[99].reason', 'quote': '采购高档酒'}],
    [{'path': '$.purpose', 'quote': ''}]])
def test_invalid_or_missing_evidence_never_clears_or_confirms(monkeypatch, state, evidence):
    output = result(state)
    output['results'][0]['evidence'] = evidence
    service = agent_result(monkeypatch, output)
    review = service.evaluate({'id': 'expense', 'purpose': '采购高档酒', 'secret': '采购高档酒'}, [rule()])
    assert review['status'] == 'unknown'
    assert review['findings'][0]['state'] == 'unknown' and review['passed'] == []


@pytest.mark.parametrize('output', [
    {'results': []}, {'results': [result()['results'][0]] * 2}, result(identifier='other'),
    {'results': [dict(result()['results'][0], state='PASS')]},
    {'results': [dict(result()['results'][0], reason='all good')]}, 'not json',
])
def test_invalid_model_output_is_unknown_for_every_applicable_rule(monkeypatch, output):
    service = agent_result(monkeypatch, output)
    review = service.evaluate({'id': 'expense', 'purpose': '采购高档酒'}, [rule(), rule(id='semantic-2')])
    assert review['status'] == 'unknown' and review['passed'] == []
    assert len(review['findings']) == 2
    assert all(f['state'] == 'unknown' for f in review['findings'])


def test_model_failure_is_unknown_and_does_not_expose_provider_details(monkeypatch, caplog):
    service = agent_result(monkeypatch, failure=RuntimeError('sensitive-provider-error'))
    review = service.evaluate({'id': 'expense', 'purpose': '采购高档酒'}, [rule()])
    assert review['status'] == 'unknown'
    assert review['attemptCount'] == 2
    assert 'sensitive' not in json.dumps(review)
    assert 'sensitive-provider-error' not in caplog.text
    assert '采购高档酒' not in caplog.text
    assert 'RuntimeError' in caplog.text


def test_missing_required_field_is_unknown_without_starting_model():
    from rule_service import SemanticRuleService
    def cannot_start():
        pytest.fail('缺失必要字段时不得调用模型')
    review = SemanticRuleService(cannot_start).evaluate({'id': 'expense', 'purpose': '  '}, [rule()])
    assert review['status'] == 'unknown'
    assert '事由' in review['findings'][0]['detail']
    assert 'purpose' not in review['findings'][0]['detail']


def test_wrong_document_type_is_inapplicable_without_starting_model():
    from rule_service import SemanticRuleService
    def cannot_start():
        pytest.fail('不适用时不得调用模型')
    review = SemanticRuleService(cannot_start).evaluate({'id': 'travel', 'purpose': '采购高档酒'}, [rule()])
    assert review['status'] == 'clear' and review['inapplicable'] == [rule()]
    assert review['applicable'] == []


def test_context_drops_private_fields_and_evidence_cannot_reach_them(monkeypatch):
    def inspect(payload):
        document = payload['document']
        assert document['purpose'] == '普通工作餐'
        assert document['expenses'][0]['reason'] == '工作餐'
        assert 'apiKey' not in document and 'bankAccount' not in document['expenses'][0]
        assert 'text' not in document['files'][0]
    service = agent_result(monkeypatch, result('NOT_MATCHED', quote='普通工作餐', reason='无高档消费。'), inspect=inspect)
    review = service.evaluate({'id': 'expense', 'purpose': '普通工作餐', 'apiKey': 'secret',
        'expenses': [{'reason': '工作餐', 'bankAccount': 'secret'}],
        'files': [{'name': 'invoice.pdf', 'text': 'secret content'}]}, [rule()])
    assert review['status'] == 'clear'


@pytest.mark.parametrize('path', ['$.expenses[0].reason', 'expenses.0.reason', '/expenses/0/reason'])
def test_nested_evidence_paths_resolve_actual_business_fields(monkeypatch, path):
    service = agent_result(monkeypatch, result(path=path))
    review = service.evaluate({'id': 'expense', 'purpose': '接待', 'expenses': [{'reason': '采购高档酒'}]}, [rule()])
    assert review['status'] == 'attention'


def test_oversized_context_is_rejected_whole_without_silent_truncation():
    from rule_service import SemanticRuleService
    def cannot_start():
        pytest.fail('超限上下文不得提交模型')
    review = SemanticRuleService(cannot_start).evaluate({'id': 'expense', 'purpose': '字' * 100001}, [rule()])
    assert review['status'] == 'unknown'
    assert '过大' in review['findings'][0]['detail'] or '超' in review['findings'][0]['detail']


def test_insufficient_evidence_stays_unknown_even_with_valid_quotes(monkeypatch):
    service = agent_result(monkeypatch, result('INSUFFICIENT_EVIDENCE', quote='接待', reason='缺少具体消费内容。'))
    review = service.evaluate({'id': 'expense', 'purpose': '接待'}, [rule()])
    assert review['status'] == 'unknown' and review['findings'][0]['state'] == 'unknown'


def test_context_preserves_expense_classification_and_activity_description(monkeypatch):
    def inspect(payload):
        expense = payload['document']['expenses'][0]
        assert expense['categoryName'] == '业务招待费'
        assert expense['categoryGroup'] == 'business_entertainment'
        assert expense['reason'] == '客户接待'
        assert expense['people'] == '6'
        assert payload['document']['activities'][0]['description'] == '客户方案沟通'
    service = agent_result(monkeypatch, result('NOT_MATCHED', quote='普通工作餐', reason='已说明为普通工作餐。'), inspect=inspect)
    review = service.evaluate({'id': 'expense', 'purpose': '普通工作餐',
        'expenses': [{'categoryName': '业务招待费', 'categoryGroup': 'business_entertainment', 'reason': '客户接待', 'people': '6'}],
        'activities': [{'description': '客户方案沟通'}]}, [rule()])
    assert review['status'] == 'clear'


@pytest.mark.parametrize(('value', 'quote'), [(2000, '2'), (False, 'false '), (True, 'rue')])
def test_numeric_and_boolean_evidence_quotes_must_represent_whole_scalar(monkeypatch, value, quote):
    service = agent_result(monkeypatch, result(path='$.amountCents', quote=quote))
    review = service.evaluate({'id': 'expense', 'purpose': '采购高档酒', 'amountCents': value}, [rule()])
    assert review['status'] == 'unknown' and review['passed'] == []


def test_zero_and_false_are_present_required_facts(monkeypatch):
    service = agent_result(monkeypatch, result('NOT_MATCHED', path='$.amountCents', quote='0', reason='单据金额为零，未达到提醒条件。'))
    review = service.evaluate({'documentType': 'expense', 'amountCents': 0, 'attachment': False},
        [rule(requiredFields=['amountCents', 'attachment'])])
    assert review['status'] == 'clear'


def test_unknown_document_type_cannot_be_treated_as_inapplicable():
    from rule_service import SemanticRuleService
    def cannot_start():
        pytest.fail('类型缺失时不得调用模型')
    review = SemanticRuleService(cannot_start).evaluate({'id': 'arbitrary-id', 'purpose': '接待'}, [rule()])
    assert review['status'] == 'unknown' and review['inapplicable'] == []


def test_unknown_decision_must_also_have_verifiable_evidence_if_provided(monkeypatch):
    service = agent_result(monkeypatch, result('INSUFFICIENT_EVIDENCE', quote='伪造'))
    review = service.evaluate({'id': 'expense', 'purpose': '接待'}, [rule()])
    assert review['status'] == 'unknown'
    assert review['findings'][0]['evidence'] == []
    assert '伪造' not in review['findings'][0]['detail']


def test_negative_decision_preserves_reason_evidence_and_actual_model_identity(monkeypatch):
    service = agent_result(monkeypatch, result('NOT_MATCHED', quote='未采购高档酒', reason='事由明确否定采购高档酒。'))
    review = service.evaluate({'id': 'expense', 'purpose': '未采购高档酒，仅普通工作餐'}, [rule()])
    assert review['status'] == 'clear'
    assert review['engine'] == 'llm' and review['model'] == 'fixture-semantic-model'
    assert review['evaluations'] == [{'ruleId': 'semantic-1', 'state': 'NOT_MATCHED',
        'reason': '事由明确否定采购高档酒。', 'evidence': [{'path': '$.purpose', 'quote': '未采购高档酒'}]}]


def test_failed_model_call_does_not_fabricate_completed_evaluations(monkeypatch):
    service = agent_result(monkeypatch, failure=RuntimeError('provider unavailable'))
    review = service.evaluate({'id': 'expense', 'purpose': '接待'}, [rule()])
    assert review['status'] == 'unknown' and review['evaluations'] == []
    assert review['engine'] == 'llm' and review['model'] == 'fixture-semantic-model'


def test_missing_fields_do_not_claim_model_was_called():
    from rule_service import SemanticRuleService
    def cannot_start():
        pytest.fail('缺失字段不应发起模型调用')
    review = SemanticRuleService(cannot_start).evaluate({'id': 'expense'}, [rule()])
    assert review['status'] == 'unknown' and review['evaluations'] == []
    assert review.get('engine') != 'llm' and not review.get('model')


def test_generated_evidence_uses_chinese_business_field_labels(monkeypatch):
    proposal = {'supported': True, 'name': '事由费用一致性提醒', 'instruction': '费用与事由不一致时提醒。',
        'requiredFields': ['purpose', 'expenses'], 'documentTypes': ['expense'], 'system': 'expense'}
    generated = asyncio.run(agent_result(monkeypatch, proposal).generate('费用与事由不一致时提醒本人。'))['rule']
    assert [item['name'] for item in generated['evidence']] == ['事由', '费用明细']


def test_generation_reconciles_candidate_scope_against_original_requirement(monkeypatch):
    original = '业务招待事由中包含高档消费时，例如高档酒、高档消费娱乐场所等等，需要提示风险'
    candidate = {'supported': True, 'name': '高档消费提醒', 'instruction': '检查事由与所有费用，KTV和普通酒均提醒。',
        'requiredFields': ['purpose', 'expenses'], 'documentTypes': ['expense', 'personal'], 'system': 'expense'}
    corrected = {**candidate, 'instruction': '仅检查事由是否明确包含高档酒或明确的高档娱乐场所消费；明确否定时不触发，含糊不确定时待核实。',
        'requiredFields': ['purpose']}
    def respond(payload):
        if 'candidate' in payload:
            assert payload['requirement'] == original
            assert payload['candidate']['requiredFields'] == ['purpose', 'expenses']
            return corrected
        return candidate
    service = agent_result(monkeypatch, respond)
    generated = asyncio.run(service.generate(original))['rule']
    assert generated['requiredFields'] == ['purpose']
    assert generated['instruction'] == corrected['instruction']
    assert generated['logic'] == original


def test_forged_first_evidence_retries_once_with_identical_business_input(monkeypatch):
    payloads = []
    def respond(payload):
        payloads.append(deepcopy(payload))
        return result(quote='伪造的原文') if len(payloads) == 1 else result()
    service = agent_result(monkeypatch, respond)
    review = service.evaluate({'id': 'expense', 'purpose': '客户接待采购高档酒'}, [rule()])
    assert review['status'] == 'attention' and review['attemptCount'] == 2
    assert len(payloads) == 2 and payloads[0] == payloads[1]
    assert review['evaluations'][0]['evidence'] == [{'path': '$.purpose', 'quote': '采购高档酒'}]
    assert '伪造' not in json.dumps(review, ensure_ascii=False)


def test_two_invalid_outputs_stop_at_two_and_remain_unknown(monkeypatch):
    payloads = []
    def respond(payload):
        payloads.append(payload)
        return result(quote='伪造')
    review = agent_result(monkeypatch, respond).evaluate({'id': 'expense', 'purpose': '采购高档酒'}, [rule()])
    assert review['attemptCount'] == 2 and len(payloads) == 2
    assert review['status'] == 'unknown' and review['passed'] == [] and review['evaluations'] == []


@pytest.mark.parametrize('document', [
    {'id': 'expense', 'purpose': '字' * 100001},
    {'id': 'expense', 'purpose': '接待', 'expenses': 'invalid'},
    {'id': 'expense', 'purpose': ' '},
])
def test_invalid_or_missing_business_context_never_attempts_model_or_retry(document):
    from rule_service import SemanticRuleService
    def cannot_start():
        pytest.fail('非法、超限或缺失输入不得调用或重试模型')
    review = SemanticRuleService(cannot_start).evaluate(document, [rule()])
    assert review['status'] == 'unknown' and review['attemptCount'] == 0
    assert review['evaluations'] == []
