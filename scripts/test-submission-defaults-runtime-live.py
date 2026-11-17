"""隔离 Store + 真实 Runtime/模型验收；不启动 HTTP，不访问主库，不提交单据。"""
from __future__ import annotations

import asyncio
import argparse
import json
import sys
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps' / 'agno-service'))

import config
from agent_runtime import Runtime, model
from business import Business
from rule_service import SemanticRuleService
from store import Store


async def run_turn(runtime, store, task_id, draft, label, message):
    run_id = 'submission-run-' + uuid.uuid4().hex
    refs = [{'kind': 'submission', 'id': draft['id'], 'title': draft['title']}]

    def begin(state):
        task = next((item for item in state['tasks'] if item['id'] == task_id), None)
        if task is None:
            task = {'id': task_id, 'title': '智能提单隔离验收', 'messages': [], 'refs': refs}
            state['tasks'].insert(0, task)
        task['messages'].append({'id': 'user-' + run_id, 'role': 'user', 'text': message})
        task.update(activeRunId=run_id, status='处理中', refs=refs, capability='submission')

    store.create_run(run_id, task_id, {'message': message, 'refs': refs, 'capability': 'submission'}, initialize=begin)
    runtime.launch(run_id)
    task = runtime.tasks[run_id]
    deadline, next_status, seen = time.monotonic() + 240, time.monotonic() + 15, 0
    while store.run(run_id)['status'] == 'running':
        if time.monotonic() > deadline:
            await runtime.cancel(run_id)
            break
        for event in store.events(run_id)[seen:]:
            seen += 1
            if event['kind'] == 'tool':
                data = event['data']
                print(f"{label}：{data.get('label', data.get('name', '工具'))} / {data.get('status', '')}", flush=True)
        if task.done():
            await task
            break
        if time.monotonic() >= next_status:
            print(f'{label}：模型仍在处理，运行记录已保留。', flush=True)
            next_status = time.monotonic() + 15
        await asyncio.sleep(1)
    await task
    run = store.run(run_id)
    events = store.events(run_id)
    state = store.get_state()
    output = next((event['data'] for event in reversed(events) if event['kind'] == 'result'), {})
    return {
        'label': label, 'message': message, 'runId': run_id, 'taskId': task_id,
        'status': run['status'],
        'tools': [event['data']['name'] for event in events
                  if event['kind'] == 'tool' and event['data'].get('status') == 'completed'],
        'output': output.get('text', ''),
        'canSubmit': next((card.get('data', {}).get('canSubmit') for card in output.get('cards', [])
                           if card.get('kind') == 'submission' and card.get('id') == draft['id']), None),
        'draft': state['data']['submissions']['drafts'][draft['id']],
        'check': state['data']['submissions'].get('checks', {}).get(draft['id']), 'events': events,
    }


def verify(result, tomorrow, friday):
    assert result['status'] == 'completed', f"运行未完成：{result['status']}"
    tools = result['tools']
    assert tools.index('get_submission_draft') < tools.index('update_submission_draft') < tools.index('validate_submission'), tools
    draft = result['draft']
    assert draft['status'] == 'draft', '测试单据不应被提交'
    assert result['check'] is not None, '没有实际校验结果'
    assert '拜访' in draft['purpose'] and '客户' in draft['purpose'], '已说明事由未保存'
    legs = draft['legs']
    assert len(legs) == 2, f'往返应为两段，实际{len(legs)}段'
    assert legs[0]['arrivalCity'] == '上海'
    assert legs[0]['departureDate'] == tomorrow.isoformat(), '明天未按北京时间解释'
    assert legs[1]['departureDate'] == friday.isoformat(), '返程星期未正确解释'
    if result['label'] == '默认往返':
        assert legs[0]['departureCity'] == legs[1]['arrivalCity'] == '杭州', '员工常驻地或返程终点错误'
        assert legs[0]['transport'] == '火车-二等座', '短途推荐错误'
        fields = draft['autoFill']['fields']
        assert fields[f"legs.{legs[0]['id']}.departureCity"]['source']
        assert fields[f"legs.{legs[0]['id']}.transport"]['source']
    else:
        assert legs[0]['departureCity'] == legs[1]['arrivalCity'] == '北京', '返程未跟随实际起点'
    if result['label'] == '改实际起点':
        assert legs[0]['transport'] == legs[1]['transport'] == '飞机-经济舱', '线路变化未更新推荐'
    if result['label'] == '分段指定席别':
        assert '一等座' in legs[0]['transport'] and '二等座' in legs[1]['transport'], '分段指定席别未保存'
    if result['label'] == '摘要回归':
        assert all('二等座' in leg['transport'] for leg in legs), '席别修改或保留错误'
        assert not result['check']['issues'], '完整测试草稿出现字段缺项'
        assert result['canSubmit'] is True, '个人提醒不应成为提交阻断'
        assert not any(line.strip().startswith('|') for line in result['output'].splitlines()), '简短摘要不应输出表格'
        assert not any(word in result['output'] for word in ('必须补', '才能提交', '还需补', '需要补充客户')), '个人提醒被升级为必填'
        assert len(result['output']) <= 240, '摘要过长，应仅概括变化和真正待补项'


