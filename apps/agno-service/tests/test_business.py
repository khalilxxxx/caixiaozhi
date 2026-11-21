"""业务边界回归：金额、草稿校验、版本与本地提交幂等。"""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE))
if importlib.util.find_spec('business'):
    from business import Business, BusinessError
else:
    Business = None
    BusinessError = ValueError

class MemoryStore:
    def __init__(self):
        self.state = json.loads((SERVICE / 'seed.json').read_text())
        self.revision = 1
    def get_state(self):
        return copy.deepcopy(self.state)
    def mutate(self, fn):
        next_state = copy.deepcopy(self.state)
        result = fn(next_state)
        self.state = next_state
        self.revision += 1
        return copy.deepcopy(result)
    def snapshot(self):
        return {'state': self.get_state(), 'revision': self.revision}

class BusinessTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Business, '业务模块尚未实现')
        self.store = MemoryStore()
        self.business = Business(self.store)
    def travel(self):
        return self.business.update_draft('travel', {
            'purpose': '上海客户拜访',
            'legs': [
                {'id': 'go', 'departureCity': '北京', 'arrivalCity': '上海', 'departureDate': '2026-11-20', 'arrivalDate': '2026-11-20', 'transport': '高铁'},
                {'id': 'back', 'departureCity': '上海', 'arrivalCity': '北京', 'departureDate': '2026-11-22', 'arrivalDate': '2026-11-22', 'transport': '高铁'}
            ]})['draft']
    def test_analysis_uses_persisted_records_and_scope(self):
        result = self.business.analyze('10')
        self.assertEqual(result['totalMinor'], '48600000')
        self.assertEqual(result.get('countLabel'), '汇总记录')
        self.assertEqual(result.get('dataCompleteness', {}).get('missingRecords'), 0)
        self.assertEqual(self.business.analyze('09', '销售部')['totalMinor'], '19000000')
        self.assertEqual(self.business.analyze('09', '销售部')['cards'][0]['data'].get('scope'), {'month':'09','dept':'销售','type':None})
        self.store.state['data']['analysisRecords'][0]['amount'] = '0.01'
        result = self.business.analyze('09', '销售', '差旅')
        self.assertEqual(result['totalMinor'], '1')
    def test_model_patch_has_complete_leg_shape_and_rejects_wrong_field_types(self):
        draft = self.business.update_draft('travel', {'legs':[{'arrivalCity':'上海'}]})['draft']
        self.assertTrue(draft['legs'][0]['id'])
        self.assertEqual(draft['legs'][0]['departureDate'], '')
        self.assertEqual(draft['legs'][0]['transport'], '火车-二等座')
        self.assertIn('legs.' + draft['legs'][0]['id'] + '.transport', draft['autoFill']['fields'])
        for patch in ({'purpose':123}, {'legs':['北京至上海']}, {'legs':[{'transport':[]} ]}, {'companions':[{'name':'张三'}]}, {'expenses':[{'amount':12}]}, {'files':['发票.pdf']}):
            with self.assertRaises(BusinessError):
                self.business.update_draft('travel',patch)
        self.assertFalse(self.business.validate_draft('travel')['canSubmit'])

    def test_submit_rejects_incomplete_draft_even_with_forged_cached_check(self):
        self.store.state['data']['submissions']['checks']['travel'] = {'canSubmit': True}
        with self.assertRaises(BusinessError):
            self.business.submit_draft('travel', 1, 'attempt-incomplete')
        self.assertEqual(self.store.state['data']['receipts'], {})
    def test_leg_validation_rejects_open_journey_and_impossible_date(self):
        draft = self.travel()
        draft['legs'] = draft['legs'][:1]
        draft['legs'][0]['departureDate'] = '2026-02-30'
        self.business.update_draft('travel', {'legs': draft['legs']})
        check = self.business.validate_draft('travel')
        self.assertFalse(check['canSubmit'])
        self.assertTrue(any(i['path'].endswith('departureDate') for i in check['check']['issues']))
        self.assertTrue(any(i['path'] == 'legs' for i in check['check']['issues']))
    def test_edit_invalidates_check_and_stale_version_cannot_submit(self):
        draft = self.travel()
        self.assertTrue(self.business.validate_draft('travel')['canSubmit'])
        self.business.update_draft('travel', {'purpose': '客户交付会议'})
        self.assertNotIn('travel', self.store.state['data']['submissions']['checks'])
        with self.assertRaises(BusinessError):
            self.business.submit_draft('travel', draft['version'], 'attempt-stale')
    def test_submit_is_idempotent_and_creates_queryable_local_receipt(self):
        draft = self.travel()
        first = self.business.submit_draft('travel', draft['version'], 'submit-once')
        again = self.business.submit_draft('travel', draft['version'], 'submit-once')
        self.assertEqual(first['receipt']['id'], again['receipt']['id'])
        self.assertEqual(first['cards'][0]['id'], 'travel')
        self.assertEqual(len(self.store.state['data']['receipts']), 1)
        self.assertEqual(first['receipt']['externalStatus'], 'not_connected')
        self.assertEqual(self.business.get_receipt(first['request']['id'])['receipt'], first['receipt'])
        self.assertEqual(len(self.business.query_documents(first['document']['id'])['items']), 1)
        with self.assertRaises(BusinessError):
            self.business.update_draft('travel', {'purpose': '偷偷改变已提交单据'})
        with self.assertRaises(BusinessError):
            self.business.submit_draft('personal', 1, 'submit-once')
    def test_new_same_type_draft_preserves_history_and_never_discards_filled_draft(self):
        saved = self.travel()
        replacement = self.business.new_draft('travel')['draft']
        self.assertNotEqual(replacement['id'], saved['id'])
        self.assertEqual(self.business.get_draft('travel')['draft'], saved)
        self.assertEqual(replacement['status'], 'draft')
        self.assertEqual(replacement['purpose'], '')
        self.assertEqual(replacement['legs'], [])
        self.assertEqual(replacement['version'], 1)
        first = self.business.submit_draft('travel', saved['version'], 'first-request')
        self.assertEqual(len(self.store.state['data']['submissions']['requests']), 1)
        self.assertEqual(self.business.get_receipt(first['request']['id'])['receipt']['status'], 'accepted')
        self.assertEqual(self.business.query_documents(first['document']['id'])['count'], 1)
        next_draft = self.business.update_draft(replacement['id'], {'purpose': '第二次拜访', 'legs': saved['legs']})['draft']
        self.business.submit_draft(replacement['id'], next_draft['version'], 'second-request')
        self.assertEqual(len(self.store.state['data']['submissions']['requests']), 2)

    def test_invalid_money_and_unknown_currency_block_submission(self):
        draft = self.store.state['data']['submissions']['drafts']['personal']
        draft['purpose'] = '办公采购'
        draft['expenses'] = [{'id':'e1','categoryId':'other-office','currency':'USD','amount':'0.001','reason':'办公采购','date':'2026-11-16','files':[]}]
        check = self.business.validate_draft('personal')
        self.assertFalse(check['canSubmit'])
        self.assertTrue(any(i['path'] == 'expenses.0.amount' for i in check['check']['issues']))
        self.assertTrue(any(i['path'] == 'expenses.0.currency' for i in check['check']['issues']))
    def test_reusing_one_invoice_on_two_expense_lines_is_blocked(self):
        draft = self.store.state['data']['submissions']['drafts']['personal']
        draft['purpose'] = '办公采购'
        item = {'id':'e1','categoryId':'other-office','currency':'CNY','amount':'80.00','reason':'办公用品','date':'2026-11-16','files':[{'id':'material-office'}]}
        draft['expenses'] = [item, {**item,'id':'e2'}]
        result = self.business.validate_draft('personal')
        self.assertFalse(result['canSubmit'])
        self.assertTrue(any(f['rule']['metric']=='invoiceUnique' and f['state']=='hit' for f in result['check']['review']['findings']))

    def test_knowledge_returns_supported_clauses_and_never_fills_unknown_results(self):
        result = self.business.search_knowledge('上海住宿标准')
        self.assertTrue(any('600' in c['text'] for p in result['items'] for c in p['clauses']))
        self.assertEqual(self.business.search_knowledge('量子纠缠')['items'], [])
    def test_rule_changes_apply_on_submission_and_preaudit(self):
        draft = self.travel()
        self.business.validate_draft('travel')
        self.store.state['data']['rulesSubmission']['rules'].append({'id':'limit','name':'出差天数限制','system':'oa','scope':'submit','metric':'days','thresholdDays':1,'effect':'block','enabled':True,'version':1,'origin':'builtin','description':'最多一天'})
        with self.assertRaises(BusinessError):
            self.business.submit_draft('travel', draft['version'], 'rule-changed')
        result = self.business.preaudit()
        documents = self.store.state['data']['auditDocuments']
        self.assertCountEqual([item['document']['id'] for item in result['items']], [doc['id'] for doc in documents])
        self.assertEqual(sum(result['counts'].values()), len(documents))

if __name__ == '__main__':
    unittest.main()


def test_agent_report_is_saved_with_query_scope(tmp_path):
    from store import Store
    store=Store(tmp_path/'report.db')
    result=Business(store).create_report('10','销售')
    assert result['report']['scope']=={'month':'10','dept':'销售','type':None}
    assert '218,000.00' in result['report']['summary']
    assert result['cards'][0]['kind']=='report'
    assert Store(tmp_path/'report.db').get_state()['data']['analysisWorkspace']['reports'][0]['id']==result['report']['id']
