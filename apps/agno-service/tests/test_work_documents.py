import json
from copy import deepcopy
from datetime import date
from pathlib import Path

from store import Store


def test_sample_work_documents_reconcile_with_their_business_facts(tmp_path):
    records = Store(tmp_path / 'state.db').get_state()['data']['auditDocuments']
    assert len(records) == len({doc['id'] for doc in records}) == 13
    assert sum(doc.get('documentType') == 'travel' for doc in records) >= 3
    for doc in records:
        assert doc['synthetic'] is True
        assert doc['purpose'] and doc['sourceLabel']
        assert doc['steps'][-1]['status'] == 'current'
        assert doc['steps'][0]['actor'] == doc['person']
        if doc.get('documentType') == 'travel':
            legs = doc['legs']
            assert legs[0]['departureCity'] == legs[-1]['arrivalCity']
            duration = date.fromisoformat(legs[-1]['arrivalDate']) - date.fromisoformat(legs[0]['departureDate'])
            assert duration.days + 1 == doc['days']
        if doc.get('expenses'):
            assert sum(row['amountCents'] for row in doc['expenses']) == doc['amountCents']
            assert all(row['sourceFileId'] in {file['id'] for file in doc['files']} for row in doc['expenses'])
            hotels = [row for row in doc['expenses'] if row['categoryId'] == 'hotel']
            if hotels:
                assert max(row['amountCents'] // (row['rooms'] * row['nights']) for row in hotels) == doc['hotelNightCents']
            meals = [row for row in doc['expenses'] if row['categoryId'].startswith('reception-meal')]
            if meals:
                assert sum(row['amountCents'] for row in meals) == doc['mealCents']


def test_existing_workspace_gets_sample_details_once_and_keeps_edited_records(tmp_path):
    seed = json.loads((Path(__file__).parents[1] / 'seed.json').read_text())
    old = seed['data']['auditDocuments'][0]
    custom = deepcopy(seed['data']['auditDocuments'][1])
    header_fields = {'id', 'title', 'system', 'kind', 'person', 'department', 'amountCents', 'mealCents',
                     'hotelNightCents', 'period', 'invoiceUnique', 'attachment', 'stage', 'version', 'categories', 'nights'}
    old = {key: value for key, value in old.items() if key in header_fields}
    old['version'] -= 1
    custom.update(purpose='该工作区后来补录的客户名称', title='财务调整后的费用')
    seed['data']['auditDocuments'] = [old, custom]
    path = tmp_path / 'old.db'
    Store(path, seed=seed)
    store = Store(path)
    data = store.get_state()['data']
    upgraded, untouched, *new = data['auditDocuments']
    assert upgraded['version'] == old['version'] + 1 and upgraded['expenses']
    assert untouched == custom
    assert len(new) == 5
    snapshot = data['rulesSubmission']['reviewResults'][old['id']]
    assert snapshot['documentVersion'] == upgraded['version']
    assert snapshot['review']['status'] == 'attention'
    assert custom['id'] not in data['rulesSubmission']['reviewResults']

    def remove_local_sample(state):
        state['data']['auditDocuments'].pop()
    store.mutate(remove_local_sample)
    saved = store.snapshot()
    assert Store(path).snapshot() == saved


def test_travel_duration_rule_handles_only_travel_requests_after_upgrade(tmp_path):
    from business import Business

    seed = json.loads((Path(__file__).parents[1] / 'seed.json').read_text())
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        rule = next(rule for rule in seed['data'][key]['rules'] if rule['id'] == 'P002')
        rule.pop('documentTypes')
        rule.update(version=3, enabled=True, description='申请天数超过5天时，审单时提醒我。')
        if key == 'srsRuleCenterV1':
            rule.update(logic='OA申请天数超过5天时，审单时提醒本人。',
                        output='每张OA申请输出一条天数检查结果，列明申请天数与阈值。',
                        applicability=['OA办公系统', '审单场景'],
                        evidence=[{'name': '申请天数', 'source': 'OA申请 · 申请信息', 'purpose': '读取本次申请的天数'}])
    path = tmp_path / 'travel-rule.db'
    Store(path, seed)
    store = Store(path)
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        current = next(rule for rule in store.get_state()['data'][key]['rules'] if rule['id'] == 'P002')
        assert current['enabled'] and current['documentTypes'] == ['travel'] and current['version'] == 4
    review = Business(store).preaudit('oa')
    for item in review['items']:
        doc, result = item['document'], item['review']
        if doc['kind'] in ('请假申请', '采购付款'):
            assert 'P002' in {rule['id'] for rule in result['inapplicable']}
            assert not result['applicable']
        else:
            assert 'P002' in {rule['id'] for rule in result['applicable']}
            assert any(finding['rule']['id'] == 'P002' for finding in result['findings']) == (doc['days'] > 5)
