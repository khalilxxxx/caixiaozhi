from fastapi.testclient import TestClient
from store import Store
from server import create_app


def test_summary_api_uses_uploaded_csv_and_preserves_result(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    with TestClient(create_app(store)) as client:
        uploaded = client.post('/api/local/files', files={
            'file': ('expenses.csv', '费用类型,金额\n交通,12.50\n办公,20.00\n交通,-2.50\n'.encode(), 'text/csv')
        }).json()['file']
        response = client.post('/api/local/tools/expense-summary', json={'fileId': uploaded['id']})
        assert response.status_code == 200, response.text
        result = response.json()['result']
        assert result['totalMinor'] == '3000'
        assert result['rowCount'] == 3
        assert response.json()['cards'][0]['id'] == result['id']
        persisted = response.json()['workspace']['state']['data']['toolResults'][result['id']]
        assert persisted['totalMinor'] == result['totalMinor']
        assert [{key: group[key] for key in ('name', 'amountMinor', 'count')} for group in persisted['groups']] == [
            {'name': '交通', 'amountMinor': '1000', 'count': 2}, {'name': '办公', 'amountMinor': '2000', 'count': 1}]
        assert result['total'] == '30.00'
        assert [group['amount'] for group in result['groups']] == ['10.00', '20.00']
        assert client.get('/api/local/tools/results').json()['results'][0]['id'] == result['id']
        assert client.get('/api/local/tools/results/' + result['id']).json()['result'] == result
        download = client.get('/api/local/tools/results/' + result['id'] + '/download')
        assert download.status_code == 200
        assert download.content.startswith(b'\xef\xbb\xbf')
        assert 'attachment' in download.headers['content-disposition']
        assert client.post('/api/local/tools/expense-summary', json={'fileId': uploaded['id']}).json()['result']['id'] == result['id']
        assert client.post('/api/local/tools/expense-summary', json={'fileId': 'missing'}).status_code >= 400
    assert Store(tmp_path / 'state.db').get_state()['data']['toolResults'][result['id']]['totalMinor'] == '3000'


def test_material_extract_api_rejects_empty_selection(tmp_path):
    with TestClient(create_app(Store(tmp_path / 'state.db'))) as client:
        assert client.post('/api/local/materials/extract', json={'fileIds': []}).status_code == 422