async def main(summary_only=False):
    config.DATA_DIR = ROOT / '.runtime' / 'submission-defaults-live'
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    task_id = 'submission-live-' + uuid.uuid4().hex[:12]
    store = Store(config.DATA_DIR / (task_id + '.sqlite3'))
    business = Business(store, rule_service=SemanticRuleService(model))
    runtime = Runtime(store, business)
    draft = business.new_draft('travel')['draft']
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    tomorrow = today + timedelta(days=1)
    friday = today + timedelta(days=(4 - today.weekday()) % 7)
    if friday < tomorrow:
        friday += timedelta(days=7)
    friday_text = '周五' if friday <= today + timedelta(days=6 - today.weekday()) else '下周五'
    if summary_only:
        business.update_draft(draft['id'], {'purpose': '拜访客户', 'legs': [
            {'id': 'go', 'departureCity': '北京', 'arrivalCity': '上海',
             'departureDate': tomorrow.isoformat(), 'arrivalDate': tomorrow.isoformat(), 'transport': '高铁-一等座'},
            {'id': 'back', 'departureCity': '上海', 'arrivalCity': '北京', 'isReturn': True,
             'departureDate': friday.isoformat(), 'arrivalDate': friday.isoformat(), 'transport': '高铁-二等座'},
        ]})
    output_dir = ROOT / 'artifacts' / 'submission-defaults-live'
    output_dir.mkdir(parents=True, exist_ok=True)
    report = output_dir / (task_id + '.json')
    results, failure = [], None
    print(f'隔离真实模型验收开始，草稿：{draft["id"]}', flush=True)
    cases = [
        ('默认往返', f'明天去上海拜访客户，{friday_text}回来，帮我填单。'),
        ('改实际起点', '改成从北京出发，其他安排不变。'),
        ('分段指定席别', '去程坐高铁一等座，返程坐高铁二等座，其他安排不变。'),
    ]
    if summary_only:
        cases = [('摘要回归', '把去程改为高铁二等座，返程不变。')]
    try:
        for label, message in cases:
            result = await run_turn(runtime, store, task_id, draft, label, message)
            results.append(result)
            verify(result, tomorrow, friday)
            print(f'{label}：通过；回复：{result["output"]}', flush=True)
            report.write_text(json.dumps({'mode': 'direct-runtime', 'draftId': draft['id'], 'results': results}, ensure_ascii=False, indent=2))
    except Exception as error:
        failure = f'{type(error).__name__}: {error}'
    finally:
        report.write_text(json.dumps({'mode': 'direct-runtime', 'draftId': draft['id'], 'results': results, 'failure': failure}, ensure_ascii=False, indent=2))
    print(f'验收记录：{report}', flush=True)
    if failure:
        raise AssertionError(failure)
    print(f'通过：{len(cases)}轮真实模型提单；独立数据库；未提交任何单据。', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--summary-only', action='store_true', help='仅验证完整草稿中的席别小改与个人提醒摘要')
    asyncio.run(main(parser.parse_args().summary_only))
