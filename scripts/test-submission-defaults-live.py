"""在隔离服务验证智能提单真实模型；仅创建测试草稿/会话，不提交单据。"""
from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx


BASE = os.getenv('SUBMISSION_TEST_API', 'http://127.0.0.1:5198/api/local').rstrip('/')
OUT = Path(os.getenv('SUBMISSION_TEST_OUT', 'artifacts/submission-defaults-live'))


def call(client, method, path, **kwargs):
    response = client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json()


def wait_for_run(client, run_id, label):
    deadline = time.monotonic() + 240
    seen = 0
    next_status = time.monotonic() + 15
    while time.monotonic() < deadline:
        run = call(client, 'GET', '/runs/' + run_id)
        events = run.get('events', [])
        for event in events[seen:]:
            if event['kind'] == 'tool':
                data = event['data']
                print(f"{label}：{data.get('label', data.get('name', '工具'))} / {data.get('status', '')}", flush=True)
        seen = len(events)
        if run['status'] != 'running':
            return run
        if time.monotonic() >= next_status:
            print(f'{label}：模型仍在处理，已保留运行记录。', flush=True)
            next_status = time.monotonic() + 15
        time.sleep(1)
    raise TimeoutError(f'{label}超过240秒，runId={run_id}；未触发提交。')


def run_turn(client, task_id, draft, label, message):
    started = call(client, 'POST', '/runs', json={
        'taskId': task_id, 'message': message, 'capability': 'submission',
        'refs': [{'kind': 'submission', 'id': draft['id'], 'title': draft['title']}],
    })
    run = wait_for_run(client, started['runId'], label)
    workspace = call(client, 'GET', '/workspace')['state']
    current = workspace['data']['submissions']['drafts'][draft['id']]
    output = next((event['data'] for event in reversed(run.get('events', [])) if event['kind'] == 'result'), {})
    tools = [event['data']['name'] for event in run.get('events', [])
             if event['kind'] == 'tool' and event['data'].get('status') == 'completed']
    return {
        'label': label, 'message': message, 'runId': started['runId'], 'taskId': task_id,
        'status': run['status'], 'tools': tools, 'output': output.get('text', ''),
        'draft': current, 'check': workspace['data']['submissions'].get('checks', {}).get(draft['id']),
        'events': run.get('events', []),
    }


def verify_flow(result):
    assert result['status'] == 'completed', f"运行未完成：{result['status']}"
    tools = result['tools']
    get = tools.index('get_submission_draft')
    update = tools.index('update_submission_draft')
    validate = tools.index('validate_submission')
    assert get < update < validate, f'工具调用顺序异常：{tools}'
    assert result['draft']['status'] == 'draft', '测试单据不应被提交'
    assert result['check'] is not None, '缺少真实校验结果'


def main():
    url = urlparse(BASE)
    if url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.port in {5191, 5192}:
        raise ValueError('仅允许隔离的本机测试服务，禁止使用5191/5192；默认端口5198。')
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    tomorrow = today + timedelta(days=1)
    friday = today + timedelta(days=(4 - today.weekday()) % 7)
    if friday < tomorrow:
        friday += timedelta(days=7)
    week_end = today + timedelta(days=6 - today.weekday())
    friday_text = '周五' if friday <= week_end else '下周五'
    task_id = 'submission-defaults-' + uuid.uuid4().hex[:12]
    OUT.mkdir(parents=True, exist_ok=True)
    report_path = OUT / (task_id + '.json')
    results = []
    failure = None
    with httpx.Client(base_url=BASE, timeout=httpx.Timeout(25, connect=5)) as client:
        created = call(client, 'POST', '/business/new-draft', json={'id': 'travel'})
        draft = created['draft']
        if draft['id'] == 'travel':
            raise AssertionError('测试要求独立草稿实例，不能修改共享类型槽。')
        print(f'已创建隔离验收草稿：{draft["id"]}', flush=True)
        cases = [
            ('默认往返', f'明天去上海拜访客户，{friday_text}回来，帮我填单。'),
            ('改实际起点', '改成从北京出发，其他安排不变。'),
            ('分段指定席别', '去程坐高铁一等座，返程坐高铁二等座，其他安排不变。'),
        ]
        try:
            for label, message in cases:
                result = run_turn(client, task_id, draft, label, message)
                results.append(result)
                verify_flow(result)
                current = result['draft']
                legs = current['legs']
                assert len(legs) == 2, f'往返应为两段，实际{len(legs)}段'
                assert '拜访' in current['purpose'] and '客户' in current['purpose'], '已说明的业务目的未保存'
                assert legs[0]['arrivalCity'] == '上海'
                assert legs[0]['departureDate'] == tomorrow.isoformat(), '明天未按北京时间解释'
                assert legs[1]['departureDate'] == friday.isoformat(), '返程星期未正确解释'
                if label == '默认往返':
                    assert legs[0]['departureCity'] == legs[1]['arrivalCity'] == '杭州'
                    assert legs[0]['transport'] == '火车-二等座'
                    fields = current['autoFill']['fields']
                    assert fields[f"legs.{legs[0]['id']}.departureCity"]['source']
                    assert fields[f"legs.{legs[0]['id']}.transport"]['source']
                else:
                    assert legs[0]['departureCity'] == legs[1]['arrivalCity'] == '北京', '返程未跟随实际起点'
                if label == '改实际起点':
                    assert legs[0]['transport'] == legs[1]['transport'] == '飞机-经济舱', '修改线路后仍保留旧交通推荐'
                if label == '分段指定席别':
                    assert '一等座' in legs[0]['transport'] and '二等座' in legs[1]['transport'], '明确指定的分段席别未生效'
                print(f'{label}：通过；回复：{result["output"]}', flush=True)
                report_path.write_text(json.dumps({'api': BASE, 'draftId': draft['id'], 'results': results}, ensure_ascii=False, indent=2))
        except Exception as error:
            failure = f'{type(error).__name__}: {error}'
        finally:
            report_path.write_text(json.dumps({'api': BASE, 'draftId': draft['id'], 'results': results, 'failure': failure}, ensure_ascii=False, indent=2))
    print(f'验收记录：{report_path.resolve()}', flush=True)
    if failure:
        raise AssertionError(failure)
    print('通过：3轮真实模型提单，未提交任何单据。', flush=True)


if __name__ == '__main__':
    main()
