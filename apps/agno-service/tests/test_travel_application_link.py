import pytest
from fastapi.testclient import TestClient

from business import Business, BusinessError
from server import create_app
from store import Store
from submission_defaults import draft_snapshot_token


APPROVED_ID = 'TA-20261113-015'


def test_query_only_returns_current_employees_approved_travel_applications(tmp_path):
    store = Store(tmp_path / 'state.db')

    def seed_other_documents(state):
        documents = state['data']['documents']
        template = next(document for document in documents if document['id'] == 'TA-20261116-023')
        documents.extend([
            {**template, 'id': 'TA-OTHER', 'key': 'travel/travel_application/TA-OTHER',
             'applicantId': 'someone-else', 'status': 'completed', 'sourceStatus': '已审批'},
            {**template, 'id': 'OA-OTHER', 'typeId': 'oa_leave', 'status': 'completed', 'sourceStatus': '已审批'},
            {**template, 'id': 'TA-CLOSED', 'status': 'completed', 'sourceStatus': '已完成'},
        ])

    store.mutate(seed_other_documents)
    with TestClient(create_app(store)) as client:
        response = client.get('/api/local/business/travel-applications', params={'query': '上海'})
        assert response.status_code == 200
        candidates = response.json()['items']
        assert [(item['id'], item['applicant'], item['sourceStatus']) for item in candidates] == [
            (APPROVED_ID, '林悦', '已审批'),
        ]
        assert candidates[0]['synthetic'] is True
        assert [(leg['departureCity'], leg['arrivalCity']) for leg in candidates[0]['legs']] == [
            ('杭州', '上海'), ('上海', '杭州'),
        ]
        path = '/api/local/business/link-travel-application'
        for unavailable_id in ('TA-OTHER', 'OA-OTHER', 'TA-CLOSED', 'TA-20261116-023', 'TA-20261113'):
            result = client.post(path, json={'id': 'expense', 'applicationId': unavailable_id, 'version': 1})
            assert result.json()['code'] == 'TRAVEL_APPLICATION_UNAVAILABLE'
        assert store.get_state()['data']['submissions']['drafts']['expense']['version'] == 1


def test_link_imports_itinerary_and_preserves_existing_expense(tmp_path):
    store = Store(tmp_path / 'state.db')
    business = Business(store)
    draft = business.update_draft('expense', {'expenses': [
        {'id': 'paid', 'categoryId': 'other-parking', 'amount': '45.30', 'date': '2026-11-17', 'reason': '客户停车'},
    ]})['draft']

    with TestClient(create_app(store)) as client:
        response = client.post('/api/local/business/link-travel-application', json={
            'id': 'expense', 'applicationId': APPROVED_ID.lower(), 'version': draft['version'],
        })
    assert response.status_code == 200
    result = response.json()
    assert result['legImportStatus'] == 'imported'
    assert result['importedLegCount'] == 2
    assert result['draft']['applicationId'] == APPROVED_ID
    assert result['draft']['applicationLink']['employeeId'] == 'local-linyue'
    assert result['draft']['legs'][0]['departureDate'] == '2026-11-17'
    assert result['draft']['expenses'] == draft['expenses']


def test_link_preserves_latest_unsaved_itinerary_and_references(tmp_path):
    store = Store(tmp_path / 'state.db')
    business = Business(store)
    workspace = store.snapshot()
    draft = workspace['state']['data']['submissions']['drafts']['expense']
    edit = {**draft, 'legs': [{
        'id': 'own-leg', 'departureCity': '杭州', 'arrivalCity': '上海', 'departureDate': '2026-11-18', 'transport': '出租车',
    }], 'expenses': [{'id': 'own-fare', 'categoryId': 'long-distance', 'tripId': 'own-leg', 'amount': '155.45'}]}
    store.patch({'baseRevision': workspace['revision'], 'data': {'submissions': {'edits': {'expense': edit}}}})
    effective = business.get_draft('expense')['draft']
    with TestClient(create_app(store)) as client:
        conflict = client.post('/api/local/business/link-travel-application', json={
            'id': 'expense', 'applicationId': APPROVED_ID, 'version': draft['version'],
            'expectedSnapshot': draft_snapshot_token(draft),
        })
    assert conflict.status_code == 409
    assert conflict.json()['code'] == 'STALE_DRAFT'
    assert business.get_draft('expense')['draft'] == effective

    result = business.link_travel_application('expense', APPROVED_ID, draft['version'])

    assert result['legImportStatus'] == 'existing_legs_preserved'
    assert result['importedLegCount'] == 0
    assert result['draft']['legs'] == effective['legs']
    assert result['draft']['expenses'] == effective['expenses']
    with pytest.raises(BusinessError, match='草稿已变化'):
        business.link_travel_application('expense', APPROVED_ID, draft['version'])


