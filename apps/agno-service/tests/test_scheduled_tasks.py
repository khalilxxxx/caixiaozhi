from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo
import asyncio
import threading

import pytest

from store import Store
from scheduled_tasks import ScheduledTasks, ScheduleError, next_occurrence

TZ = ZoneInfo('Asia/Shanghai')


def at(day=17, hour=8, minute=0):
    return datetime(2026, 11, day, hour, minute, tzinfo=TZ)


def spec(**changes):
    return dict(name='每日整理我的工作', kind='audit', prompt='', frequency='daily', time='09:00',
                weekdays=[], date='', enabled=True, **changes)


@pytest.fixture
def manager(tmp_path):
    return ScheduledTasks(Store(tmp_path/'schedule.db', {'data': {}, 'tasks': [], 'activeTask': None}), clock=lambda: at())


def test_schedule_dates_and_beijing_timezone():
    assert next_occurrence(spec(), at(hour=9)) == at(day=18, hour=9)
    workday = {**spec(), 'frequency': 'weekdays'}
    assert next_occurrence(workday, at(day=20, hour=10)) == at(day=23, hour=9)
    weekly = {**spec(), 'frequency': 'weekly', 'weekdays': [1, 5]}
    assert next_occurrence(weekly, at(day=20, hour=9)) == at(day=23, hour=9)
    once = {**spec(), 'frequency': 'once', 'date': '2026-11-17'}
    assert next_occurrence(once, at(hour=9)) is None
    assert next_occurrence(spec(), at().astimezone(ZoneInfo('UTC'))) == at(hour=9)


def test_crud_versions_and_validation(manager):
    job = manager.create(spec())
    assert job['nextRunAt'] == at(hour=9).isoformat()
    changed = manager.update(job['id'], {'name': '新名称', 'version': job['version']})
    with pytest.raises(ScheduleError):
        manager.update(job['id'], {'enabled': False, 'version': job['version']})
    manager.update(job['id'], {'enabled': False, 'version': changed['version']})
    assert manager.list()[0]['nextRunAt'] is None
    for change in [{'time': '24:00'}, {'frequency': 'weekly', 'weekdays': []},
                   {'frequency': 'once', 'date': '2026-11-16'}, {'kind': 'agent', 'prompt': ''}, {'enabled': 'false'}]:
        with pytest.raises(ScheduleError):
            manager.create({**spec(), **change})


def test_due_claim_is_atomic_and_survives_reopening(manager):
    job = manager.create(spec())
    def claim(_):
        other = ScheduledTasks(Store(manager.store.path), clock=lambda: at())
        return other.claim(job['id'], scheduled=True, current=at(hour=9))
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(claim, range(4)))
    assert sum(item is not None for item in claims) == 1
    assert len(manager.history(job['id'])) == 1
    assert manager.get(job['id'])['nextRunAt'] == at(day=18, hour=9).isoformat()
    with pytest.raises(ScheduleError):
        manager.claim(job['id'])
    with pytest.raises(ScheduleError):
        manager.delete(job['id'], job['version'])


def test_manual_run_does_not_move_schedule_and_failure_is_preserved(manager):
    job = manager.create(spec())
    run = manager.claim(job['id'])
    assert manager.get(job['id'])['nextRunAt'] == job['nextRunAt']
    manager.finish(run['id'], 'failed', error='本地业务暂不可用')
    assert manager.history(job['id'])[0]['error'] == '本地业务暂不可用'
    manager.delete(job['id'], job['version'])
    assert manager.list() == []


def test_missed_once_and_recovery_are_not_replayed(manager):
    once = manager.create({**spec(), 'frequency': 'once', 'date': '2026-11-17'})
    missed = manager.claim(once['id'], scheduled=True, current=at(hour=10))
    assert missed['status'] == 'missed'
    assert not manager.get(once['id'])['enabled']
    assert manager.claim(once['id'], scheduled=True, current=at(hour=10)) is None
    job = manager.create(spec())
    manager.claim(job['id'])
    manager.recover()
    assert manager.history(job['id'])[0]['status'] == 'interrupted'


def test_legacy_config_migrates_once_without_reappearing(manager):
    manager.store.mutate(lambda state: state['data'].update(rulesSubmission={'schedule': {'enabled': True, 'time': '08:30'}}))
    migrated = ScheduledTasks(manager.store, clock=lambda: at())
    legacy = migrated.list()[0]
    assert legacy['time'] == '08:30'
    migrated.delete(legacy['id'], legacy['version'])
    assert ScheduledTasks(manager.store, clock=lambda: at()).list() == []


