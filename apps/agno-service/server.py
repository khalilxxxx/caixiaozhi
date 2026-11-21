from __future__ import annotations
import asyncio
import json
import time
import uuid
import logging
from typing import Literal
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, Request, UploadFile, File
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
import config
from store import Store, Conflict
from business import Business, BusinessError
from agent_runtime import Runtime, generate_rule, model
from rule_service import SemanticRuleService, validate_semantic_rule
from rule_catalog import demo_cases
from expert_teams import TeamError, TeamRequest, is_team
from file_service import save_file
from reimbursement_routes import register_reimbursement_routes
from scheduled_tasks import ScheduledTasks
from scheduled_task_routes import register_scheduled_task_routes
from translation_service import TranslationService, TranslationError
from clarification_service import QuestionError, answer_question
from work_decisions import decision_context, decide


class QuestionAnswer(BaseModel):
    questionId: str = Field(min_length=1, max_length=200)
    optionIds: list[str] = Field(default_factory=list, max_length=6)
    text: str = Field(default='', max_length=20000)
    deferred: bool = False


class RunRequest(BaseModel):
    taskId: str = Field(min_length=1, max_length=200)
    message: str = Field(default='', max_length=20000)
    refs: list[dict] = Field(default_factory=list, max_length=30)
    capability: str | None = None
    questionAnswer: QuestionAnswer | None = None
    preserveComposerDraft: bool = False


class MaterialExtractRequest(BaseModel):
    fileIds: list[str] = Field(min_length=1, max_length=10)
    draftId: str | None = Field(default=None, min_length=1, max_length=200)


class ExpenseSummaryRequest(BaseModel):
    fileId: str = Field(min_length=1, max_length=200)


class PublicFinancialReportRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    year: StrictInt = 2025
    datasetId: StrictStr | None = Field(default=None, min_length=1, max_length=200)
    datasetVersion: StrictStr | None = Field(default=None, min_length=1, max_length=200)


