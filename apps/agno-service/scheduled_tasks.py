"""本机单用户定时任务：持久化、事务认领、真实执行记录。"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from store import encode

TZ = ZoneInfo('Asia/Shanghai')
AUDIT_PROMPT = '整理我的工作，预审待本人审核的单据并汇总需要关注的事项。'


class ScheduleError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def next_occurrence(spec, after):
    after = after.astimezone(TZ)
    hour, minute = map(int, spec['time'].split(':'))
    if spec['frequency'] == 'once':
        candidate = datetime.fromisoformat(spec['date']).replace(hour=hour, minute=minute, tzinfo=TZ)
        return candidate if candidate > after else None
    for offset in range(8):
        candidate = (after + timedelta(days=offset)).replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= after:
            continue
        if spec['frequency'] == 'weekdays' and candidate.isoweekday() > 5:
            continue
        if spec['frequency'] == 'weekly' and candidate.isoweekday() not in spec['weekdays']:
            continue
        return candidate
    return None


def validate(payload, current):
    name = payload.get('name')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
        raise ScheduleError('任务名称请填写1～60个字。')
    kind = payload.get('kind')
    if kind not in ('audit', 'agent'):
        raise ScheduleError('请选择有效的任务类型。')
    prompt = payload.get('prompt', '')
    if kind == 'audit':
        prompt = AUDIT_PROMPT
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 4000:
        raise ScheduleError('执行内容请填写1～4000个字。')
    frequency = payload.get('frequency')
    if frequency not in ('daily', 'weekdays', 'weekly', 'once'):
        raise ScheduleError('请选择有效的执行频率。')
    at = payload.get('time', '')
    if not isinstance(at, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', at):
        raise ScheduleError('请填写有效的执行时间。')
    enabled = payload.get('enabled', True)
    if not isinstance(enabled, bool):
        raise ScheduleError('启停状态无效。')
    weekdays = payload.get('weekdays', [])
    if not isinstance(weekdays, list) or any(type(day) is not int or day not in range(1, 8) for day in weekdays):
        raise ScheduleError('每周执行日期无效。')
    if frequency == 'weekly' and not weekdays:
        raise ScheduleError('请至少选择一个执行日。')
    date = payload.get('date', '')
    if frequency == 'once':
        try:
            if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
                raise ValueError()
            datetime.fromisoformat(date)
        except ValueError:
            raise ScheduleError('请填写有效的执行日期。') from None
    result = dict(name=name.strip(), kind=kind, prompt=prompt.strip(), frequency=frequency, time=at,
                  weekdays=sorted(set(weekdays)) if frequency == 'weekly' else [],
                  date=date if frequency == 'once' else '', enabled=enabled, timezone='Asia/Shanghai')
    next_at = next_occurrence(result, current) if enabled else None
    if enabled and not next_at:
        raise ScheduleError('单次执行时间须晚于当前时间。')
    result['nextRunAt'] = next_at.isoformat() if next_at else None
    return result


class ScheduledTasks:
    def __init__(self, store, business=None, runtime=None, clock=None):
        self.store, self.business, self.runtime = store, business, runtime
        self.clock = clock or (lambda: datetime.now(TZ))
        self.workers = {}
        self.stops = {}
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS scheduled_executions (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES scheduled_tasks(id), slot TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(schedule_id,slot));
                CREATE INDEX IF NOT EXISTS scheduled_executions_job ON scheduled_executions(schedule_id);
            ''')
        legacy = store.get_state()['data'].get('rulesSubmission', {}).get('schedule')
        if isinstance(legacy, dict) and re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', str(legacy.get('time', ''))):
            current = self.clock()
            task = validate(dict(name='每日待办预审', kind='audit', frequency='daily', time=legacy['time'], enabled=bool(legacy.get('enabled'))), current)
            task.update(id='legacy-daily-audit', version=1, createdAt=current.isoformat(), updatedAt=current.isoformat())
            with store.connect() as db:
                db.execute('INSERT OR IGNORE INTO scheduled_tasks(id,payload) VALUES(?,?)', (task['id'], encode(task)))

    def _row(self, db, task_id):
        row = db.execute('SELECT payload FROM scheduled_tasks WHERE id=? AND deleted=0', (task_id,)).fetchone()
        if not row:
            raise ScheduleError('定时任务不存在或已删除。', 404)
        return json.loads(row['payload'])

    def get(self, task_id):
        with self.store.connect() as db:
            return self._row(db, task_id)

    def list(self):
        with self.store.connect() as db:
            items = [json.loads(row['payload']) for row in db.execute('SELECT payload FROM scheduled_tasks WHERE deleted=0')]
            for item in items:
                row = db.execute('SELECT payload FROM scheduled_executions WHERE schedule_id=? ORDER BY rowid DESC LIMIT 1', (item['id'],)).fetchone()
                item['lastRun'] = json.loads(row['payload']) if row else None
                item['running'] = db.execute("SELECT 1 FROM scheduled_executions WHERE schedule_id=? AND status='running'", (item['id'],)).fetchone() is not None
        return sorted(items, key=lambda item: item['createdAt'], reverse=True)

    def create(self, payload):
        current = self.clock()
        task = validate(payload, current)
        task.update(id='schedule-' + uuid.uuid4().hex, version=1, createdAt=current.isoformat(), updatedAt=current.isoformat())
        with self.store.lock, self.store.connect() as db:
            db.execute('INSERT INTO scheduled_tasks(id,payload) VALUES(?,?)', (task['id'], encode(task)))
        return task

    def update(self, task_id, payload):
        with self.store.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            original = self._row(db, task_id)
            if payload.get('version') != original['version']:
                raise ScheduleError('任务已更新，请刷新后再修改。', 409)
            current = self.clock()
            changes = {key: value for key, value in payload.items() if key in ('name', 'kind', 'prompt', 'frequency', 'time', 'weekdays', 'date', 'enabled')}
            updated = {**original, **validate({**original, **changes}, current)}
            timing_changed = any(updated[key] != original[key] for key in ('frequency', 'time', 'weekdays', 'date', 'enabled'))
            if not timing_changed:
                updated['nextRunAt'] = original['nextRunAt']
            updated.update(version=original['version'] + 1, updatedAt=current.isoformat())
            db.execute('UPDATE scheduled_tasks SET payload=? WHERE id=?', (encode(updated), task_id))
        return updated

    def delete(self, task_id, version):
        with self.store.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            task = self._row(db, task_id)
            if task['version'] != version:
                raise ScheduleError('任务已更新，请刷新后再删除。', 409)
            if db.execute("SELECT 1 FROM scheduled_executions WHERE schedule_id=? AND status='running'", (task_id,)).fetchone():
                raise ScheduleError('任务正在执行，请等待完成后再删除。', 409)
            db.execute('UPDATE scheduled_tasks SET deleted=1 WHERE id=?', (task_id,))

    def history(self, task_id):
        with self.store.connect() as db:
            self._row(db, task_id)
            return [json.loads(row['payload']) for row in db.execute('SELECT payload FROM scheduled_executions WHERE schedule_id=? ORDER BY rowid DESC LIMIT 100', (task_id,))]

    def claim(self, task_id, scheduled=False, current=None):
        current = (current or self.clock()).astimezone(TZ)
        with self.store.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            task = self._row(db, task_id)
            due = datetime.fromisoformat(task['nextRunAt']) if task['nextRunAt'] else None
            if scheduled and (not task['enabled'] or due is None or due > current):
                return None
            running = db.execute("SELECT 1 FROM scheduled_executions WHERE schedule_id=? AND status='running'", (task_id,)).fetchone()
            if running and not scheduled:
                raise ScheduleError('此任务正在执行，请勿重复运行。', 409)
            slot = due.isoformat() if scheduled else 'manual-' + uuid.uuid4().hex
            status = 'skipped' if running else 'missed' if scheduled and current - due > timedelta(minutes=15) else 'running'
            record = dict(id='scheduled-run-' + uuid.uuid4().hex, scheduleId=task_id, name=task['name'],
                          kind=task['kind'], prompt=task['prompt'], trigger='scheduled' if scheduled else 'manual',
                          status=status, scheduledAt=due.isoformat() if scheduled else None,
                          startedAt=current.isoformat(), finishedAt=None if status == 'running' else current.isoformat(),
                          summary='', error='上次执行尚未完成，本次已跳过。' if running else '已错过执行时间，未自动补跑。' if status == 'missed' else '',
                          taskId=None, runId=None)
            cursor = db.execute('INSERT OR IGNORE INTO scheduled_executions VALUES(?,?,?,?,?)', (record['id'], task_id, slot, status, encode(record)))
            if cursor.rowcount == 0:
                return None
            if scheduled:
                following = next_occurrence(task, current)
                task['nextRunAt'] = following.isoformat() if following else None
                if following is None:
                    task['enabled'] = False
                db.execute('UPDATE scheduled_tasks SET payload=? WHERE id=?', (encode(task), task_id))
            return record

    def finish(self, execution_id, status, **fields):
        with self.store.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT payload FROM scheduled_executions WHERE id=?', (execution_id,)).fetchone()
            if row is None:
                return
            record = json.loads(row['payload'])
            if record['status'] != 'running':
                return
            record.update(fields, status=status)
            if status != 'running':
                record['finishedAt'] = self.clock().isoformat()
            db.execute('UPDATE scheduled_executions SET status=?,payload=? WHERE id=?', (status, encode(record), execution_id))

    def recover(self):
        with self.store.connect() as db:
            ids = [row['id'] for row in db.execute("SELECT id FROM scheduled_executions WHERE status='running'")]
        for execution_id in ids:
            self.finish(execution_id, 'interrupted', error='本地服务已重启，上次执行中断；未自动重复运行。')

    def reconcile(self):
        with self.store.connect() as db:
            records = [json.loads(row['payload']) for row in db.execute("SELECT payload FROM scheduled_executions WHERE status='running'")]
        for record in records:
            if not record['runId']:
                continue
            run = self.store.run(record['runId'])
            if not run or run['status'] == 'running':
                continue
            task = next((task for task in self.store.get_state()['tasks'] if task['id'] == record['taskId']), {})
            message = next((m for m in reversed(task.get('messages', [])) if m.get('role') == 'assistant'), {})
            status = run['status'] if run['status'] in ('completed', 'awaiting_input', 'failed', 'cancelled', 'interrupted') else 'failed'
            self.finish(record['id'], status, summary=message.get('text', '')[:6000],
                        error=message.get('text', '')[:1000] if status in ('failed', 'interrupted', 'cancelled') else '')

    def launch(self, record):
        if record is None or record['status'] != 'running':
            return
        stop = threading.Event()
        self.stops[record['id']] = stop
        task = asyncio.create_task(self._execute(record, stop))
        self.workers[record['id']] = task
        def done(_):
            self.workers.pop(record['id'], None)
            self.stops.pop(record['id'], None)
        task.add_done_callback(done)

    def at_capacity(self):
        return len(self.workers) + (len(self.runtime.tasks) if self.runtime else 0) >= 4

    async def _execute(self, record, stop):
        try:
            if record['kind'] == 'agent':
                import config
                if not config.API_KEY:
                    raise ScheduleError('尚未配置模型，自定义任务未执行。')
                if not self.runtime or len(self.runtime.tasks) >= 4:
                    raise ScheduleError('当前任务较多，本次未能执行，请稍后手动运行。')
                task_id, run_id = 'scheduled-chat-' + uuid.uuid4().hex, 'run-' + uuid.uuid4().hex
                request = dict(taskId=task_id, message=record['prompt'], refs=[], capability=None)
                def initialize(state):
                    state['tasks'].insert(0, dict(id=task_id, title=record['name'], status='处理中', type='chat',
                        messages=[dict(id='user-' + uuid.uuid4().hex, role='user', text=record['prompt'], createdAt=int(self.clock().timestamp()*1000))],
                        input='', refs=[], updated='刚刚', activeRunId=run_id))
                self.store.create_run(run_id, task_id, request, initialize=initialize)
                self.finish(record['id'], 'running', taskId=task_id, runId=run_id)
                self.runtime.launch(run_id)
                return
            def check_cancel():
                if stop.is_set():
                    raise RuntimeError('本次执行已中断。')
            result = await asyncio.to_thread(self.business.preaudit, cancel_check=check_cancel)
            counts = result['counts']
            summary = f"已预审{len(result['items'])}张待办单据，{counts['attention']}张需关注，{counts['unknown']}张待核实，{counts['clear']}张未发现异常。"
            task_id = 'scheduled-chat-' + uuid.uuid4().hex
            def publish(state):
                state['tasks'].insert(0, dict(id=task_id, title=record['name'], status='已完成', type='audit',
                    messages=[dict(id='assistant-' + uuid.uuid4().hex, role='assistant', text=summary,
                                   cards=result.get('cards', []), createdAt=int(self.clock().timestamp()*1000))],
                    input='', refs=[], updated='刚刚'))
            self.store.mutate(publish)
            self.finish(record['id'], 'completed', summary=summary, taskId=task_id)
        except asyncio.CancelledError:
            stop.set()
            self.finish(record['id'], 'interrupted', error='服务停止，本次执行已中断。')
            raise
        except Exception as error:
            self.finish(record['id'], 'failed', error=str(error)[:1000] or '本次执行失败，请稍后重试。')

    async def tick(self):
        self.reconcile()
        current = self.clock()
        for job in self.list():
            if self.at_capacity():
                break
            if job['enabled'] and job['nextRunAt'] and datetime.fromisoformat(job['nextRunAt']) <= current:
                try:
                    self.launch(self.claim(job['id'], scheduled=True, current=current))
                except ScheduleError as error:
                    if error.status != 404:
                        raise

    async def close(self):
        for stop in self.stops.values():
            stop.set()
        tasks = list(self.workers.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
