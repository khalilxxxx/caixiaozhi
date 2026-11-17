"""Skill inspection and immutable artifact HTTP endpoints."""
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from skill_artifacts import SkillArtifactService


class InspectSkillRequest(BaseModel):
    fileId: str = Field(min_length=1, max_length=200)


def register_skill_routes(app, store, data_dir):
    from skill_packages import SkillPackageService
    from skill_executor import LocalSkillExecutor
    packages = SkillPackageService(store, data_dir)
    artifacts = SkillArtifactService(store, data_dir)
    app.state.skill_artifacts = artifacts

    @app.post('/api/local/skills/inspect')
    async def inspect_skill(payload: InspectSkillRequest):
        return {'inspection': packages.inspect(payload.fileId)}

    @app.get('/api/local/skills/environment')
    async def environment():
        return LocalSkillExecutor().environment()

    @app.get('/api/local/artifacts')
    async def list_artifacts(taskId: str):
        return {'artifacts': artifacts.list(taskId)}

    @app.get('/api/local/artifacts/{artifact_id}')
    async def artifact(artifact_id: str):
        return {'artifact': await artifacts.prepare_preview(artifact_id)}

    @app.get('/api/local/artifacts/{artifact_id}/download')
    async def download(artifact_id: str):
        item = artifacts.get(artifact_id)
        return FileResponse(artifacts.path(artifact_id), filename=item['name'], media_type='application/octet-stream',
                            headers={'X-Content-Type-Options': 'nosniff'})

    @app.get('/api/local/artifacts/{artifact_id}/preview')
    async def preview(artifact_id: str):
        await artifacts.prepare_preview(artifact_id)
        path, mime = artifacts.preview_path(artifact_id)
        return FileResponse(path, media_type=mime, headers={
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
            'Referrer-Policy': 'no-referrer',
        })
