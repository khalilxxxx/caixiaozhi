"""报销单、费用行与原件之间的事务边界。模型识别单独验证。"""
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
import pytest

from business import Business
from server import create_app
from store import Store


@pytest.fixture
def app(tmp_path, monkeypatch):
    import config
    import material_service
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'workspace.db')
    client = TestClient(create_app(store))
    recognized = {}

    def upload(name, role, facts):
        response = client.post('/api/local/files', files={'file': (name, name.encode(), 'text/plain')})
        fid = response.json()['file']['id']
        recognized[fid] = {'role': role, 'facts': facts, 'evidence': {k: str(v) for k, v in facts.items()}}
        return fid

    async def extract(store, ids, draft, *, reimbursement):
        assert reimbursement
        files = []
        for fid in ids:
            source = recognized[fid]
            meta = {k: v for k, v in store.get_file(fid)['metadata'].items() if k != 'text'}
            if source:
                files.append({**meta, 'status': 'recognized', 'extractionStatus': 'extracted', 'recognition': source})
            else:
                files.append({**meta, 'status': 'failed', 'extractionStatus': 'failed', 'extractionError': '识别超时'})
        return {'files': files, 'items': []}

    monkeypatch.setattr(material_service, 'extract_materials', extract)
    facts = {'merchant': '合成商户', 'date': '2026-11-18', 'service': '餐饮服务', 'currency': 'CNY', 'orderId': 'table-11'}
    first = upload('合成发票甲.txt', 'invoice', {**facts, 'invoiceNumber': 'A001', 'amount': 10000})
    second = upload('合成发票乙.txt', 'invoice', {**facts, 'invoiceNumber': 'A002', 'amount': 5000})
    slip = upload('支付凭证.txt', 'payment', {**facts, 'amount': 15000, 'people': '5', 'purpose': '客户招待',
                                              'activityName': '产品会议', 'activityNumber': 'SYN-101'})
    office = upload('办公发票.txt', 'invoice', {'amount': 800, 'date': '2026-11-19', 'currency': 'CNY',
                                           'service': '办公用品', 'invoiceNumber': 'A003'})
    return client, store, [first, second, slip, office], recognized, upload


BASE = '/api/local/reimbursements/personal/batches'


def test_generate_one_number_many_expenses_and_keep_manual_edits(app):
    client, store, ids, _, upload = app
    original = Business(store).get_draft('personal')['draft']['documentNumber']
    batch = client.post(BASE, json={'fileIds': ids}).json()['batch']
    assert batch['status'] == 'review'
    assert len(batch['groups']) == 2
    assert client.get(BASE + '/latest').json()['batch'] == batch
    assert client.post(BASE, json={'fileIds': ids[::-1]}).json()['batch']['id'] == batch['id']
    assert client.get(BASE.replace('/personal/', '/expense/') + '/' + batch['id']).status_code == 422
    patch = {'purpose': '人工保留的单头', 'activities': [{'id': 'work', 'description': '人工录入'}]}
    def editing(state):
        submissions = state['data']['submissions']
        submissions['edits']['personal'] = {**submissions['drafts']['personal'], **patch}
    store.mutate(editing)

    path = BASE + '/' + batch['id'] + '/apply'
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(path, json={'revision': 1}).json(), (1, 2)))
    assert all(result['batch']['status'] == 'applied' for result in responses)
    draft = responses[0]['draft']
    assert draft['documentNumber'] == original and draft['purpose'] == patch['purpose']
    assert len(draft['expenses']) == 2 and draft['version'] == 2
    assert draft['activities'][0] == patch['activities'][0]
    assert draft['activities'][1]['activityNumber'] == 'SYN-101'
    meal, office = draft['expenses']
    assert meal['categoryId'] == 'reception-meal' and meal['amount'] == '150.00' and meal['people'] == '5'
    assert [f['id'] for f in meal['files']] == ids[:2]
    assert [f['id'] for f in meal['attachments']] == [ids[2]]
    assert office['amount'] == '8.00' and office['categoryId'] == 'other-office'
    assert set(ids) == set(draft['materialIds'])
    duplicate = upload('重新拍摄发票甲.txt', 'invoice', {'invoiceNumber': 'A001', 'amount': 10000})
    repeat = client.post(BASE, json={'fileIds': [duplicate]}).json()['batch']
    assert repeat['groups'] == [] and duplicate in repeat['unavailableFileIds']


