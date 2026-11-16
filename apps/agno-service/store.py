"""SQLite is the authoritative state for the local, single-user product."""
from __future__ import annotations
import copy
import json
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


class Conflict(Exception):
    pass


def merge_submissions(current, incoming):
    """浏览器只能编辑草稿，回执、校验和已提交快照由业务事务持有。"""
    result = copy.deepcopy(current)
    editable = {
        'title', 'applicant', 'department', 'paymentCompany', 'travelType',
        'purpose', 'legs', 'activities', 'activityMode', 'companions',
        'applicationId', 'expenses', 'files', 'subsidyCents', 'materialIds',
        'sourceImportKey', 'legacyPeriod',
    }
    if not isinstance(incoming, dict):
        raise Conflict('草稿数据格式无效。')
    incoming_drafts = incoming.get('drafts', {})
    incoming_edits = incoming.get('edits', {})
    if not isinstance(incoming_drafts, dict) or not isinstance(incoming_edits, dict):
        raise Conflict('草稿数据格式无效。')
    for draft_id, original in current.get('drafts', {}).items():
        if original.get('status') != 'draft':
            result.setdefault('edits', {}).pop(draft_id, None)
            continue
        received = incoming_drafts.get(draft_id)
        saved = result['drafts'][draft_id]
        if received is not None:
            if not isinstance(received, dict):
                raise Conflict('草稿字段格式无效。')
            changed = any(key in received and received[key] != original.get(key) for key in editable)
            if changed:
                saved.update({key: copy.deepcopy(received[key]) for key in editable if key in received})
                saved['version'] = original['version'] + 1
                saved['savedAt'] = now()
                result.setdefault('checks', {}).pop(draft_id, None)
        if 'edits' in incoming:
            edit = incoming_edits.get(draft_id)
            if edit is None:
                result.setdefault('edits', {}).pop(draft_id, None)
            elif isinstance(edit, dict):
                result.setdefault('edits', {})[draft_id] = {
                    **copy.deepcopy(saved),
                    **{key: copy.deepcopy(edit[key]) for key in editable if key in edit},
                    'version': saved['version'], 'status': 'draft', 'id': draft_id,
                }
            else:
                raise Conflict('草稿编辑内容格式无效。')
    return result


def merge_rule_list(previous, incoming, detailed=False):
    """内置定义不可由客户端改写；本地用户可以显式启停。新规则只能属于个人。"""
    if not isinstance(incoming, list):
        raise Conflict('规则列表格式无效。')
    builtin = {rule['id']: rule for rule in previous if rule.get('origin') == 'builtin'}
    seen = set()
    output = []
    for received in incoming:
        if not isinstance(received, dict) or not isinstance(received.get('id'), str) or received['id'] in seen:
            raise Conflict('规则标识无效或重复。')
        rule_id = received['id']
        seen.add(rule_id)
        if rule_id in builtin:
            value = copy.deepcopy(builtin[rule_id])
            if isinstance(received.get('enabled'), bool):
                value['enabled'] = received['enabled']
            output.append(value)
            continue
        if received.get('metric') not in ('amount', 'meal', 'hotelNight', 'days', 'invoiceUnique', 'validInvoice', 'attachment') or received.get('system') not in ('oa', 'expense') or received.get('scope') not in ('both', 'submit', 'review'):
            raise Conflict('个人规则条件或范围无效。')
        value = copy.deepcopy(received)
        value['origin'] = 'personal'
        if detailed:
            value['source'] = '本人维护'
        for key in ('thresholdMinor', 'thresholdDays'):
            if key in value and (isinstance(value[key], bool) or not isinstance(value[key], int) or value[key] < 0):
                raise Conflict('规则阈值须为非负整数。')
        output.append(value)
    output.extend(copy.deepcopy(value) for key, value in builtin.items() if key not in seen)
    return output


