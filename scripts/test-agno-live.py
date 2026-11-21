"""Real model + real server smoke test, with durable tool evidence."""
import json, time, urllib.request, uuid
from pathlib import Path
BASE='http://127.0.0.1:5190/api/local'

def call(path, data=None, method=None):
    body=json.dumps(data,ensure_ascii=False).encode() if data is not None else None
    req=urllib.request.Request(BASE+path,data=body,method=method,headers={'Content-Type':'application/json'} if body else {})
    with urllib.request.urlopen(req,timeout=190) as res:
        return json.load(res)

def run(task_id,text):
    result=call('/runs',{'taskId':task_id,'message':text,'refs':[]})
    for _ in range(160):
        result=call('/runs/'+result['runId']) if 'runId' in result else call('/runs/'+result['id'])
        if result['status']!='running':return result
        time.sleep(1)
    raise RuntimeError('任务超时')

if __name__=='__main__':
    task_id='verification-'+uuid.uuid4().hex[:8]
    a=run(task_id,'请查询2026年10月销售部报销费用总额，并告诉我比9月增加了多少。')
    assert a['status']=='completed',a
    tools=[e['data'] for e in a['events'] if e['kind']=='tool' and e['data']['status']=='completed']
    assert any(t['name']=='query_business_board' for t in tools),tools
    b=run(task_id,'那所有已授权部门10月总额是多少？请沿用同一统计口径。')
    assert b['status']=='completed',b
    result=[e['data'] for e in b['events'] if e['kind']=='result'][0]
    assert result['cards'],result
    out={'health':call('/health'),'first':{'runId':a['id'],'tools':tools,'text':[e['data']['text'] for e in a['events'] if e['kind']=='result'][0]},'followup':{'runId':b['id'],'text':result['text']},'verifiedAt':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    destination=Path('artifacts/agno-local-20261116/live-verification.json')
    destination.write_text(json.dumps(out,ensure_ascii=False,indent=2))
    print(json.dumps(out,ensure_ascii=False,indent=2))