def test_pause_resume_and_overlapping_daily_run(manager):
    job = manager.create(spec())
    manager.claim(job['id'], scheduled=True, current=at(hour=9))
    overlap = manager.claim(job['id'], scheduled=True, current=at(day=18, hour=9))
    assert overlap['status'] == 'skipped'
    paused = manager.update(job['id'], {'version': job['version'], 'enabled': False})
    assert manager.claim(job['id'], scheduled=True, current=at(day=19, hour=9)) is None
    assert manager.get(job['id'])['nextRunAt'] is None
    manager.clock = lambda: at(day=19, hour=10)
    resumed = manager.update(job['id'], {'version': paused['version'], 'enabled': True})
    assert resumed['nextRunAt'] == at(day=20, hour=9).isoformat()


def test_actual_audit_execution_persists_results_without_switching_active_chat(tmp_path):
    from business import Business
    store = Store(tmp_path/'actual.db')
    manager = ScheduledTasks(store, Business(store), clock=lambda: at())
    job = manager.create(spec())
    original_active = store.get_state()['activeTask']
    run = manager.claim(job['id'])
    asyncio.run(manager._execute(run, threading.Event()))
    history = manager.history(job['id'])[0]
    assert history['status'] == 'completed'
    assert '已预审' in history['summary']
    assert history['taskId'] in [task['id'] for task in store.get_state()['tasks']]
    assert store.get_state()['activeTask'] == original_active


def test_execution_error_and_missing_model_are_not_success(manager, monkeypatch):
    import config
    class FailingBusiness:
        def preaudit(self, **kwargs):
            raise RuntimeError('业务数据读取失败')
    manager.business = FailingBusiness()
    job = manager.create(spec())
    asyncio.run(manager._execute(manager.claim(job['id']), threading.Event()))
    assert manager.history(job['id'])[0]['error'] == '业务数据读取失败'
    monkeypatch.setattr(config, 'API_KEY', '')
    job = manager.create({**spec(), 'kind': 'agent', 'prompt': '查询待办'})
    asyncio.run(manager._execute(manager.claim(job['id']), threading.Event()))
    assert manager.history(job['id'])[0]['status'] == 'failed'
    assert '尚未配置模型' in manager.history(job['id'])[0]['error']


def test_agent_runs_keep_prompt_and_reconcile_waiting_input(manager, monkeypatch):
    import config
    monkeypatch.setattr(config, 'API_KEY', 'test-key-not-used')
    class StubRuntime:
        tasks = {}
        def launch(self, run_id):
            run = manager.store.run(run_id)
            assert run['request']['message'] == '汇总本月费用'
            def answer(state):
                task = next(task for task in state['tasks'] if task['id'] == run['task_id'])
                task['messages'].append({'role': 'assistant', 'text': '请选择费用所属部门。'})
                task['activeRunId'] = None
            manager.store.mutate(answer)
            manager.store.finish_run(run_id, 'awaiting_input')
    manager.runtime = StubRuntime()
    job = manager.create({**spec(), 'kind': 'agent', 'prompt': '汇总本月费用'})
    asyncio.run(manager._execute(manager.claim(job['id']), threading.Event()))
    manager.reconcile()
    run = manager.history(job['id'])[0]
    assert run['status'] == 'awaiting_input'
    assert run['summary'] == '请选择费用所属部门。'


def test_api_crud_history_and_version_conflicts(tmp_path):
    from fastapi.testclient import TestClient
    from server import create_app
    store = Store(tmp_path/'api.db', {'data': {}, 'tasks': [], 'activeTask': None})
    with TestClient(create_app(store)) as client:
        created = client.post('/api/local/schedules', json=spec())
        assert created.status_code == 200
        job = created.json()['item']
        changed = client.patch('/api/local/schedules/'+job['id'], json={'version': job['version'], 'enabled': False})
        assert changed.status_code == 200
        assert client.patch('/api/local/schedules/'+job['id'], json={'version': job['version'], 'name': '过期编辑'}).status_code == 409
        assert client.get('/api/local/schedules/'+job['id']+'/runs').json()['items'] == []
        assert client.delete('/api/local/schedules/'+job['id']+'?version=2').status_code == 200
        assert client.get('/api/local/schedules').json()['items'] == []
        assert client.get('/api/local/schedules/'+job['id']+'/runs').status_code == 404


def test_tick_dispatches_due_job_once_and_respects_capacity(manager):
    calls = []
    class AuditBusiness:
        def preaudit(self, **kwargs):
            calls.append(True)
            return {'items': [], 'counts': {'attention': 0, 'unknown': 0, 'clear': 0}}
    manager.business = AuditBusiness()
    job = manager.create(spec())
    manager.clock = lambda: at(hour=9)
    async def check():
        manager.workers.update({str(i): object() for i in range(4)})
        await manager.tick()
        assert manager.history(job['id']) == []
        manager.workers.clear()
        await manager.tick()
        await asyncio.gather(*list(manager.workers.values()))
        await manager.tick()
        assert len(calls) == 1
        assert manager.history(job['id'])[0]['status'] == 'completed'
        await manager.close()
    asyncio.run(check())
