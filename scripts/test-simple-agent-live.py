"""真实模型验证：上传材料提取与同源CSV小工具。默认使用隔离验收服务。"""
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

BASE = os.getenv('SIMPLE_TEST_API', 'http://127.0.0.1:5192/api/local')
OUT = Path('artifacts/flow-simple-20261117')


def journey(kind, filename, content, message, expected_tool):
    with httpx.Client(base_url=BASE, timeout=200) as client:
        response = client.post('/files', files={'file': (filename, content.encode(), 'text/plain')})
        response.raise_for_status()
        file = response.json()['file']
        response = client.post('/runs', json={
            'taskId': 'simple-' + kind + '-' + uuid.uuid4().hex[:8], 'message': message,
            'refs': [{'kind': 'file', 'id': file['id'], 'title': filename}],
        })
        response.raise_for_status()
        run_id = response.json()['runId']
        deadline = time.monotonic() + 200
        while time.monotonic() < deadline:
            response = client.get('/runs/' + run_id)
            response.raise_for_status()
            run = response.json()
            if run['status'] != 'running':
                break
            time.sleep(1)
        assert run['status'] == 'completed', run
        used = [event['data']['name'] for event in run['events'] if event['kind'] == 'tool' and event['data'].get('status') == 'completed']
        assert expected_tool in used, used
        output = next(event['data'] for event in run['events'] if event['kind'] == 'result')
        state = client.get('/workspace').json()['state']
        if kind == 'material':
            items = [item for item in state['data']['materials']['items'] if item['sourceFileId'] == file['id']]
            assert len(items) == 1 and items[0]['amount'] == 8050, items
            assert items[0]['confirmed'] is False
            assert output['cards'][0]['data']['fileIds'] == [file['id']]
        else:
            results = [result for result in state['data']['toolResults'].values() if result['fileId'] == file['id']]
            assert len(results) == 1 and results[0]['totalMinor'] == '3000', results
            assert results[0]['rowCount'] == 3
            assert '30.00' in output['text'] and '3,000' not in output['text'], output['text']
        print(kind + ': passed', flush=True)
        return {'kind': kind, 'runId': run_id, 'taskId': run['task_id'], 'fileId': file['id'], 'tools': used, 'output': output['text'], 'cards': output['cards']}


if __name__ == '__main__':
    cases = [
        ('material', '办公费用材料.txt', '费用名称：办公文具\n费用类型：办公\n金额：80.50元\n费用日期：2026年11月17日\n业务事由：日常办公采购\n费用归属：个人日常办公\n', '请提取附件中的费用材料，保存到待核对列表，不要替我确认。', 'extract_expense_materials'),
        ('csv', '费用汇总验收.csv', '费用类型,金额\n交通,12.50\n办公,20.00\n交通,-2.50\n', '请调用费用汇总小工具，汇总这个CSV，保存结果并告诉我总额和各类别小计。', 'summarize_expense_csv'),
    ]
    if os.getenv('SIMPLE_TEST_CASE'):
        cases = [case for case in cases if case[0] == os.environ['SIMPLE_TEST_CASE']]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda case: journey(*case), cases))
    OUT.mkdir(exist_ok=True, parents=True)
    destination = OUT / 'live-journeys.json'
    if destination.exists():
        previous = json.loads(destination.read_text())
        results = [item for item in previous if item['kind'] not in {result['kind'] for result in results}] + results
    destination.write_text(json.dumps(results, ensure_ascii=False, indent=2))
