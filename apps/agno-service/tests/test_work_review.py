from copy import deepcopy

from business import Business, review_work_examples, work_review_summary


def test_fixture_review_respects_scope_evidence_and_later_configuration():
    def rule(identifier, metric, **fields):
        return dict(id=identifier, name=identifier, system='expense', scope='review', origin='builtin',
                    metric=metric, effect='warn', enabled=True, version=1, description='费用规则', **fields)
    rules = [rule('hotel', 'hotelNight', thresholdMinor=60000), rule('invoice', 'invoiceUnique'),
             rule('meal', 'meal', thresholdMinor=150000), rule('usage', 'semantic', documentTypes=['expense'])]
    doc = dict(id='claim', version=1, system='expense', kind='差旅报销', categories=['hotel'],
               hotelNightCents=78000, invoiceUnique=True)
    data = {'rulesSubmission': {'rules': rules}, 'auditDocuments': [doc]}
    assert review_work_examples(data, ['claim'])
    review = work_review_summary(doc, data['rulesSubmission'])
    assert review['counts'] == {'total': 4, 'executed': 2, 'hit': 1, 'pending': 1, 'passed': 1, 'inapplicable': 1}
    assert review['score'] == '33–67'
    hotel = review['risks'][0]
    assert '¥780.00/间夜' in hotel['detail'] and '¥600.00/间夜' in hotel['detail']
    assert hotel['evidence'] == [{'path': 'hotelNightCents', 'quote': '78000'}]
    assert not review_work_examples(data, ['claim'])
    assert work_review_summary(doc, data['rulesSubmission']) == review
    doc['version'] = 2
    assert work_review_summary(doc, data['rulesSubmission'])['score'] is None
    doc['version'] = 1
    rules[0] = {**rules[0], 'enabled': False}
    stale = work_review_summary(doc, data['rulesSubmission'])
    assert stale['stale'] and not stale['checked'] and not stale['risks']
    assert stale['counts']['executed'] == 0


def test_unresolved_and_unavailable_rules_never_result_in_a_full_score():
    rule = dict(id='travel-approval', name='行程核对', system='oa', enabled=True, version=1,
                scope='review', metric='semantic', documentTypes=['travel'], description='核对行程')
    travel = dict(id='travel', kind='差旅申请', version=1, system='oa')
    leave = dict(id='leave', kind='请假申请', version=1, system='oa')
    data = {'rulesSubmission': {'rules': [rule]}, 'auditDocuments': [travel, leave]}
    assert review_work_examples(data, ['travel', 'leave'])
    a = work_review_summary(travel, data['rulesSubmission'])
    b = work_review_summary(leave, data['rulesSubmission'])
    assert a['score'] is None and a['counts']['pending'] == 1 and not a['counts']['executed']
    assert b['score'] is None and b['counts']['inapplicable'] == 1 and not b['counts']['pending']
    personal = dict(documentType='personal', invoiceUnique=False)
    invoice = {**deepcopy(rule), 'documentTypes': ['personal'], 'metric': 'invoiceUnique'}
    hit = Business(None).evaluate_rules(personal, [invoice])['findings'][0]
    assert '发票' in hit['actual'] and '其他报销单' in hit['detail']
    assert hit['evidence'] == [{'path': 'invoiceUnique', 'quote': 'false'}]
