"""仅使用合成业务数据验证真实语义生成与执行，不改工作空间。"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/agno-service'))
from agent_runtime import generate_rule, model
from rule_service import SemanticRuleService
from rule_catalog import demo_rules, demo_cases


async def main():
    output = ROOT / 'artifacts/semantic-rules-20261117'
    output.mkdir(parents=True, exist_ok=True)
    rule = (await generate_rule('业务招待事由中包含高档消费时，例如高档酒、高档消费娱乐场所等等，需要提示风险'))['rule']
    print(json.dumps({'generation': {key: rule[key] for key in ('name', 'metric', 'requiredFields', 'documentTypes', 'scope')}}, ensure_ascii=False), flush=True)
    service = SemanticRuleService(model)
    examples = [
        ('attention', '宴请客户，采购高档酒，并安排到高档娱乐场所消费。'),
        ('clear', '客户工作午餐，未采购高档酒，未安排高档娱乐场所消费。'),
        ('attention', '计划宴请客户，安排采购高档酒，并到高档娱乐场所消费。'),
        ('unknown', ''),
    ]
    user_cases = []
    for expected, purpose in examples:
        review = await asyncio.to_thread(service.evaluate, {'documentType': 'personal', 'purpose': purpose}, [rule])
        user_cases.append({'expected': expected, 'actual': review['status'], 'review': review})
        print(json.dumps({'userCase': expected, 'actual': review['status']}, ensure_ascii=False), flush=True)
    (output / 'live-user-rule.json').write_text(json.dumps({'rule': rule, 'cases': user_cases}, ensure_ascii=False, indent=2))

    rules = {item['id']: item for item in demo_rules()}
    def run(case):
        review = service.evaluate(case['document'], [rules[case['ruleId']]])
        expected = {'hit': 'attention', 'clear': 'clear', 'unknown': 'unknown'}[case['scenario']]
        result = {'caseId': case['id'], 'expected': expected, 'actual': review['status'], 'review': review}
        print(json.dumps({key: result[key] for key in ('caseId', 'expected', 'actual')}, ensure_ascii=False), flush=True)
        return result
    with ThreadPoolExecutor(max_workers=3) as pool:
        cases = list(pool.map(run, demo_cases()))
    (output / 'live-demo-cases.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2))
    assert rule['requiredFields'] == ['purpose'], rule['requiredFields']
    assert set(rule['documentTypes']) == {'expense', 'personal'}
    assert rule['scope'] == 'review'
    failed = [item for item in user_cases + cases if item['expected'] != item['actual']]
    assert not failed, [(item.get('caseId', '原始需求'), item['expected'], item['actual']) for item in failed]
    print(f'真实模型验证通过：原始需求{len(user_cases)}例，目录样例{len(cases)}例。', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
