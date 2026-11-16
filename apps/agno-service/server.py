from __future__ import annotations
import asyncio
import json
import time
import uuid
import logging
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from pydantic import BaseModel, Field
import config
from store import Store, Conflict
from business import Business, BusinessError
from agent_runtime import Runtime, generate_rule
from file_service import save_file
from scheduler import tick


class RunRequest(BaseModel):
    taskId: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=20000)
    refs: list[dict] = Field(default_factory=list, max_length=30)
    capability: str | None = None


def create_app(store=None):
    store = store or Store(config.DATA_DIR / 'workspace.sqlite3')
    business = Business(store)
    runtime = Runtime(store, business)

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        async def schedules():
            while True:
                try:
                    tick(store, business)
                except Exception as error:
                    logging.getLogger(__name__).warning('预审调度失败 (%s)', type(error).__name__)
                await asyncio.sleep(15)
        scheduler_task = asyncio.create_task(schedules())
        yield
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass
        for run_id in list(runtime.tasks):
            await runtime.cancel(run_id)

    app = FastAPI(title='财小智本地 Agno', version='0.1.0', lifespan=lifespan, docs_url='/api/local/docs', openapi_url='/api/local/openapi.json')
    app.state.store = store
    app.state.runtime = runtime

    @app.middleware('http')
    async def local_boundary(request, call_next):
        if request.url.hostname not in {'127.0.0.1', 'localhost', 'testserver'}:
            return JSONResponse({'message': '仅允许本机访问。'}, status_code=403)
        origin = request.headers.get('origin')
        if origin and origin not in config.ALLOWED_ORIGINS:
            return JSONResponse({'message': '请求来源不受信任。'}, status_code=403)
        length = request.headers.get('content-length', '0')
        if length.isdigit() and int(length) > config.MAX_FILE_BYTES + 1024*1024:
            return JSONResponse({'message': '单个文件不能超过10MB。'}, status_code=413)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.exception_handler(BusinessError)
    async def business_error(request, error):
        code = getattr(error, 'code', '')
        status = 409 if any(x in code.lower() for x in ('conflict', 'version', 'locked', 'duplicate')) else 422
        return JSONResponse({'message': getattr(error, 'message', str(error)), 'code': code, 'details': getattr(error, 'details', None)}, status_code=status)

    @app.exception_handler(ValueError)
    async def invalid_input(request, error):
        return JSONResponse({'message': str(error)[:500]}, status_code=422)

    @app.get('/api/local/health')
    async def health():
        store.snapshot()
        return {'status': 'ready', 'framework': 'Agno', 'version': version('agno'), 'modelConfigured': bool(config.API_KEY), 'model': config.MODEL, 'dataSource': '本地模拟业务数据', 'activeRuns': len(runtime.tasks)}

    @app.get('/api/local/workspace')
    async def workspace():
        return store.snapshot()

    @app.patch('/api/local/workspace')
    async def patch_workspace(payload: dict):
        if not isinstance(payload.get('data', {}), dict) or not isinstance(payload.get('tasks', []), list):
            raise ValueError('工作空间格式无效。')
        if len(json.dumps(payload)) > 4*1024*1024:
            raise ValueError('本次保存内容过大，请分次处理。')
        try:
            return store.patch(payload)
        except Conflict:
            return JSONResponse({'message': '数据已更新，正在重新同步。', **store.snapshot()}, status_code=409)

    @app.post('/api/local/runs')
    async def create_run(payload: RunRequest):
        if not payload.message.strip():
            raise ValueError('请输入消息内容。')
        if not config.API_KEY:
            return JSONResponse({'message': '尚未配置模型，请配置本地 AGNO_API_KEY 后重启服务。'}, status_code=503)
        if len(runtime.tasks) >= 4:
            return JSONResponse({'message': '正在处理其他任务，请稍后再试。'}, status_code=429)
        run_id = 'run-' + uuid.uuid4().hex
        with store.lock:
            current = next((t for t in store.get_state()['tasks'] if t['id'] == payload.taskId), None)
            if current and current.get('activeRunId'):
                return JSONResponse({'message': '该会话已有进行中的任务。'}, status_code=409)
            def begin(state):
                task = next((t for t in state['tasks'] if t['id'] == payload.taskId), None)
                if task is None:
                    task = {'id': payload.taskId, 'title': payload.message[:24], 'status': '处理中', 'type': 'chat', 'messages': [], 'input': '', 'refs': [], 'updated': '刚刚'}
                    state['tasks'].insert(0, task)
                messages = task['messages']
                if not messages or messages[-1].get('role') != 'user' or messages[-1].get('text') != payload.message:
                    messages.append({'id': 'user-' + uuid.uuid4().hex, 'role': 'user', 'text': payload.message, 'createdAt': int(time.time()*1000)})
                task.update(activeRunId=run_id, status='处理中', refs=payload.refs, capability=payload.capability, input='')
                state['activeTask'] = task['id']
            store.create_run(run_id, payload.taskId, payload.model_dump(), initialize=begin)
        runtime.launch(run_id)
        return {'runId': run_id, 'taskId': payload.taskId}

    @app.get('/api/local/runs/{run_id}')
    async def get_run(run_id: str):
        run = store.run(run_id)
        if not run:
            return JSONResponse({'message': '任务不存在。'}, status_code=404)
        return {**run, 'events': store.events(run_id)}

    @app.get('/api/local/runs/{run_id}/events')
    async def events(run_id: str, request: Request, after: int = 0):
        if not store.run(run_id):
            return JSONResponse({'message': '任务不存在。'}, status_code=404)
        last_header = request.headers.get('last-event-id', '')
        if last_header.isdigit():
            after = max(after, int(last_header))
        async def stream():
            cursor = after
            heartbeat = 0
            while True:
                if await request.is_disconnected():
                    break
                batch = store.events(run_id, cursor)
                for event in batch:
                    cursor = event['id']
                    yield f"id: {cursor}\nevent: {event['kind']}\ndata: {json.dumps(event['data'], ensure_ascii=False)}\n\n"
                    if event['kind'] == 'done':
                        return
                if not batch and store.run(run_id)['status'] != 'running':
                    return
                heartbeat += 1
                if heartbeat % 60 == 0:
                    yield ': keep-alive\n\n'
                await asyncio.sleep(0.2)
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'})

    @app.post('/api/local/runs/{run_id}/cancel')
    async def cancel_run(run_id: str):
        if not store.run(run_id):
            return JSONResponse({'message': '任务不存在。'}, status_code=404)
        return await runtime.cancel(run_id)

    @app.post('/api/local/files')
    async def upload(file: UploadFile = File(...)):
        chunks, size = [], 0
        while chunk := await file.read(1024*1024):
            size += len(chunk)
            if size > config.MAX_FILE_BYTES:
                return JSONResponse({'message': '单个文件不能超过10MB。'}, status_code=413)
            chunks.append(chunk)
        if not size:
            raise ValueError('文件内容为空。')
        metadata = save_file(store, config.DATA_DIR / 'files', file.filename or '', file.content_type, b''.join(chunks))
        return {'file': metadata}

    @app.get('/api/local/files')
    async def files():
        return {'files': store.list_files()}

    @app.get('/api/local/files/{file_id}/download')
    async def download(file_id: str):
        row = store.get_file(file_id)
        if not row:
            return JSONResponse({'message': '文件不存在或仅为合成样例。'}, status_code=404)
        path = config.DATA_DIR / 'files' / row['storage_name']
        if not path.is_file():
            return JSONResponse({'message': '文件内容已不可用。'}, status_code=404)
        return FileResponse(path, filename=row['metadata']['name'], media_type='application/octet-stream')

    @app.post('/api/local/business/validate')
    async def validate(payload: dict):
        return business.validate_draft(payload.get('id', 'expense'))

    @app.post('/api/local/business/submit')
    async def submit(payload: dict):
        if not isinstance(payload.get('version'), int) or not payload.get('idempotencyKey'):
            raise ValueError('提交需要当前版本和幂等编号。')
        return business.submit_draft(payload.get('id', 'expense'), payload['version'], payload['idempotencyKey'])

    @app.post('/api/local/business/new-draft')
    async def new_draft(payload: dict):
        return business.new_draft(payload.get('id', 'expense'))

    @app.get('/api/local/receipts/{receipt_id}')
    async def receipt(receipt_id: str):
        return business.get_receipt(receipt_id)

    @app.post('/api/local/business/preaudit')
    async def preaudit(payload: dict):
        return business.preaudit(payload.get('system'), payload.get('ids'))

    @app.post('/api/local/business/documents')
    async def documents(payload: dict):
        return business.query_documents(payload.get('query', ''))

    @app.post('/api/local/business/analyze')
    async def analyze(payload: dict):
        return business.analyze(payload.get('month', '10'), payload.get('dept', '全部部门'), payload.get('type'))

    @app.post('/api/local/business/knowledge')
    async def knowledge(payload: dict):
        return business.search_knowledge(payload.get('query', ''))

    @app.post('/api/local/business/draft')
    async def draft(payload: dict):
        if 'patch' in payload:
            return business.update_draft(payload.get('id', 'expense'), payload['patch'])
        return business.get_draft(payload.get('id', 'expense'))

    @app.post('/api/local/sources/{source_id}/retry')
    async def retry_source(source_id: str):
        if source_id not in {'oa', 'expense', 'travel', 'payment', 'contract', 'budget', 'treasury', 'local'}:
            raise ValueError('未知业务来源。')
        # Local adapter reads SQLite successfully before publishing its availability.
        business.query_documents('')
        def mark(state):
            state['data'].setdefault('documentSources', {}).setdefault('states', {})[source_id] = 'ready'
        store.mutate(mark)
        return {'status': 'ready', 'source': source_id, 'dataSource': '本地模拟业务数据'}

    @app.post('/api/local/generate/rule')
    async def rule(payload: dict):
        text = str(payload.get('text', '')).strip()
        if not text or len(text) > 4000:
            raise ValueError('请填写4000字以内的检查需求。')
        try:
            result = await generate_rule(text)
            base = payload.get('base')
            if base and base.get('origin') == 'personal':
                result['rule'].update(id=base['id'], version=base.get('version', 1), revisions=base.get('revisions', []))
            return result
        except ValueError:
            raise
        except Exception:
            return JSONResponse({'message': '规则生成失败，请检查模型连接后重试。'}, status_code=502)

    return app


app = create_app()