class WorkReviewAck(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reviewHash: StrictStr = Field(pattern=r'^[0-9a-f]{64}$')
    findingIds: list[StrictStr] = Field(max_length=1000)


class WorkDecisionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    decision: Literal['approve', 'return']
    expectedVersion: StrictInt = Field(ge=1)
    idempotencyKey: StrictStr = Field(min_length=1, max_length=200)
    reason: StrictStr = Field(default='', max_length=1000)
    reviewAck: WorkReviewAck


def create_app(store=None, rule_service=None):
    store = store or Store(config.DATA_DIR / 'workspace.sqlite3')
    semantic_rules = rule_service or SemanticRuleService(model)
    business = Business(store, rule_service=semantic_rules)
    runtime = Runtime(store, business)
    scheduled_tasks = ScheduledTasks(store, business, runtime)
    translations = TranslationService(store)

    @asynccontextmanager
    async def lifespan(app):
        store.recover()
        scheduled_tasks.recover()
        async def schedules():
            while True:
                try:
                    await scheduled_tasks.tick()
                except Exception as error:
                    logging.getLogger(__name__).warning('任务调度失败 (%s)', type(error).__name__)
                await asyncio.sleep(15)
        scheduler_task = asyncio.create_task(schedules())
        yield
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass
        await scheduled_tasks.close()
        for run_id in list(runtime.tasks):
            await runtime.cancel(run_id)

    app = FastAPI(title='财小智本地 Agno', version='0.1.0', lifespan=lifespan, docs_url='/api/local/docs', openapi_url='/api/local/openapi.json')
    app.state.store = store
    app.state.runtime = runtime
    app.state.translations = translations
    app.state.scheduled_tasks = scheduled_tasks
    register_reimbursement_routes(app, runtime.reimbursements)
    register_scheduled_task_routes(app, scheduled_tasks)
    from skill_routes import register_skill_routes
    register_skill_routes(app, store, config.DATA_DIR)

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
        status = 409 if code == 'STALE_DRAFT' or any(x in code.lower() for x in ('conflict', 'version', 'locked', 'duplicate')) else 422
        if code == 'WORK_DOCUMENT_NOT_FOUND':
            status = 404
        elif code == 'WORK_DECISION_FORBIDDEN':
            status = 403
        elif code == 'BUSINESS_BLOCKED':
            status = 422
        return JSONResponse({'message': getattr(error, 'message', str(error)), 'code': code, 'details': getattr(error, 'details', None)}, status_code=status)

    @app.exception_handler(ValueError)
    async def invalid_input(request, error):
        return JSONResponse({'message': str(error)[:500]}, status_code=422)

    @app.exception_handler(QuestionError)
    async def invalid_answer(request, error):
        return JSONResponse({'message': str(error), 'code': 'question_conflict' if error.status == 409 else 'invalid_answer',
                             'workspace': store.snapshot()}, status_code=error.status)

    @app.exception_handler(TranslationError)
    async def translation_error(request, error):
        return JSONResponse({'message': error.message}, status_code=error.status)

    @app.get('/api/local/health')
    async def health():
        store.snapshot()
        return {'status': 'ready', 'framework': 'Agno', 'version': version('agno'), 'modelConfigured': bool(config.API_KEY), 'model': config.MODEL, 'thinkingEnabled': config.THINKING if urlparse(config.BASE_URL).hostname == 'api.deepseek.com' else None, 'dataSource': '本地模拟业务数据', 'activeRuns': len(runtime.tasks)}

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        if request.url.path != '/api/local/expert-teams':
            return await request_validation_exception_handler(request, error)
        fields = {
            'name': '专家团名称请填写1至60个字。', 'description': '用途说明请填写1至300个字。',
            'baseTeamId': '请选择一个内置专家团。', 'skillIds': '请选择至少一项有效技能。',
            'connectorIds': '请选择所需的连接器。',
        }
        field = next(iter(error.errors()), {}).get('loc', ())[-1:]
        message = fields.get(field[0], '专家团配置格式无效，请核对后重试。') if field else '专家团配置格式无效。'
        return JSONResponse({'message': message}, status_code=422)

    @app.exception_handler(TeamError)
    async def team_error(request, error):
        return JSONResponse({'message': str(error)}, status_code=error.status)

    @app.get('/api/local/expert-teams')
    async def expert_teams():
        return {'teams': runtime.expert_teams.list()}

    @app.post('/api/local/expert-teams', status_code=201)
    async def create_expert_team(payload: TeamRequest):
        return {'team': runtime.expert_teams.create(payload)}

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
        if not payload.message.strip() and payload.questionAnswer is None:
            raise ValueError('请输入消息内容。')
        deferred = bool(payload.questionAnswer and payload.questionAnswer.deferred)
        run_id = None if deferred else 'run-' + uuid.uuid4().hex
        request_data = payload.model_dump()
        with store.lock:
            current = next((t for t in store.get_state()['tasks'] if t['id'] == payload.taskId), None)
            if current and current.get('activeRunId'):
                return JSONResponse({'message': '该会话已有进行中的任务。'}, status_code=409)
            capability = payload.capability
            if current:
                pending = next((m for m in reversed(current['messages'])
                                if m.get('question', {}).get('status') == 'pending'), None)
                if pending:
                    # An answer belongs to the run which asked the question. The composer is editable.
                    origin = store.run(pending.get('runId'))
                    capability = origin['request'].get('capability') if origin else current.get('capability')
                elif 'capability' not in payload.model_fields_set and is_team(current.get('capability')):
                    capability = current['capability']
            team = runtime.expert_teams.resolve(capability)
            request_data['capability'] = capability
            if not deferred and not config.API_KEY:
                return JSONResponse({'message': '尚未配置模型，请配置本地 AGNO_API_KEY 后重启服务。'}, status_code=503)
            if not deferred and len(runtime.tasks) >= 4:
                return JSONResponse({'message': '正在处理其他任务，请稍后再试。'}, status_code=429)
            def begin(state):
                context, user_text = answer_question(state, payload.taskId, request_data.get('questionAnswer'), payload.message)
                task = next((t for t in state['tasks'] if t['id'] == payload.taskId), None)
                if task is None:
                    task = {'id': payload.taskId, 'title': user_text[:24], 'status': '处理中', 'type': 'chat', 'messages': [], 'input': '', 'refs': [], 'updated': '刚刚'}
                    state['tasks'].insert(0, task)
                messages = task['messages']
                user_message = {'id': 'user-' + uuid.uuid4().hex, 'role': 'user', 'text': user_text, 'createdAt': int(time.time()*1000)}
                if context:
                    question = context['question']
                    user_message['questionAnswer'] = {'questionId': question['id'], **question.get('answer', {}),
                                                      'deferred': deferred, 'mode': context['mode']}
                    request_data['questionContext'] = context
                    # Ordinary text may already be present from the client's optimistic save.
                    if messages and messages[-1].get('role') == 'user' and messages[-1].get('text') == user_text and not messages[-1].get('questionAnswer'):
                        messages[-1]['questionAnswer'] = user_message['questionAnswer']
                    else:
                        messages.append(user_message)
                elif not messages or messages[-1].get('role') != 'user' or messages[-1].get('text') != user_text:
                    messages.append(user_message)
                request_data['message'] = user_text
                if context or 'refs' not in payload.model_fields_set:
                    request_data['refs'] = task.get('refs', [])
                if team:
                    request_data['expertTeamName'] = team.name
                    team.visible_refs(request_data['refs'])
                    # Reserve the reply identity with the run, even on an immediate restart.
                    if run_id:
                        messages.append({'id': 'assistant-' + run_id, 'role': 'assistant', 'text': '',
                                         'runId': run_id, 'runStatus': 'running', 'createdAt': int(time.time()*1000),
                                         'capability': team.id, 'expertTeamName': team.name})
                task['expertTeamName'] = team.name if team else None
                task.update(activeRunId=run_id, status='已暂停' if deferred else '处理中', refs=request_data['refs'],
                            capability=request_data['capability'],
                            input=task.get('input', '') if payload.questionAnswer is not None or payload.preserveComposerDraft else '', updated='刚刚')
                state['activeTask'] = task['id']
            if deferred:
                store.mutate(begin)
            else:
                store.create_run(run_id, payload.taskId, request_data, initialize=begin)
        if run_id:
            runtime.launch(run_id)
        return {'runId': run_id, 'taskId': payload.taskId, 'workspace': store.snapshot()}

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

    @app.post('/api/local/materials/extract')
    async def extract_uploaded_materials(payload: MaterialExtractRequest):
        from material_service import extract_materials
        try:
            async with asyncio.timeout(180):
                result = await extract_materials(store, payload.fileIds, payload.draftId)
        except TimeoutError:
            return JSONResponse({'message': '材料提取超时，原件仍保留，请重试。'}, status_code=504)
        return {**result, 'workspace': store.snapshot()}

    @app.post('/api/local/tools/expense-summary')
    async def summarize_expense_csv(payload: ExpenseSummaryRequest):
        from expense_summary import summarize_csv
        return {**summarize_csv(store, payload.fileId), 'workspace': store.snapshot()}

    @app.get('/api/local/tools/results')
    async def tool_results():
        from expense_summary import list_results
        return {'results': list_results(store)}

    @app.get('/api/local/tools/results/{result_id}')
    async def tool_result(result_id: str):
        from expense_summary import get_result
        return {'result': get_result(store, result_id)}

    @app.get('/api/local/tools/results/{result_id}/download')
    async def download_tool_result(result_id: str):
        from expense_summary import export_result_csv
        return Response(export_result_csv(store, result_id), media_type='text/csv; charset=utf-8',
                        headers={'Content-Disposition': 'attachment; filename="expense-summary.csv"'})

    @app.get('/api/local/files/{file_id}/download')
    async def download(file_id: str):
        row = store.get_file(file_id)
        if not row:
            return JSONResponse({'message': '文件不存在或仅为合成样例。'}, status_code=404)
        path = config.DATA_DIR / 'files' / row['storage_name']
        if not path.is_file():
            return JSONResponse({'message': '文件内容已不可用。'}, status_code=404)
        return FileResponse(path, filename=row['metadata']['name'], media_type='application/octet-stream')

    @app.get('/api/local/files/{file_id}/translation')
    async def get_translation(file_id: str):
        return translations.get(file_id)

    @app.post('/api/local/files/{file_id}/translation')
    async def translate_file(file_id: str):
        return await translations.translate(file_id)

    @app.get('/api/local/files/{file_id}/pages/{page}')
    async def translation_page(file_id: str, page: int):
        return FileResponse(await translations.preview(file_id, page), media_type='image/png')

    @app.post('/api/local/business/validate')
    async def validate(payload: dict):
        return await asyncio.to_thread(business.validate_draft, payload.get('id', 'expense'))

    @app.post('/api/local/business/submit')
    async def submit(payload: dict):
        if not isinstance(payload.get('version'), int) or not payload.get('idempotencyKey'):
            raise ValueError('提交需要当前版本和幂等编号。')
        return await asyncio.to_thread(business.submit_draft, payload.get('id', 'expense'), payload['version'], payload['idempotencyKey'])

    @app.post('/api/local/business/new-draft')
    async def new_draft(payload: dict):
        return business.new_draft(payload.get('id', 'expense'))

    @app.get('/api/local/business/travel-applications')
    async def travel_applications(query: str = ''):
        return business.query_travel_applications(query)

    @app.post('/api/local/business/link-travel-application')
    async def link_travel_application(payload: dict):
        result = business.link_travel_application(
            payload.get('id', 'expense'), payload.get('applicationId'), payload.get('version'),
            expected_snapshot=payload.get('expectedSnapshot'),
        )
        return {**result, 'workspace': store.snapshot()}

    @app.get('/api/local/receipts/{receipt_id}')
    async def receipt(receipt_id: str):
        return business.get_receipt(receipt_id)

    @app.post('/api/local/business/preaudit')
    async def preaudit(payload: dict):
        return await asyncio.to_thread(business.preaudit, payload.get('system'), payload.get('ids'))

    @app.get('/api/local/business/work-documents/{document_id}/decision-context')
    def work_decision_context(document_id: str):
        return decision_context(store, document_id)

    @app.post('/api/local/business/work-documents/{document_id}/decision')
    def work_document_decision(document_id: str, payload: WorkDecisionRequest):
        result = decide(store, document_id, **payload.model_dump())
        return {**result, 'workspace': store.snapshot()}

    @app.get('/api/local/business/work-documents/{document_id:path}')
    async def work_document(document_id: str):
        try:
            return business.get_work_document(document_id)
        except BusinessError as error:
            if error.code != 'NOT_FOUND':
                raise
            return JSONResponse({'message': error.message}, status_code=404)

    @app.get('/api/local/rules/demo-cases')
    async def rule_demo_cases():
        return {'cases': demo_cases(), 'dataSource': '合成业务样例'}

    @app.post('/api/local/rules/test')
    async def rule_test(payload: dict):
        case = next((item for item in demo_cases() if item['id'] == payload.get('caseId')), None)
        if case is None:
            raise ValueError('请选择有效的测试样例。')
        rule = payload.get('rule')
        if rule is None:
            rule = next((item for item in store.get_state()['data'].get('srsRuleCenterV1', {}).get('rules', [])
                         if item['id'] == payload.get('ruleId')), None)
        if not isinstance(rule, dict) or not isinstance(rule.get('id'), str) or not rule.get('name'):
            raise ValueError('请先生成有效规则再测试。')
        if rule.get('system') != case['system']:
            raise ValueError('样例与规则的业务系统不一致。')
        if rule.get('metric') == 'semantic':
            validate_semantic_rule(rule)
        elif rule.get('metric') not in ('amount', 'meal', 'hotelNight', 'days', 'invoiceUnique', 'attachment'):
            raise ValueError('规则检查类型无效。')
        # 样例的预期结论只供核对；永远不送入模型，也不写入实际预审结果。
        review = await asyncio.to_thread(business.evaluate_rules, case['document'], [rule])
        return {'case': case, 'review': review, 'checkedAt': datetime.now(timezone.utc).isoformat(),
                'model': review.get('model'), 'dataSource': '合成业务样例'}

    @app.post('/api/local/business/documents')
    async def documents(payload: dict):
        return business.query_documents(payload.get('query', ''), payload.get('documentIds'))

    @app.post('/api/local/business/analyze')
    async def analyze(payload: dict):
        return business.analyze(payload.get('month', '10'), payload.get('dept', '全部部门'), payload.get('type'))

    @app.get('/api/local/analytics/public/query')
    async def public_financial_query(request: Request):
        from financial_analytics import query_financials
        parameters = list(request.query_params.multi_items())
        if any(key not in {'year', 'metric'} for key, _ in parameters) or len({key for key, _ in parameters}) != len(parameters):
            raise ValueError('公开财报查询仅支持唯一的 year 与 metric 参数。')
        year = request.query_params.get('year', '2025')
        if year not in {'2023', '2024', '2025'}:
            raise ValueError('公开财报支持海康威视 2023、2024、2025 年度。')
        return query_financials(int(year), request.query_params.get('metric'))

    @app.get('/api/local/analytics/public/reports')
    async def public_financial_reports():
        from financial_analytics import list_reports
        return {'reports': list_reports(store)}

    @app.post('/api/local/analytics/public/reports')
    async def create_public_financial_report(payload: PublicFinancialReportRequest):
        from financial_analytics import create_report
        return create_report(store, payload.year, payload.datasetId, payload.datasetVersion)

    @app.get('/api/local/analytics/public/reports/{report_id}')
    async def public_financial_report(report_id: str):
        from financial_analytics import get_report
        try:
            return {'report': get_report(store, report_id)}
        except ValueError as error:
            return JSONResponse({'message': str(error)}, status_code=404)

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
            result = await semantic_rules.generate(text)
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