def test_approved_application_without_structured_itinerary_keeps_legs_empty(tmp_path):
    store = Store(tmp_path / 'state.db')
    business = Business(store)

    def remove_legs(state):
        application = next(doc for doc in state['data']['documents'] if doc['id'] == APPROVED_ID)
        application.pop('legs')

    store.mutate(remove_legs)
    result = business.link_travel_application('expense', APPROVED_ID, 1)

    assert result['legImportStatus'] == 'no_available_legs'
    assert result['importedLegCount'] == 0
    assert result['draft']['legs'] == []
    assert result['draft']['applicationId'] == APPROVED_ID


def test_candidate_sorting_respects_timestamp_offsets_and_source_availability(tmp_path):
    store = Store(tmp_path / 'state.db')
    business = Business(store)

    def add_later_application(state):
        documents = state['data']['documents']
        original = next(doc for doc in documents if doc['id'] == APPROVED_ID)
        documents.append({**original, 'id': 'TA-LATER', 'key': 'travel/travel_application/TA-LATER',
                          'updatedAt': '2026-11-13T07:45:00+00:00', 'title': '交付回访'})

    store.mutate(add_later_application)
    assert [item['id'] for item in business.query_travel_applications('上海')['items']] == ['TA-LATER', APPROVED_ID]
    store.mutate(lambda state: state['data']['documentSources']['states'].update(travel='unavailable'))

    result = business.query_travel_applications()
    assert result['items'] == []
    assert result['unavailableSources'] == ['travel']


def test_legacy_application_number_is_rechecked_against_source_before_submit(tmp_path):
    store = Store(tmp_path / 'state.db')
    business = Business(store)
    legs = [
        {'id': 'go', 'departureCity': '杭州', 'arrivalCity': '上海', 'departureDate': '2026-11-17', 'arrivalDate': '2026-11-17', 'transport': '高铁'},
        {'id': 'back', 'departureCity': '上海', 'arrivalCity': '杭州', 'departureDate': '2026-11-18', 'arrivalDate': '2026-11-18', 'transport': '高铁'},
    ]
    draft = business.update_draft('expense', {'applicationId': APPROVED_ID, 'legs': legs,
        'purpose': '上海客户验收', 'expenses': [{'id': 'paid', 'categoryId': 'other-parking',
            'amount': '45.30', 'date': '2026-11-17', 'reason': '客户停车', 'files': [{'id': 'material-taxi'}]}],
    })['draft']
    assert business.validate_draft('expense')['canSubmit']

    def rescind(state):
        documents = state['data']['documents']
        next(doc for doc in documents if doc['id'] == APPROVED_ID).update(sourceStatus='已撤销', status='closed')

    store.mutate(rescind)
    with pytest.raises(BusinessError) as error:
        business.submit_draft('expense', draft['version'], 'rescinded-application')
    assert any(issue['path'] == 'applicationId' for issue in error.value.details['check']['issues'])
    assert business.get_draft('expense')['draft']['applicationId'] == APPROVED_ID


def test_fixture_is_available_after_reopening_existing_workspaces(tmp_path):
    database = tmp_path / 'state.db'
    store = Store(database)

    def remove_fixture(state):
        data = state['data']
        data['documents'] = [item for item in data['documents'] if item['id'] != APPROVED_ID]
        data['submissions']['drafts']['expense']['purpose'] = '已有草稿'

    store.mutate(remove_fixture)
    business = Business(Store(database))

    assert [item['id'] for item in business.query_travel_applications()['items']] == [APPROVED_ID]
    assert business.get_draft('expense')['draft']['purpose'] == '已有草稿'