class Store:
    def __init__(self, path, seed=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
                CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, storage_name TEXT NOT NULL);
            ''')
            if seed is None:
                seed_path = Path(__file__).with_name('seed.json')
                seed = json.loads(seed_path.read_text()) if seed_path.exists() else {'data': {}, 'tasks': [], 'activeTask': None}
            db.execute('INSERT OR IGNORE INTO workspace VALUES(1,0,?)', (encode(seed),))

    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def snapshot(self):
        with self.lock, self.connect() as db:
            row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
            return {'state': json.loads(row['state']), 'revision': row['revision']}

    def get_state(self):
        return self.snapshot()['state']

    def mutate(self, fn):
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
            state = json.loads(row['state'])
            result = fn(state)
            db.execute('UPDATE workspace SET revision=?,state=? WHERE id=1', (row['revision'] + 1, encode(state)))
            return copy.deepcopy(result)

    def patch(self, patch):
        with self.lock:
            if patch.get('baseRevision') != self.snapshot()['revision']:
                raise Conflict('数据已更新，请同步后重试。')
            def apply(state):
                updates = patch.get('data', {})
                # Receipts and ledgers can only be written by business transactions.
                protected = {'receipts', 'submissionLedger', 'documents', 'analysisRecords', 'auditDocuments', 'expenseCategories', 'policies'}
                for key, value in updates.items():
                    if key == 'submissions' and key in state['data']:
                        state['data'][key] = merge_submissions(state['data'][key], value)
                    elif key in ('rulesSubmission', 'srsRuleCenterV1') and key in state['data']:
                        previous = state['data'][key]
                        merged = copy.deepcopy(previous)
                        if not isinstance(value, dict):
                            raise Conflict('规则配置格式无效。')
                        if 'rules' in value:
                            merged['rules'] = merge_rule_list(previous['rules'], value['rules'], detailed=key == 'srsRuleCenterV1')
                        fields = ('notes', 'schedule', 'ruleForms', 'auditFilter') if key == 'rulesSubmission' else ('drafts', 'editingId')
                        for field in fields:
                            if field in value:
                                merged[field] = copy.deepcopy(value[field])
                        if key == 'rulesSubmission' and merged['rules'] != previous['rules']:
                            state['data'].get('submissions', {}).setdefault('checks', {}).clear()
                        state['data'][key] = merged
                    elif key not in protected:
                        state['data'][key] = value
                deleted = set(patch.get('deletedTaskIds', []))
                state['tasks'] = [t for t in state['tasks'] if t['id'] not in deleted or t.get('activeRunId')]
                for incoming in patch.get('tasks', []):
                    current = next((t for t in state['tasks'] if t['id'] == incoming['id']), None)
                    if current is None:
                        fresh = copy.deepcopy(incoming)
                        fresh.pop('activeRunId', None)
                        state['tasks'].append(fresh)
                        continue
                    for key in ('title', 'input', 'refs', 'capability', 'updated'):
                        if key in incoming:
                            current[key] = incoming[key]
                    known = {m['id'] for m in current.get('messages', [])}
                    current.setdefault('messages', []).extend(m for m in incoming.get('messages', []) if m['id'] not in known and not m['id'].startswith('assistant-'))
                if 'activeTask' in patch:
                    state['activeTask'] = patch['activeTask']
            self.mutate(apply)
            return self.snapshot()

    def create_run(self, run_id, task_id, request, initialize=None):
        with self.lock, self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if initialize is not None:
                row = db.execute('SELECT revision,state FROM workspace WHERE id=1').fetchone()
                state = json.loads(row['state'])
                initialize(state)
                db.execute('UPDATE workspace SET revision=?,state=? WHERE id=1', (row['revision'] + 1, encode(state)))
            db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?)', (run_id, task_id, 'running', encode(request), now(), now()))

    def run(self, run_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
            if not row:
                return None
            result = dict(row)
            result['request'] = json.loads(result['request'])
            return result

    def finish_run(self, run_id, status):
        with self.lock, self.connect() as db:
            db.execute('UPDATE runs SET status=?,updated_at=? WHERE id=?', (status, now(), run_id))

    def append_event(self, run_id, kind, data):
        with self.lock, self.connect() as db:
            cur = db.execute('INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)', (run_id, kind, encode(data), now()))
            return cur.lastrowid

    def events(self, run_id, after=0):
        with self.connect() as db:
            rows = db.execute('SELECT id,kind,data FROM events WHERE run_id=? AND id>? ORDER BY id', (run_id, after)).fetchall()
            return [{'id': row['id'], 'kind': row['kind'], 'data': json.loads(row['data'])} for row in rows]

    def recover(self):
        with self.lock, self.connect() as db:
            rows = db.execute("SELECT id,task_id FROM runs WHERE status='running'").fetchall()
        for row in rows:
            self.finish_run(row['id'], 'interrupted')
            self.append_event(row['id'], 'error', {'message': '服务已重启，上次任务已暂停，可重新发送继续。'})
            self.append_event(row['id'], 'done', {})
        if rows or any(t.get('activeRunId') for t in self.get_state()['tasks']):
            def recover_state(state):
                for task in state['tasks']:
                    if task.get('activeRunId'):
                        message_id = 'assistant-' + task['activeRunId']
                        if not any(m['id'] == message_id for m in task.get('messages', [])):
                            task.setdefault('messages', []).append({'id': message_id, 'role': 'assistant', 'text': '服务已重启，上次任务已暂停，可重新发送继续。'})
                        task['activeRunId'] = None
                        task['status'] = '已暂停'
            self.mutate(recover_state)

    def add_file(self, metadata, storage_name):
        with self.lock, self.connect() as db:
            db.execute('INSERT INTO files VALUES(?,?,?)', (metadata['id'], encode(metadata), storage_name))

    def get_file(self, file_id):
        with self.connect() as db:
            row = db.execute('SELECT metadata,storage_name FROM files WHERE id=?', (file_id,)).fetchone()
            return {'metadata': json.loads(row['metadata']), 'storage_name': row['storage_name']} if row else None

    def list_files(self):
        with self.connect() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT metadata FROM files ORDER BY rowid DESC').fetchall()]
