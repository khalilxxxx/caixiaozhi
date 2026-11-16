import sys, json, time, uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('live',str(Path(__file__).with_name('test-agno-live.py')))
live=module_from_spec(spec);spec.loader.exec_module(live)

checks=[
 ('policy','在上海出差住宿每晚700元符合标准吗？请查询当前制度，引用具体条款。','search_policies'),
 ('report','请生成并保存2026年10月销售部费用分析报告。','create_expense_report'),
 ('rule','帮我添加一个个人审单规则草稿：住宿费用每间夜超过700元时提醒本人。不要启用。','prepare_personal_rule'),
]

def verify(item):
 name,message,tool=item
 result=live.run('verification-'+name+'-'+uuid.uuid4().hex[:8],message)
 assert result['status']=='completed',(name,result['status'])
 events=result['events']
 used=[e['data']['name'] for e in events if e['kind']=='tool' and e['data']['status']=='completed']
 assert tool in used,(name,used)
 output=next(e['data'] for e in events if e['kind']=='result')
 assert output['cards']
 return {'journey':name,'runId':result['id'],'tools':used,'text':output['text'],'cards':output['cards']}

with ThreadPoolExecutor(max_workers=3) as pool:
 results=list(pool.map(verify,checks))
Path('artifacts/agno-local-20261116/agent-journeys.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print(json.dumps(results,ensure_ascii=False,indent=2))
