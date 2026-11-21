import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path

from fastapi.testclient import TestClient

from business import Business, BusinessError
from server import create_app
from store import Store
from work_decisions import decide, decision_context


BASE = '/api/local/business/work-documents/'
HOTEL = 'BX-20261116-001'
DUPLICATE = 'BX-20261116-002'
LEAVE = 'OA-20261116-017'


def payload(context, outcome='approve', reason='', key='click-1'):
    return {'decision': outcome, 'expectedVersion': context['expectedVersion'], 'idempotencyKey': key,
            'reviewAck': {'reviewHash': context['reviewHash'], 'findingIds': [f['id'] for f in context['items']]},
            'reason': reason}


def test_confirm_hotel_risk_survives_restart_and_exact_retry(tmp_path):
    path = tmp_path / 'state.sqlite'
    store = Store(path)
    with TestClient(create_app(store)) as client:
        ctx = client.get(BASE + HOTEL + '/decision-context').json()
        assert ctx['requiresReview'] and ctx['availableActions'] == ['approve', 'return']
        assert any(i['id'] == 'R002' and i['evidence'] for i in ctx['items'])
        args = payload(ctx, reason='已核对住宿明细及差额。')
        send = lambda req: client.post(BASE + HOTEL + '/decision', json=req)
        before = store.snapshot()
        assert send({**args, 'reviewAck': {**args['reviewAck'], 'findingIds': []}}).status_code == 422
        assert send({**args, 'reason': '   '}).status_code == 422
        assert store.snapshot() == before

        response = send(args)
        assert response.status_code == 200, response.text
        data = response.json()
        doc = data['document']
        assert doc['stage'] == '已同意' and doc['version'] == ctx['expectedVersion'] + 1
        assert doc['steps'][-1]['actor'] == '吴侠' and doc['steps'][-1]['status'] == 'done'
        assert doc['decision']['fromVersion'] == ctx['expectedVersion']
        assert doc['decision']['reason'] == args['reason'] and doc['decision']['evidence'] == ctx['items']
        assert doc['decisionReview']['checked'] and doc['decisionReview']['review']['status'] == 'attention'
        assert all(x['id'] != HOTEL for x in data['workspace']['state']['data']['auditDocuments'])
        assert data['workspace']['state']['data']['handledWorkDocuments'][HOTEL] == doc
        assert client.get(BASE + HOTEL).json()['document'] == doc
        after = store.snapshot()
        assert send(args).json()['decision']['id'] == data['decision']['id']
        assert send({**args, 'idempotencyKey': 'second-attempt'}).status_code == 409
        assert send({**args, 'decision': 'return'}).status_code == 409
        assert client.get(BASE + HOTEL + '/decision-context').status_code == 409
        assert store.snapshot() == after
    reopened = Store(path)
    historical = Business(reopened).get_work_document(HOTEL, with_review=True)
    assert historical['document'] == doc and historical['review']['checked']
    assert [r['rule']['id'] for r in historical['review']['risks']] == ['R002']


def test_business_block_keeps_return_available_and_clean_document_needs_no_note(tmp_path):
    store = Store(tmp_path / 'state.sqlite')
    with TestClient(create_app(store)) as client:
        ctx = client.get(BASE + DUPLICATE + '/decision-context').json()
        assert ctx['availableActions'] == ['return'] and ctx['hardBlockReasons']
        args = payload(ctx, reason='核对发票重号。')
        assert client.post(BASE + DUPLICATE + '/decision', json=args).status_code == 422
        assert client.post(BASE + DUPLICATE + '/decision', json={**args, 'decision': 'return'}).json()['document']['stage'] == '已退回'
        clear = client.get(BASE + LEAVE + '/decision-context').json()
        assert not clear['requiresReview']
        assert client.post(BASE + LEAVE + '/decision', json=payload(clear, 'return', key='missing-note')).status_code == 422
        assert client.post(BASE + LEAVE + '/decision', json=payload(clear, key='clear')).status_code == 200
        assert client.get(BASE + 'missing/decision-context').status_code == 404


def test_new_review_cannot_be_approved_with_old_evidence(tmp_path):
    store = Store(tmp_path / 'state.sqlite')
    before = decision_context(store, HOTEL)
    store.mutate(lambda s: s['data']['rulesSubmission']['reviewResults'][HOTEL]['review']['findings'][0].update(detail='新证据'))
    with TestClient(create_app(store)) as client:
        args = payload(before, reason='已知悉旧证据，测试不得写入。')
        assert client.post(BASE + HOTEL + '/decision', json=args).status_code == 409
        store.mutate(lambda s: s['data']['auditDocuments'][0].update(version=before['expectedVersion'] + 1))
        current = decision_context(store, HOTEL)
        assert current['requiresReview'] and all('重新核实' in row['detail'] for row in current['items'])
        assert client.post(BASE + HOTEL + '/decision', json=payload(current, 'return', '退回补充核实。')).status_code == 200
        historical = Business(store).get_work_document(HOTEL, with_review=True)
        assert not historical['review']['checked'] and historical['review']['stale']


def test_concurrent_decisions_commit_once_and_archive_is_server_owned(tmp_path):
    path = tmp_path / 'state.sqlite'
    stores = [Store(path), Store(path)]
    ctx = decision_context(stores[0], HOTEL)
    def submit(pair):
        index, outcome = pair
        try:
            return decide(stores[index], HOTEL, **payload(ctx, outcome, '人工已核对依据。', str(index)))['decision']['id']
        except BusinessError as e:
            return e.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, enumerate(['approve', 'return'])))
    assert results.count('DECISION_CONFLICT') == 1
    snap = stores[0].snapshot()
    assert len(snap['state']['data']['workDecisionLedger']) == 1
    stores[0].patch({'baseRevision': snap['revision'], 'data': {'handledWorkDocuments': {}, 'workDecisionLedger': {},
                     'workDecisionFixtureVersion': 0, 'auditDocuments': []}})
    assert stores[0].get_state()['data'] == snap['state']['data']


def test_legacy_assignment_upgrade_only_claims_untouched_local_examples(tmp_path):
    seed = json.loads((Path(__file__).parents[1] / 'seed.json').read_text())
    original = deepcopy(seed['data']['auditDocuments'])
    custom = seed['data']['auditDocuments']
    custom[1]['purpose'] = '本地被改过'
    custom[2]['steps'][-1]['actor'] = '改派的审核人'
    custom[4]['sourceUrl'] = 'https://example.org/source'
    custom[5]['synthetic'] = False
    path = tmp_path / 'legacy.sqlite'
    Store(path, seed=seed)
    store = Store(path)
    current = store.get_state()['data']['auditDocuments']
    assert current[0]['steps'][:-1] == original[0]['steps'][:-1]
    assert current[0]['steps'][-1]['actor'] == '吴侠'
    for i in [1, 2, 4, 5]:
        assert current[i] == custom[i]
        c = decision_context(store, current[i]['id'])
        assert c['availableActions'] == [] and c['unavailableReason']
    store.mutate(lambda s: s['data']['auditDocuments'][0]['steps'][-1].update(actor=original[0]['steps'][-1]['actor']))
    assert Store(path).get_state()['data']['auditDocuments'][0]['steps'][-1]['actor'] == original[0]['steps'][-1]['actor']
