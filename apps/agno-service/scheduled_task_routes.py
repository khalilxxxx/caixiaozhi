from fastapi.responses import JSONResponse
from scheduled_tasks import ScheduleError


def register_scheduled_task_routes(app, schedules):
    @app.exception_handler(ScheduleError)
    async def schedule_error(request, error):
        return JSONResponse({'message': str(error)}, status_code=error.status)

    @app.get('/api/local/schedules')
    async def list_schedules():
        schedules.reconcile()
        return {'items': schedules.list(), 'timezone': 'Asia/Shanghai'}

    @app.post('/api/local/schedules')
    async def create_schedule(payload: dict):
        return {'item': schedules.create(payload)}

    @app.patch('/api/local/schedules/{task_id}')
    async def update_schedule(task_id: str, payload: dict):
        return {'item': schedules.update(task_id, payload)}

    @app.delete('/api/local/schedules/{task_id}')
    async def delete_schedule(task_id: str, version: int):
        schedules.delete(task_id, version)
        return {'deleted': True}

    @app.get('/api/local/schedules/{task_id}/runs')
    async def history(task_id: str):
        schedules.reconcile()
        return {'items': schedules.history(task_id)}

    @app.post('/api/local/schedules/{task_id}/run')
    async def run_now(task_id: str):
        if schedules.at_capacity():
            raise ScheduleError('正在执行其他任务，请稍后重试。', 429)
        record = schedules.claim(task_id)
        schedules.launch(record)
        return {'run': record}
