from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, StrictInt


class CreateBatch(BaseModel):
    fileIds: list[str] = Field(min_length=1, max_length=30)
    previousBatchId: str | None = Field(default=None, min_length=1, max_length=100)


class Assignment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    invoiceFileIds: list[str] = Field(min_length=1, max_length=30)
    attachmentFileIds: list[str] = Field(default_factory=list, max_length=30)
    categoryId: str | None = Field(default=None, max_length=100)


class ReviewBatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: StrictInt = Field(ge=1)
    assignments: list[Assignment] | None = Field(default=None, max_length=30)
    retryFileIds: list[str] = Field(default_factory=list, max_length=30)


class LinePreview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expenseId: str = Field(min_length=1, max_length=200)
    invoiceFileIds: list[str] = Field(default_factory=list, max_length=30)
    attachmentFileIds: list[str] = Field(default_factory=list, max_length=30)
    categoryId: str | None = Field(default=None, max_length=100)


class ApplyBatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: StrictInt = Field(ge=1)
    includeHeader: bool = True


def register_reimbursement_routes(app: FastAPI, service):
    base = '/api/local/reimbursements/{draft_id}/batches'

    @app.post('/api/local/reimbursements/{draft_id}/line-preview')
    async def line_preview(draft_id: str, payload: LinePreview):
        return await service.line_preview(draft_id, payload.expenseId, payload.invoiceFileIds,
                                          payload.attachmentFileIds, payload.categoryId)

    @app.post(base)
    async def create_batch(draft_id: str, payload: CreateBatch):
        batch = await service.create(draft_id, payload.fileIds, payload.previousBatchId)
        return {'batch': batch, 'workspace': service.store.snapshot()}

    @app.get(base + '/latest')
    async def latest_batch(draft_id: str):
        return {'batch': service.get(draft_id)}

    @app.get(base + '/{batch_id}')
    async def saved_batch(draft_id: str, batch_id: str):
        return {'batch': service.get(draft_id, batch_id)}

    @app.post(base + '/{batch_id}/review')
    async def review_batch(draft_id: str, batch_id: str, payload: ReviewBatch):
        assignments = None if payload.assignments is None else [a.model_dump(exclude_none=True) for a in payload.assignments]
        result = await service.review(draft_id, batch_id, payload.revision, assignments, payload.retryFileIds)
        return {'batch': result, 'workspace': service.store.snapshot()}

    @app.post(base + '/{batch_id}/apply')
    async def apply_batch(draft_id: str, batch_id: str, payload: ApplyBatch):
        result = service.apply(draft_id, batch_id, payload.revision, payload.includeHeader)
        return {**result, 'workspace': service.store.snapshot()}
