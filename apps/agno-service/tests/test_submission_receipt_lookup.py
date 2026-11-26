from fastapi.testclient import TestClient

from business import Business
from server import create_app
from store import Store


def test_lookup_is_read_only_and_uses_the_original_draft_version_and_key(tmp_path):
    store = Store(tmp_path / 'submission.db')
    # Isolate receipt handling from model-backed assessment.
    def use_local_rules(state):
        for rule in state['data']['rulesSubmission']['rules']:
            if rule.get('metric') == 'semantic':
                rule['enabled'] = False
    store.mutate(use_local_rules)
    business = Business(store)
    draft = business.update_draft('travel', {'purpose': '拜访客户', 'legs': [
        {'id': 'go', 'departureCity': '北京', 'arrivalCity': '上海', 'departureDate': '2026-11-20',
         'arrivalDate': '2026-11-20', 'transport': '高铁'},
        {'id': 'back', 'departureCity': '上海', 'arrivalCity': '北京', 'departureDate': '2026-11-21',
         'arrivalDate': '2026-11-21', 'transport': '高铁'},
    ]})['draft']
    order = {'id': 'travel', 'version': draft['version'], 'idempotencyKey': 'original-confirmation'}
    lookup = '/api/local/business/submission-receipt'
    with TestClient(create_app(store)) as client:
        before = store.snapshot()['revision']
        assert client.get(lookup, params=order).json() == {'status': 'unrecorded', 'canRetry': True}
        assert store.snapshot()['revision'] == before
        accepted = client.post('/api/local/business/submit', json=order).json()
        assert 'receipt' in accepted, accepted
        assert accepted['receipt']['status'] == 'accepted'
        revision = store.snapshot()['revision']
        result = client.get(lookup, params=order).json()
        assert result['status'] == 'accepted' and result['receipt'] == accepted['receipt']
        assert result['request']['id'] == accepted['request']['id']
        for wrong in ({'id': 'expense'}, {'version': order['version'] + 1}):
            assert client.get(lookup, params={**order, **wrong}).status_code == 409
        assert client.get(lookup, params={**order, 'idempotencyKey': 'different'}).json() == {
            'status': 'unrecorded', 'canRetry': False}
        assert store.snapshot()['revision'] == revision
        retried = client.post('/api/local/business/submit', json=order).json()
        assert retried['receipt']['id'] == accepted['receipt']['id']
        assert len(store.get_state()['data']['submissions']['requests']) == 1
