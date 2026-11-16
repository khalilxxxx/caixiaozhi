from fastapi.testclient import TestClient
from store import Store
from server import create_app


def test_health_workspace_and_origin(tmp_path):
    with TestClient(create_app(Store(tmp_path/'state.db'))) as client:
        assert client.get('/api/local/health').json()['framework'] == 'Agno'
        snapshot = client.get('/api/local/workspace').json()
        assert snapshot['state']['tasks'] == []
        assert client.patch('/api/local/workspace', json={'baseRevision': 0, 'data': {'test': 1}}, headers={'origin': 'https://untrusted.example'}).status_code == 403
        assert client.patch('/api/local/workspace', json={'baseRevision': 0, 'data': {'test': 1}}).status_code == 200
        assert client.patch('/api/local/workspace', json={'baseRevision': 0, 'data': {'test': 2}}).status_code == 409


def test_real_file_bytes_and_missing_receipt(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    with TestClient(create_app(Store(tmp_path/'state.db'))) as client:
        content = '出差：上海，2026-11-19。'.encode()
        result = client.post('/api/local/files', files={'file': ('../../trip.txt', content, 'text/plain')})
        assert result.status_code == 200
        file = result.json()['file']
        assert file['name'] == 'trip.txt'
        assert file['text'].startswith('出差')
        assert client.get('/api/local/files/'+file['id']+'/download').content == content
        assert client.post('/api/local/files', files={'file': ('code.exe', b'123')}).status_code == 422
        assert client.get('/api/local/receipts/missing').status_code >= 400