def test_reassign_stale_review_partial_retry_and_no_double_count(app):
    client, _, ids, recognized, _ = app
    original = recognized[ids[2]]
    recognized[ids[2]] = None
    b = client.post(BASE, json={'fileIds': ids}).json()['batch']
    assert ids[2] in b['unassignedFileIds']
    route = BASE + '/' + b['id']
    recognized[ids[2]] = original
    b = client.post(route + '/review', json={'revision': 1, 'retryFileIds': [ids[2]]}).json()['batch']
    assert b['revision'] == 2 and ids[2] in b['groups'][0]['attachmentFileIds']
    assert client.post(route + '/apply', json={'revision': 1}).status_code == 409
    choice = [{'invoiceFileIds': [ids[0]], 'attachmentFileIds': [ids[2]]}, {'invoiceFileIds': [ids[1]]}]
    b = client.post(route + '/review', json={'revision': 2, 'assignments': choice}).json()['batch']
    assert b['unassignedFileIds'] == [ids[3]]
    assert client.post(route + '/review', json={'revision': 3, 'assignments': [choice[0], choice[0]]}).status_code == 422
    d = client.post(route + '/apply', json={'revision': 3, 'includeHeader': False}).json()['draft']
    assert [line['amount'] for line in d['expenses']] == ['100.00', '50.00']
    assert not d['purpose'] and not d['activities']
    assert ids[3] not in d['materialIds']


def test_stable_number_and_preserve_missing_facts_through_save_submit(app):
    client, store, _, _, upload = app
    business = Business(store)
    first, second = [business.new_draft('personal')['draft'] for _ in range(2)]
    assert first['documentNumber'] != second['documentNumber']
    route = BASE.replace('/personal/', '/' + first['id'] + '/')
    fid = upload('合成未知用途.txt', 'invoice', {'amount': 20000, 'service': '餐饮服务'})
    batch = client.post(route, json={'fileIds': [fid]}).json()['batch']
    draft = client.post(route + '/' + batch['id'] + '/apply', json={'revision': 1}).json()['draft']
    assert draft['id'] == first['id'] and draft['documentNumber'] == first['documentNumber']
    row, = draft['expenses']
    assert not row['categoryId'] and not row['currency'] and row['amount'] == '200.00'
    assert not business.validate_draft(draft['id'])['canSubmit']
    corrected = business.update_draft(draft['id'], {'purpose': '补录费用', 'expenses': [{**row, 'currency': 'CNY',
        'date': '2026-11-18', 'categoryId': 'other-office', 'reason': '已人工核对'}]})['draft']
    result = business.submit_draft(draft['id'], corrected['version'], 'confirmed')
    assert result['request']['businessId'] == result['receipt']['businessId'] == first['documentNumber']
    assert business.get_draft(second['id'])['draft']['expenses'] == []


def test_line_preview_respects_current_line_and_claims_without_adding_rows(app):
    client, store, ids, _, _ = app
    business = Business(store)
    business.update_draft('personal', {'expenses': [
        {'id': 'meal', 'files': [{'id': ids[0]}]},
        {'id': 'office', 'files': [{'id': ids[3]}]}]})
    route = '/api/local/reimbursements/personal/line-preview'
    selection = {'expenseId': 'meal', 'invoiceFileIds': ids[:2], 'attachmentFileIds': [ids[2]]}
    response = client.post(route, json=selection)
    assert response.status_code == 200
    result = response.json()
    assert result['expense']['amount'] == '150.00' and result['expense']['people'] == '5'
    assert result['evidence']['people'][0]['fileId'] == ids[2]
    assert len(business.get_draft('personal')['draft']['expenses']) == 2
    assert client.post(route, json={**selection, 'invoiceFileIds': [ids[3]]}).status_code == 409
    supporting_only = client.post(route, json={**selection, 'invoiceFileIds': []}).json()
    assert supporting_only['expense'] is None and supporting_only['issues']


def test_append_files_keeps_manual_separation_and_explicit_category(app):
    client, _, ids, _, _ = app
    first = client.post(BASE, json={'fileIds': ids[:3]}).json()['batch']
    groups = [{'invoiceFileIds': [ids[0]], 'categoryId': 'reception-meal'},
              {'invoiceFileIds': [ids[1]], 'attachmentFileIds': [ids[2]]}]
    client.post(BASE + '/' + first['id'] + '/review', json={'revision': 1, 'assignments': groups}).raise_for_status()
    expanded = client.post(BASE, json={'fileIds': ids, 'previousBatchId': first['id']}).json()['batch']
    assert len(expanded['groups']) == 3
    assert expanded['groups'][0]['expense']['categoryId'] == 'reception-meal'
    assert [g['invoiceFileIds'] for g in expanded['groups']] == [[ids[0]], [ids[1]], [ids[3]]]
    assert expanded['groups'][1]['attachmentFileIds'] == [ids[2]]


def test_pending_material_null_recognition_does_not_cancel_good_expenses(app):
    client, _, ids, recognized, _ = app
    recognized[ids[2]] = None
    path = BASE
    b = client.post(path, json={'fileIds': ids}).json()['batch']
    assert ids[2] in b['unavailableFileIds']
    result = client.post(path + '/' + b['id'] + '/apply', json={'revision': 1})
    result.raise_for_status()
    assert ids[2] not in result.json()['draft']['materialIds']
