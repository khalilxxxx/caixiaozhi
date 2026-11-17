import io
import zipfile
from fastapi.testclient import TestClient
from store import Store


def test_skill_package_inspection_and_artifact_delivery(tmp_path, monkeypatch):
    import config
    from server import create_app
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    app = create_app(store)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, 'w') as package:
        package.writestr('hello/SKILL.md', '---\nname: hello\ndescription: 生成文字文件\n---\n读取参考资料并生成文件。')
        package.writestr('hello/references/format.md', '输出应包含标题。')
    with TestClient(app) as client:
        file = client.post('/api/local/files', files={'file': ('hello.zip', archive.getvalue(), 'application/zip')}).json()['file']
        response = client.post('/api/local/skills/inspect', json={'fileId': file['id']})
        assert response.status_code == 200, response.text
        assert response.json()['inspection']['name'] == 'hello'
        assert 'references/format.md' in [f['path'] for f in response.json()['inspection']['files']]
        workspace = tmp_path / 'job'
        (workspace / 'output').mkdir(parents=True)
        (workspace / 'output/report.html').write_text('<h1>报告</h1><script>fetch("/api/local/workspace")</script>')
        item = app.state.skill_artifacts.publish(workspace, 'output/report.html', 't', 'r')
        preview = client.get('/api/local/artifacts/' + item['id'] + '/preview')
        assert preview.status_code == 200
        assert "default-src 'none'" in preview.headers['content-security-policy']
        assert 'sandbox' in preview.headers['content-security-policy']
        download = client.get('/api/local/artifacts/' + item['id'] + '/download')
        assert 'attachment' in download.headers['content-disposition']
        assert client.get('/api/local/artifacts?taskId=other').json()['artifacts'] == []


def test_skill_catalog_requires_the_same_approval_gates_for_discovery(tmp_path):
    from skill_agent_tools import SkillToolset
    store = Store(tmp_path / 'state.db')
    def update(state):
        state['data']['skillsHub'] = {'skills': [{'id': 'unreviewed', 'title': '未审', 'call': True, 'view': True,
            'versions': [{'version': '1.0', 'status': 'published', 'mode': 'runnable', 'business': 'pending'}]}]}
    store.mutate(update)
    tools = SkillToolset(store, tmp_path, {'id': 'r', 'task_id': 't', 'request': {}}, None, None)
    assert tools.catalog() == {'skills': []}
