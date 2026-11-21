"""本机业务适配器。模型只使用查询、草稿准备和检查；提交只能由 HTTP 确认入口调用。"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from pathlib import Path
from uuid import uuid4
from document_search import search_documents
from submission_defaults import apply_submission_defaults, draft_snapshot_token, expand_agent_row_patch, merge_draft_patch, reimbursement_number, submission_context

SOURCE = '本地模拟业务数据'
DRAFT_IDS = ('travel', 'expense', 'personal')
APPROVED_TRAVEL_STATUSES = {'已审批', '已批准', '审批通过'}
DATE_FIELDS = {'date', 'departureDate', 'arrivalDate', 'checkIn', 'checkOut'}
EXPENSE_FIELDS = ('id categoryId name currency amount reason reasonOption date tripId departureDate arrivalDate departureCity arrivalCity transport checkIn checkOut city rooms nights rental coResidents people quantity standard oaId').split()
LEG_FIELDS = ('id departureCity arrivalCity departureDate arrivalDate transport').split()
ACTIVITY_FIELDS = ('id oaNumber activityNumber description effectiveDate expiryDate allocation oaUrl').split()
LABELS = {'title':'单据标题','applicant':'申请人','department':'部门','paymentCompany':'付款公司','purpose':'事由','currency':'币种','amount':'金额','reason':'费用事由','date':'费用日期','tripId':'关联行程','departureDate':'出发日期','arrivalDate':'到达日期','departureCity':'出发城市','arrivalCity':'到达城市','transport':'交通方式','checkIn':'入住日期','checkOut':'退房日期','city':'城市','rooms':'房间数','nights':'间夜','people':'人数','quantity':'数量','standard':'接待标准','oaId':'OA单号'}

class BusinessError(ValueError):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details or {}


def now():
    return datetime.now(timezone.utc).isoformat()


def minor(value):
    """输入人民币元，拒绝负数、无穷值、精度截断与超大金额，返回整数分。"""
    if isinstance(value, bool) or not re.fullmatch(r'\d+(?:\.\d{1,2})?', str(value).strip()):
        raise BusinessError('VALIDATION_ERROR', '金额须为非负数，最多两位小数。')
    try:
        number = Decimal(str(value).strip()) * 100
        if not number.is_finite() or number > 10_000_000_000:
            raise InvalidOperation
        return int(number)
    except (InvalidOperation, ValueError, OverflowError):
        raise BusinessError('VALIDATION_ERROR', '金额超出允许范围。') from None


def draft_total(draft):
    subsidy = draft.get('subsidyCents')
    if subsidy is not None and (isinstance(subsidy, bool) or not isinstance(subsidy, int) or not 0 <= subsidy <= 10_000_000_000):
        raise BusinessError('VALIDATION_ERROR', '补贴金额须为非负整数分。')
    return sum(minor(item['amount']) for item in draft.get('expenses', [])) + (subsidy or 0)


def is_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def travel_application_legs(document):
    """只使用申请中已经结构化且可核对的行程。"""
    rows = document.get('legs')
    if not isinstance(rows, list):
        return []
    legs = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        leg = {field: row.get(field, '') for field in LEG_FIELDS}
        if any(not isinstance(value, str) or len(value) > 8000 for value in leg.values()):
            continue
        if not all(leg[field].strip() for field in ('id', 'departureCity', 'arrivalCity')) or leg['id'] in seen:
            continue
        if any(leg[field] and not is_date(leg[field]) for field in ('departureDate', 'arrivalDate')):
            continue
        if leg['arrivalDate'] and leg['arrivalDate'] < leg['departureDate']:
            continue
        seen.add(leg['id'])
        legs.append({**leg, **{flag: row[flag] for flag in ('isReturn', 'isOvernight') if isinstance(row.get(flag), bool)}})
    return legs


def travel_application_time(application):
    try:
        updated = datetime.fromisoformat(application['updatedAt'])
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)
    return updated if updated.tzinfo is not None else updated.replace(tzinfo=timezone.utc)


def card(kind, title, id=None, **kwargs):
    return {'kind':kind, 'title':title, **({'id':id} if id else {}), **kwargs}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def string_fields(item, fields):
    for key in fields:
        if key in item and (not isinstance(item[key], str) or len(item[key]) > 8000):
            raise BusinessError('VALIDATION_ERROR', f'{LABELS.get(key,key)}必须是文本，且不能超过8000字。')


def attachment_list(items):
    if not isinstance(items, list) or len(items) > 100:
        raise BusinessError('VALIDATION_ERROR', '附件必须是最多100项的数组。')
    output = []
    for item in items:
        if not isinstance(item, dict):
            raise BusinessError('VALIDATION_ERROR', '附件信息格式无效。')
        string_fields(item, ('id','name','type'))
        size = item.get('size',0)
        if isinstance(size,bool) or not isinstance(size,int) or size<0:
            raise BusinessError('VALIDATION_ERROR', '附件大小无效。')
        output.append({'id':'','name':'','type':'application/octet-stream','size':0,**deepcopy(item)})
    return output


def draft_type(draft):
    kind = draft.get('type') or draft.get('id')
    if kind not in DRAFT_IDS:
        raise BusinessError('VALIDATION_ERROR', '单据类型无效。')
    return kind


def rules_for(data, draft_id=None, scope='submit', system=None):
    if draft_id:
        stored = data.get('submissions', {}).get('drafts', {}).get(draft_id)
        draft_id = draft_type(stored) if stored else draft_id
    rules = data.get('rulesSubmission', {}).get('rules', [])
    target = system or ('oa' if draft_id == 'travel' else 'expense')
    return [r for r in rules if r.get('metric') != 'validInvoice' and r.get('enabled') and r.get('system') == target and r.get('scope') in ('both', scope)
            and (draft_id != 'travel' or r.get('metric') in ('days', 'semantic'))
            and (not draft_id or not r.get('documentTypes') or draft_id in r['documentTypes'])]


def signature(rules):
    keys = ('id','name','system','origin','scope','metric','thresholdMinor','thresholdDays','effect','enabled','version','description','instruction','requiredFields','documentTypes')
    values = [{k:r[k] for k in keys if k in r} for r in sorted(rules, key=lambda r:r['id'])]
    # 与前端 ruleSignature 的 JSON.stringify 字段顺序一致。
    return json.dumps(values, ensure_ascii=False, separators=(',', ':'))


METRIC_FIELDS = {'amount': 'amountCents', 'hotelNight': 'hotelNightCents', 'meal': 'mealCents',
                 'days': 'days', 'attachment': 'attachment', 'invoiceUnique': 'invoiceUnique'}
METRIC_NAMES = {'amount': '单据金额', 'hotelNight': '住宿单价', 'meal': '餐饮合计',
                'days': '申请天数', 'attachment': '附件完整性', 'invoiceUnique': '发票重复核验结果'}


def _metric_value(metric, value):
    if metric == 'days':
        return f'{value}天'
    unit = '/间夜' if metric == 'hotelNight' else ''
    return f'¥{Decimal(value) / 100:,.2f}{unit}'


def _hit_finding(rule, value, threshold):
    metric = rule['metric']
    if metric == 'invoiceUnique':
        actual, reason = '存在重复使用的发票', '发票核对记录显示，本单存在已用于其他报销单的发票。'
    elif metric == 'attachment':
        actual, reason = '必要材料不完整', '单据缺少本项规则要求的证明材料。'
    else:
        actual = _metric_value(metric, value)
        limit = _metric_value(metric, threshold)
        reason = f'{METRIC_NAMES[metric]}为{actual}，超过{"提醒阈值" if rule.get("origin") == "personal" else "规则上限"}{limit}。'
    return {'rule': rule, 'state': 'hit', 'actual': actual, 'expected': rule.get('description', rule.get('name', '规则要求')),
            'detail': reason, 'evidence': [{'path': METRIC_FIELDS[metric],
                                            'quote': json.dumps(value, ensure_ascii=False) if isinstance(value, bool) else str(value)}]}


def evaluate(document, rules):
    review = {'status':'clear','findings':[],'passed':[],'inapplicable':[],'applicable':[]}
    for rule in rules:
        metric = rule.get('metric')
        if metric == 'validInvoice':
            continue
        if ((rule.get('documentTypes') and document.get('documentType') not in rule['documentTypes']) or
            (metric == 'hotelNight' and 'hotel' not in document.get('categories', [])) or
            (metric == 'meal' and 'meal' not in document.get('categories', []))):
            review['inapplicable'].append(rule)
            continue
        review['applicable'].append(rule)
        value = document.get(METRIC_FIELDS.get(metric, ''))
        threshold = rule.get('thresholdDays' if metric == 'days' else 'thresholdMinor')
        numeric = metric in ('amount', 'meal', 'hotelNight', 'days')
        missing = (value is None or (numeric and (isinstance(value, bool) or
                   not isinstance(value, (int, float, Decimal)) or threshold is None)) or
                   (metric in ('invoiceUnique', 'attachment') and not isinstance(value, bool)))
        if missing:
            name = METRIC_NAMES.get(metric, '必要业务数据')
            review['findings'].append({'rule':rule,'state':'unknown','actual':f'尚未取得{name}','expected':rule.get('description','补充资料后核验'),'detail':f'当前单据缺少{name}，暂时无法判定。'})
        elif value is False or (threshold is not None and isinstance(value, (int, float, Decimal)) and not isinstance(value, bool) and value > threshold):
            review['findings'].append(_hit_finding(rule, value, threshold))
        else:
            review['passed'].append(rule)
    review['status'] = 'attention' if any(f['state']=='hit' for f in review['findings']) else 'unknown' if review['findings'] else 'clear'
    return review


def audit_document_input(doc):
    if doc.get('documentType'):
        return doc
    if doc['system'] == 'oa':
        kind = 'travel' if doc.get('kind') in ('出差申请', '差旅申请') else 'other'
    else:
        kind = 'personal' if doc.get('kind') in ('费用报销', '个人费用报销') else 'expense'
    return {**doc, 'documentType': kind}


def review_work_examples(data, affected_ids):
    """只在预置样例入库时执行一次可离线核对的规则，并保存该次真实结果。"""
    center = data['rulesSubmission']
    saved = center.setdefault('reviewResults', {})
    selected = set(affected_ids)
    changed = False
    for doc in data['auditDocuments']:
        if doc['id'] not in selected:
            continue
        active = rules_for(data, scope='review', system=doc['system'])
        basis = {'documentVersion': doc.get('version', 1), 'signature': signature(active)}
        current = saved.get(doc['id'], {})
        if all(current.get(key) == value for key, value in basis.items()):
            continue
        review = Business(None).evaluate_rules(audit_document_input(doc), active)
        saved[doc['id']] = {**basis, 'review': review, 'checkedAt': now()}
        changed = True
    return changed


def work_review_summary(doc, rules_submission):
    """将审单版本及规则配置同时匹配的快照提供给关联单据对话。"""
    saved = doc.get('decisionReview')
    if saved is None:
        active = rules_for({'rulesSubmission': rules_submission}, scope='review', system=doc['system'])
        saved = rules_submission.get('reviewResults', {}).get(doc['id'])
        checked = bool(saved and saved.get('documentVersion') == doc.get('version', 1)
                       and saved.get('signature') == signature(active))
        stale = bool(saved and not checked)
        total = len(active)
    else:
        checked, stale = saved['checked'], saved['stale']
        total = len(saved['review']['applicable']) + len(saved['review']['inapplicable'])
    review = saved['review'] if checked else {}
    findings = review.get('findings', [])
    hits = [f for f in findings if f['state'] == 'hit']
    pending = [f for f in findings if f['state'] == 'unknown']
    passed, applicable = len(review.get('passed', [])), len(review.get('applicable', []))
    counts = {'total': total, 'executed': applicable - sum(f.get('executed') is False for f in pending),
              'hit': len(hits), 'pending': len(pending), 'passed': passed,
              'inapplicable': len(review.get('inapplicable', []))}
    score = None
    if applicable and (passed or hits):
        lower = (passed * 200 + applicable) // (2 * applicable)
        upper = ((passed + len(pending)) * 200 + applicable) // (2 * applicable)
        score = str(lower) if upper == lower else f'{lower}–{upper}'
    return {'checked': checked, 'stale': stale, 'checkedAt': (saved or {}).get('checkedAt'),
            'score': score, 'scoreMax': 100, 'counts': counts, 'risks': hits, 'pending': pending}


class Business:
    def __init__(self, store, rule_service=None):
        self.store = store
        self.rule_service = rule_service

    def evaluate_rules(self, document, rules):
        """数值事实保持确定性；业务语义交给模型，不能在浏览器重新判定。"""
        legacy = [r for r in rules if r.get('metric') != 'semantic']
        semantic = [r for r in rules if r.get('metric') == 'semantic']
        review = evaluate(document, legacy)
        applicable = []
        for rule in semantic:
            if rule.get('documentTypes') and document.get('documentType') not in rule['documentTypes']:
                review['inapplicable'].append(rule)
            else:
                applicable.append(rule)
        if applicable:
            if self.rule_service:
                result = self.rule_service.evaluate(document, applicable)
            else:
                result = {'inapplicable': [], 'applicable': applicable, 'passed': [],
                          'findings': [{'rule': rule, 'state': 'unknown', 'actual': '尚未执行语义审核',
                                        'expected': rule.get('instruction') or rule.get('description', '规则要求'),
                                        'detail': '尚无模型审查结果。', 'evidence': [], 'executed': False}
                                       for rule in applicable]}
            for key in ('findings', 'passed', 'inapplicable', 'applicable'):
                review[key].extend(result[key])
            if result.get('evaluations'):
                review.setdefault('evaluations', []).extend(result['evaluations'])
            for key in ('engine', 'model', 'evaluatedAt', 'attemptCount'):
                if key in result:
                    review[key] = result[key]
        review['status'] = 'attention' if any(f['state'] == 'hit' for f in review['findings']) else 'unknown' if review['findings'] else 'clear'
        return review

    @staticmethod
    def _allowed(check):
        return not check['issues'] and not any(
            f['rule'].get('effect') == 'block' or
            (f['state'] == 'unknown' and f['rule'].get('metric') != 'semantic')
            for f in check['review']['findings'])

    def query_documents(self, query='', document_ids=None):
        if document_ids is not None and (not isinstance(document_ids, list)
                                         or any(not isinstance(value, str) for value in document_ids)):
            raise BusinessError('VALIDATION_ERROR', '单据引用格式无效。')
        query = str(query).strip().lower()
        documents, unavailable = search_documents(self.store.get_state()['data'], query, document_ids)
        card_data = {'query': query, 'items': documents, 'unavailableSources': unavailable}
        if document_ids is not None:
            card_data['documentIds'] = document_ids
        return {'items': documents, 'count': len(documents), 'unavailableSources': unavailable, 'dataSource': SOURCE,
                'cards': [card('documents', '单据进展', data=card_data, status=f'{len(documents)}张单据')]}

    def _available_travel_applications(self, data):
        employee = submission_context({})['currentEmployee']
        documents = [doc for doc in data.get('documents', []) if doc.get('typeId') == 'travel_application']
        sources = {'travel'} | {doc.get('source', {}).get('id') for doc in documents}
        states = data.get('documentSources', {}).get('states', {})
        unavailable = sorted(source for source in sources if source and states.get(source, 'ready') != 'ready')
        applications = []
        if not employee:
            return employee, applications, unavailable
        for document in documents:
            source = document.get('source', {})
            if not source.get('id') or source['id'] in unavailable:
                continue
            if document.get('status') != 'completed' or document.get('sourceStatus') not in APPROVED_TRAVEL_STATUSES:
                continue
            applicant_id = document.get('applicantId')
            if applicant_id is not None:
                belongs_to_employee = applicant_id == employee['id']
            else:
                # 旧文档有且只有一个申请人姓名时，按当前本地员工档案匹配。
                names = [field.get('value') for field in document.get('details', []) if field.get('label') == '申请人']
                belongs_to_employee = names == [employee['name']]
            if not belongs_to_employee or not document.get('id') or not document.get('key'):
                continue
            applications.append({
                'id': document['id'], 'key': document['key'], 'title': document.get('title', ''),
                'sourceStatus': document['sourceStatus'], 'source': source, 'updatedAt': document.get('updatedAt', ''),
                'applicant': employee['name'], 'legs': travel_application_legs(document),
                'synthetic': document.get('synthetic', False),
            })
        return employee, applications, unavailable

    def query_travel_applications(self, query=''):
        if not isinstance(query, str) or len(query) > 200:
            raise BusinessError('VALIDATION_ERROR', '请输入200字以内的差旅申请单号或关键词。')
        _, applications, unavailable = self._available_travel_applications(self.store.get_state()['data'])
        query = query.strip().casefold()
        items = []
        for application in applications:
            fields = [application['id'], application['title']]
            fields.extend(leg[field] for leg in application['legs'] for field in ('departureCity', 'arrivalCity'))
            if not query or any(query in field.casefold() for field in fields):
                items.append(application)
        items.sort(key=travel_application_time, reverse=True)
        return {'items': items, 'count': len(items), 'unavailableSources': unavailable, 'dataSource': SOURCE}

    def _find_travel_application(self, data, draft, application_id):
        employee, applications, _ = self._available_travel_applications(data)
        if not employee or draft.get('applicant') != employee['name']:
            return None, employee
        matches = [app for app in applications if app['id'].casefold() == application_id.strip().casefold()]
        return (matches[0] if len(matches) == 1 else None), employee

    def analyze(self, month='10', dept='全部部门', type=None):
        month = str(month).removeprefix('2026-').replace('月','').zfill(2)
        if month not in ('09','10'):
            raise BusinessError('VALIDATION_ERROR','当前统计数据仅包含2026年9月和10月。')
        dept = str(dept).removesuffix('部') if dept != '全部部门' else dept
        if dept not in ('全部部门','销售','研发','行政','运营'):
            raise BusinessError('VALIDATION_ERROR','未找到该部门的统计口径。')
        if type is not None and type not in ('差旅','招待','办公','其他'):
            raise BusinessError('VALIDATION_ERROR','费用类型无效。')
        rows = self.store.get_state()['data'].get('analysisRecords', [])
        def selected(period):
            return [r for r in rows if r['month']==period and (dept=='全部部门' or r['dept']==dept) and (type is None or r['type']==type)]
        current = selected(month)
        total = sum(minor(r['amount']) for r in current)
        before = sum(minor(r['amount']) for r in selected('09')) if month == '10' else None
        scope = {'month':month,'dept':dept,'type':type}
        groups = lambda field: [{'name':name,'amountMinor':str(sum(minor(r['amount']) for r in current if r[field]==name))} for name in dict.fromkeys(r[field] for r in current)]
        return {'scope':scope,'budgetMinor':'60000000' if month=='10' and dept=='全部部门' and type is None else None,'budgetSource':'本地合成预算；仅提供2026年10月集团全费用口径','items':current,'count':len(current),'countLabel':'汇总记录',
                'recordMeaning':'每条记录代表2026年某月、某部门、某费用类型的合成汇总金额，不代表一张发票或一笔原始报销。',
                'dataCompleteness':{'scope':'本地合成统计数据集','status':'complete_within_seed_dataset','missingRecords':0,'zeroAmountGroupsOmitted':True,'identifierIsSequential':False,'explanation':'零金额分组不生成汇总记录；编号不连续不代表缺失单据、发票或资料。本数据不能证明真实企业数据完整性，不能据编号或金额推断业务原因。'},
                'totalMinor':str(total),'total':total/100,'previousMinor':str(before) if before is not None else None,'deltaMinor':str(total-before) if before is not None else None,'categories':groups('type'),'departments':groups('dept'),'dataSource':SOURCE,'cards':[card('analysis',f'2026年{int(month)}月费用分析',data={'scope':scope},status=f'¥{total/100:,.2f}')]}

    def create_report(self, month='10', dept='全部部门', type=None):
        analysis = self.analyze(month, dept, type)
        scope = analysis['scope']
        label = '集团' if scope['dept'] == '全部部门' else scope['dept'] + '部'
        summary = f"2026年{int(scope['month'])}月{label}费用合计 ¥{Decimal(analysis['totalMinor'])/100:,.2f}，共{analysis['count']}条汇总记录。"
        if analysis['previousMinor'] is not None:
            summary += f"上月同口径金额 ¥{Decimal(analysis['previousMinor'])/100:,.2f}，变动 ¥{Decimal(analysis['deltaMinor'])/100:,.2f}。"
        summary += '数据来源：本地合成费用汇总；金额变化不构成业务原因证明。'
        report = {'id': 'report-' + uuid4().hex, 'scope': scope, 'title': f"{int(scope['month'])}月{label}{scope['type'] or '费用'}分析", 'summary': summary, 'actions': '结合对应业务活动和费用明细核实变动原因，确认审批及费用发生期间。', 'created': now(), 'status': 'ready', 'version': 1}
        def save(state):
            workspace = state['data'].setdefault('analysisWorkspace', {'scope': scope, 'queries': [], 'reports': []})
            workspace.setdefault('reports', []).insert(0, report)
            return {'report': report, 'dataSource': SOURCE, 'cards': [card('report', report['title'], report['id'], status='已保存', data={'scope': scope})]}
        return self.store.mutate(save)

    def search_knowledge(self, query=''):
        query = str(query).strip()
        keywords = set(re.findall(r'[A-Za-z0-9]+|[\u4e00-\u9fff]{2}', query))
        # 连续中文使用双字词，避免只因“的”“费”等单字而返回无关制度。
        keywords.update(query[i:i+2] for i in range(len(query)-1) if all('\u4e00' <= c <= '\u9fff' for c in query[i:i+2]))
        policies = self.store.get_state()['data'].get('policies', [])
        results = []
        for policy in policies:
            text = json.dumps(policy, ensure_ascii=False)
            score = sum(term in text for term in keywords)
            if not query or query in ('制度','政策','全部制度') or score:
                results.append((score,policy))
        items = [p for _,p in sorted(results,key=lambda v:-v[0])]
        return {'items':items,'dataSource':'本地合成制度','cards':[card('knowledge',p['title'],p['id'],subtitle=f"{p['version']} · 本地合成制度") for p in items]}

    def _draft(self, data, id):
        draft = data.get('submissions', {}).get('drafts', {}).get(id)
        if not draft:
            raise BusinessError('NOT_FOUND','草稿不存在。')
        return draft

    def _draft_result(self, draft):
        return {'draft':draft,'submissionContext':submission_context(draft),'dataSource':SOURCE,'cards':[card('submission',draft['title'],draft['id'],status='待完善' if not draft.get('purpose') else '草稿已保存',data={'draftId':draft['id'],'version':draft['version']})]}

    def get_draft(self, id):
        data = self.store.get_state()['data']
        saved = self._draft(data, id)
        effective = data['submissions'].get('edits', {}).get(id, saved) if saved.get('status') == 'draft' else saved
        return {**self._draft_result(effective),
                'expenseCategories':[c for c in data.get('expenseCategories',[]) if draft_type(self._draft(data, id)) in c['draftTypes']],
                'legFields':LEG_FIELDS+['isReturn','isOvernight'],'activityFields':ACTIVITY_FIELDS}

    def new_draft(self, id):
        def create(state):
            data = state['data']
            kind = draft_type(self._draft(data, id))
            # 身份由统一的本地档案补全，业务内容不从旧单或演示行程复制。
            draft = {
                'id': kind + '-' + uuid4().hex, 'type': kind,
                'title': {'travel': '差旅申请', 'expense': '差旅报销', 'personal': '个人费用报销'}[kind],
                **dict.fromkeys(('applicant', 'department', 'paymentCompany', 'travelType'), ''),
                'purpose': '', 'legs': [], 'activities': [], 'activityMode': 'optional',
                'companions': [], 'applicationId': '', 'expenses': [], 'files': [],
                'subsidyCents': None, 'materialIds': [], 'version': 1,
                'savedAt': now(), 'status': 'draft',
            }
            draft = apply_submission_defaults(draft, adopt_defaults=True)
            if kind in ('expense', 'personal'):
                draft['documentNumber'] = reimbursement_number(data['submissions'])
            data['submissions']['drafts'][draft['id']] = draft
            return self._draft_result(draft)
        return self.store.mutate(create)

    def update_agent_draft(self, id, patch, expected_snapshot, manual_fields=None, remove_rows=None):
        if expected_snapshot is None:
            raise BusinessError('DRAFT_SNAPSHOT_REQUIRED', '请先读取当前草稿，再填写本轮明确的修改。')
        return self.update_draft(id, patch, manual_fields, expected_snapshot=expected_snapshot, remove_rows=remove_rows)

    def update_draft(self, id, patch, manual_fields=None, *, expected_snapshot=None, remove_rows=None):
        if not isinstance(patch, dict):
            raise BusinessError('VALIDATION_ERROR','草稿修改必须是字段对象。')
        allowed = {'title','applicant','department','paymentCompany','travelType','purpose','legs','activities','activityMode','companions','applicationId','expenses','files','materialIds','subsidyCents','returnDatePending'}
        if set(patch)-allowed:
            raise BusinessError('VALIDATION_ERROR','包含不可修改的草稿字段。',{'fields':sorted(set(patch)-allowed)})
        def update(state):
            data = state['data']
            draft = self._draft(data,id)
            if draft.get('status') != 'draft':
                raise BusinessError('INVALID_STATE','单据已提交，不能修改原申请。')
            previous = deepcopy(data['submissions'].get('edits', {}).get(id, draft))
            if expected_snapshot is not None and expected_snapshot != draft_snapshot_token(previous):
                raise BusinessError('STALE_DRAFT', '草稿已有新的修改，请读取最新草稿后再更新需要修改的字段。')
            if (expected_snapshot is not None and draft_type(draft) == 'expense'
                    and 'applicationId' in patch and patch['applicationId'] != previous.get('applicationId')):
                raise BusinessError('APPLICATION_SELECTION_REQUIRED', '请通过差旅申请关联工具让用户确认申请单。')
            value = deepcopy(patch)
            string_fields(value, ('title','applicant','department','paymentCompany','travelType','purpose','applicationId','activityMode'))
            if 'activityMode' in value and value['activityMode'] not in ('required','optional','hidden'):
                raise BusinessError('VALIDATION_ERROR','活动关联方式无效。')
            subsidy = value.get('subsidyCents')
            if subsidy is not None and (isinstance(subsidy,bool) or not isinstance(subsidy,int) or not 0<=subsidy<=10_000_000_000):
                raise BusinessError('VALIDATION_ERROR','补贴须为非负整数分。')
            for key in ('legs','activities','companions','expenses','files','materialIds'):
                if key in value and (not isinstance(value[key], list) or len(value[key]) > 100):
                    raise BusinessError('VALIDATION_ERROR',f'{key}必须是最多100项的数组。')
            for key in ('legs','activities','expenses','files'):
                if key in value and any(not isinstance(item,dict) for item in value[key]):
                    raise BusinessError('VALIDATION_ERROR',f'{key}内容格式无效。')
            for key in ('companions','materialIds'):
                if key in value and any(not isinstance(item,str) for item in value[key]):
                    raise BusinessError('VALIDATION_ERROR',f'{key}必须是文本数组。')
            try:
                if expected_snapshot is not None:
                    value = expand_agent_row_patch(previous, value, remove_rows)
                merged = merge_draft_patch(previous, value)
            except ValueError as exc:
                raise BusinessError('VALIDATION_ERROR', str(exc)) from None
            for key in ('legs','activities','expenses'):
                if key in value:
                    value[key] = merged[key]
            for key, fields in (('legs',LEG_FIELDS),('activities',ACTIVITY_FIELDS)):
                if key in value:
                    normalized = []
                    for item in value[key]:
                        string_fields(item,fields)
                        normalized.append({**dict.fromkeys(fields,''),**item,'id':item.get('id') or str(uuid4())})
                    value[key] = normalized
            if 'files' in value:
                value['files'] = attachment_list(value['files'])
            if 'expenses' in value:
                for item in value['expenses']:
                    string_fields(item,EXPENSE_FIELDS+['sourceFileId','sourceBatchId','sourceSnapshot'])
                    if item.get('aiCheckOut') is not None and not isinstance(item['aiCheckOut'],str):
                        raise BusinessError('VALIDATION_ERROR','建议退房日期格式无效。')
                    item['files'] = attachment_list(item.get('files',[]))
                    item['attachments'] = attachment_list(item.get('attachments',[]))
                value['expenses'] = [{**dict.fromkeys(EXPENSE_FIELDS,''),'currency':'CNY','files':[],'attachments':[],'generated':False,**item,'id':item.get('id') or str(uuid4())} for item in value['expenses']]
            candidate = {**previous, **value}
            try:
                draft.update(apply_submission_defaults(candidate, previous, manual_fields=manual_fields))
            except ValueError as exc:
                raise BusinessError('VALIDATION_ERROR', str(exc)) from None
            draft['version'] += 1
            draft['savedAt'] = now()
            data['submissions'].setdefault('checks',{}).pop(id,None)
            data['submissions'].setdefault('edits',{}).pop(id,None)
            return self._draft_result(draft)
        return self.store.mutate(update)

    def link_travel_application(self, id, application_id, version, *, expected_snapshot=None):
        if not isinstance(id, str) or not id.strip():
            raise BusinessError('VALIDATION_ERROR', '请选择要关联的差旅报销草稿。')
        if not isinstance(application_id, str) or not application_id.strip() or len(application_id) > 200:
            raise BusinessError('VALIDATION_ERROR', '请选择有效的差旅申请单号。')
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise BusinessError('VALIDATION_ERROR', '草稿版本无效。')

        def link(state):
            data = state['data']
            draft = self._draft(data, id)
            if draft_type(draft) != 'expense' or draft.get('status') != 'draft':
                raise BusinessError('INVALID_STATE', '只有待填写的差旅报销草稿可关联申请。')
            submissions = data['submissions']
            edits = submissions.setdefault('edits', {})
            previous = edits.get(id, draft)
            if expected_snapshot is not None and expected_snapshot != draft_snapshot_token(previous):
                raise BusinessError('STALE_DRAFT', '草稿已有新的修改，请读取最新草稿后重新关联。')
            if draft['version'] != version:
                raise BusinessError('VERSION_CONFLICT', '草稿已变化，请同步后重新关联。')
            application, employee = self._find_travel_application(data, previous, application_id)
            if application is None:
                raise BusinessError('TRAVEL_APPLICATION_UNAVAILABLE', '未找到当前申请人已审批且可关联的差旅申请。')

            imported_legs = [] if previous.get('legs') else application['legs']
            if imported_legs:
                import_status = 'imported'
            elif previous.get('legs'):
                import_status = 'existing_legs_preserved'
            else:
                import_status = 'no_available_legs'

            draft.update(previous)
            draft.update(applicationId=application['id'], applicationLink={
                'id': application['id'], 'key': application['key'], 'employeeId': employee['id'],
            }, version=version + 1, savedAt=now())
            if imported_legs:
                draft['legs'] = deepcopy(imported_legs)
            submissions.setdefault('checks', {}).pop(id, None)
            edits.pop(id, None)
            return {**self._draft_result(draft), 'application': application,
                    'importedLegCount': len(imported_legs), 'legImportStatus': import_status}

        return self.store.mutate(link)

    def _check(self, data, draft):
        issues = []
        def issue(path, message):
            issues.append({'path':path,'message':message})
        def require(obj, field, path=''):
            if not isinstance(obj.get(field), str) or not obj[field].strip():
                issue(f'{path}{field}', f'请填写{LABELS.get(field,field)}。')
        for field in ('title','applicant','department','paymentCompany','purpose'):
            require(draft,field)
        if draft_type(draft) == 'travel':
            require(draft,'travelType')
        application = None
        if draft_type(draft) == 'expense':
            application_id = draft.get('applicationId')
            if not isinstance(application_id, str) or not application_id.strip():
                issue('applicationId', '请关联差旅申请。')
            else:
                application, employee = self._find_travel_application(data, draft, application_id)
                link = draft.get('applicationLink') or {}
                if application and link.get('id') == application['id'] and (
                    link.get('key') != application['key'] or link.get('employeeId') != employee['id']
                ):
                    application = None
                if application is None:
                    issue('applicationId', '当前申请号无法核实为本人的已审批差旅申请，请重新选择。')
        legs = draft.get('legs',[])
        if draft_type(draft) != 'personal':
            if not legs:
                issue('legs','请补全差旅行程。')
            for i,leg in enumerate(legs):
                prefix = f'legs.{i}.'
                for field in ('departureCity','arrivalCity','departureDate','arrivalDate','transport'):
                    require(leg,field,prefix)
                for field in ('departureDate','arrivalDate'):
                    if leg.get(field) and not is_date(leg[field]):
                        issue(prefix+field,'日期格式无效。')
                if leg.get('departureCity') and leg.get('departureCity') == leg.get('arrivalCity'):
                    issue(prefix+'arrivalCity','出发城市和到达城市不能相同。')
                if is_date(leg.get('departureDate')) and is_date(leg.get('arrivalDate')) and leg['arrivalDate'] < leg['departureDate']:
                    issue(prefix+'arrivalDate','到达日期不能早于出发日期。')
                if i:
                    prev = legs[i-1]
                    if prev.get('arrivalCity') != leg.get('departureCity'):
                        issue(prefix+'departureCity','出发城市应衔接上一段到达城市。')
                    if is_date(prev.get('arrivalDate')) and is_date(leg.get('departureDate')) and leg['departureDate'] < prev['arrivalDate']:
                        issue(prefix+'departureDate','出发日期不能早于上一段到达日期。')
            if legs and legs[0].get('departureCity') != legs[-1].get('arrivalCity'):
                issue('legs','全部行程须返回最初出发城市。')
            if legs and any(leg.get('arrivalCity') == legs[0].get('departureCity') for leg in legs[:-1]):
                issue('legs','不能中途返回最初出发城市后再次出发。')
        dates = [l[k] for l in legs for k in ('departureDate','arrivalDate') if is_date(l.get(k))]
        start,end = (min(dates),max(dates)) if dates else ('','')
        if draft.get('activityMode') == 'required' and not draft.get('activities'):
            issue('activities','请关联活动或派工。')
        if draft.get('activityMode') != 'hidden':
            for i,activity in enumerate(draft.get('activities',[])):
                for k in ('effectiveDate','expiryDate'):
                    if not is_date(activity.get(k)):
                        issue(f'activities.{i}.{k}','请补全有效的活动日期。')
                if all(is_date(activity.get(k)) for k in ('effectiveDate','expiryDate')):
                    if activity['expiryDate'] < activity['effectiveDate']:
                        issue(f'activities.{i}.expiryDate','活动截止日期不能早于生效日期。')
                    if draft_type(draft) != 'personal' and start and end and (activity['expiryDate'] < start or activity['effectiveDate'] > end):
                        issue(f'activities.{i}.effectiveDate','活动日期须与差旅日期有交集。')
        categories = {c['id']:c for c in data['expenseCategories']}
        expenses = draft.get('expenses',[])
        totals,meals,hotels = [],[],[]
        if draft_type(draft) != 'travel':
            if not expenses:
                issue('expenses','请添加费用明细。')
            for i,item in enumerate(expenses):
                prefix = f'expenses.{i}.'
                definition = categories.get(item.get('categoryId'))
                if not definition or draft_type(draft) not in definition['draftTypes']:
                    issue(prefix+'categoryId','请选择当前单据可用的费用类型。')
                if definition:
                    for field in definition['requiredFields']:
                        require(item,field,prefix)
                if item.get('currency') != 'CNY':
                    issue(prefix+'currency','当前本地业务仅支持人民币；其他币种请先确认汇率与折算。')
                try:
                    amount = minor(item.get('amount',''))
                    totals.append(amount)
                except BusinessError:
                    amount = None
                    issue(prefix+'amount','金额须为非负数，最多两位小数。')
                template = definition.get('template') if definition else ''
                used_dates = ('checkIn','checkOut') if template in ('T03','T09') else ('departureDate','arrivalDate') if template == 'T08' else ('date',) if template != 'T01' else ()
                for field in used_dates:
                    if item.get(field) and not is_date(item[field]):
                        issue(prefix+field,'日期格式无效。')
                if len(used_dates)==2 and all(is_date(item.get(k)) for k in used_dates):
                    a,b = [item[k] for k in used_dates]
                    if b<a or (template in ('T03','T09') and b==a):
                        issue(prefix+used_dates[1],'结束日期须晚于开始日期。' if template in ('T03','T09') else '到达日期不能早于出发日期。')
                for field in ('rooms','nights','people','quantity'):
                    if definition and field in definition['requiredFields'] and item.get(field) and (not re.fullmatch(r'\d+', str(item[field])) or int(item[field]) <= 0):
                        issue(prefix+field,f'{LABELS[field]}须为正整数。')
                if template == 'T01' and item.get('tripId') not in [leg.get('id') for leg in legs]:
                    issue(prefix+'tripId','关联行程不存在，请重新选择。')
                if template == 'T05' and amount is not None:
                    meals.append(amount)
                if template in ('T03','T09'):
                    nights = (date.fromisoformat(item['checkOut'])-date.fromisoformat(item['checkIn'])).days if is_date(item.get('checkIn')) and is_date(item.get('checkOut')) else 0
                    rooms = int(item['rooms']) if str(item.get('rooms','')).isdigit() else 1 if template=='T09' else 0
                    hotels.append(Decimal(amount)/Decimal(nights*rooms) if amount is not None and nights*rooms>0 else None)
        def file_key(file_id):
            row = self.store.get_file(file_id) if hasattr(self.store, 'get_file') and file_id else None
            metadata = row['metadata'] if row else {}
            recognition = metadata.get('materialRecognition', {}).get('recognition') or {}
            number = recognition.get('facts', {}).get('invoiceNumber')
            if recognition.get('role') in ('invoice', 'unknown') and number:
                return ('invoiceNumber', ''.join(str(number).upper().split()))
            digest = metadata.get('sha256')
            return ('sha256', digest) if digest else ('id', file_id)

        materials = {item['id']: item for item in data.get('materials', {}).get('items', []) if item.get('id')}

        def attachment_claims(document):
            claims = []
            represented_files = set()
            for expense in document.get('expenses', []):
                source_id = expense.get('sourceFileId')
                material = materials.get(expense.get('id'), {})
                confirmed_item = material.get('id') if material.get('confirmed') is True and material.get('sourceFileId') == source_id else None
                invoice_ids = {file.get('id') for file in expense.get('files', []) if isinstance(file, dict) and file.get('id')}
                if source_id:
                    invoice_ids.add(source_id)
                for file_id in invoice_ids:
                    claims.append((file_id, confirmed_item if file_id == source_id else None))
                represented_files.update(invoice_ids)
            # 单据层附件同时挂在明细时，只代表同一份原件。
            for file in document.get('files', []):
                file_id = file.get('id') if isinstance(file, dict) else None
                if file_id and file_id not in represented_files:
                    claims.append((file_id, None))
            return claims

        claims_by_file = {}

        def register_claim(file_id, material_id):
            claimed = claims_by_file.setdefault(file_key(file_id), {'files': set(), 'items': set()})
            duplicate = bool(claimed['files']) and (
                material_id is None or None in claimed['items']
                or claimed['files'] != {file_id} or material_id in claimed['items']
            )
            claimed['files'].add(file_id)
            claimed['items'].add(material_id)
            return duplicate

        for request in data['submissions'].get('requests', []):
            for file_id, material_id in attachment_claims(request.get('snapshot', {})):
                register_claim(file_id, material_id)
        current_claims = attachment_claims(draft)
        duplicate_file = False
        for file_id, material_id in current_claims:
            # 相同原件中不同的已核对条目可以分别报销；换名重传仍按摘要拦截。
            duplicate_file = register_claim(file_id, material_id) or duplicate_file
        unique_files = {file_id for file_id, _ in current_claims}
        if duplicate_file and any('receiptReadKey' in item or 'receiptPrefill' in item or item.get('reimbursementBatchId') for item in expenses):
            issue('expenses', '有发票已计入其他费用或已受理的报销单，请核对重复原件。')
        seeded = json.loads(Path(__file__).with_name('seed.json').read_text())['data']['materials']['files']
        trusted = {file['id']: file for file in seeded}
        invoice_unique = bool(unique_files) and not duplicate_file and not any(trusted.get(file_id, {}).get('status') == 'duplicate' for file_id in unique_files)
        try:
            total_amount = draft_total(draft)
        except (BusinessError, KeyError):
            total_amount = None
            if len(totals) == len(expenses):
                issue('subsidyCents', '补贴金额须为非负整数分。')
        review_doc = {'amountCents':total_amount,'mealCents':sum(meals),'hotelNightCents':max(hotels) if hotels and all(h is not None for h in hotels) else None,'days':(date.fromisoformat(end)-date.fromisoformat(start)).days+1 if start and end else None,'categories':(['hotel'] if hotels else [])+(['meal'] if meals else []),'invoiceUnique':invoice_unique if unique_files else None,'attachment':bool(draft.get('files')) or bool(expenses) and all(item.get('files') for item in expenses)}
        review_doc.update({key: deepcopy(draft.get(key)) for key in ('title','purpose','applicant','department','paymentCompany','travelType','legs','activities','expenses','files')})
        review_doc.update(documentType=draft_type(draft), system='oa' if draft_type(draft) == 'travel' else 'expense')
        if draft_type(draft) == 'expense':
            review_doc['applicationId'] = draft.get('applicationId')
            review_doc['travelApplication'] = application
        category_index = {item['id']: item for item in data.get('expenseCategories', [])}
        for expense in review_doc.get('expenses') or []:
            category = category_index.get(expense.get('categoryId'), {})
            expense['categoryName'] = category.get('name', '')
            expense['categoryGroup'] = category.get('group', '')
        active = rules_for(data,draft['id'])
        review = evaluate(review_doc,active)
        check = {'version':draft['version'],'signature':signature(active),'checkedAt':now(),'issues':issues,'review':review,
                 'inputSnapshot':review_doc,'inputHash':hashlib.sha256(canonical(review_doc).encode()).hexdigest()}
        return check,self._allowed(check)

    def validate_draft(self, id, cancel_check=None):
        snapshot = self.store.get_state()['data']
        draft = self._draft(snapshot, id)
        check, _ = self._check(snapshot, draft)
        # 远程推理不得持有数据库写事务；核对结果与完整输入快照绑定。
        check['review'] = self.evaluate_rules(check['inputSnapshot'], rules_for(snapshot, id))
        def validate(state):
            if cancel_check:
                cancel_check()
            data=state['data']
            current=self._draft(data,id)
            fresh, _ = self._check(data, current)
            if any(fresh[key] != check[key] for key in ('version', 'signature', 'inputHash')):
                raise BusinessError('VERSION_CONFLICT', '单据、规则或检查依据已变化，请重新检查。')
            allowed=self._allowed(check)
            data['submissions'].setdefault('checks',{})[id]=check
            return {'draft':current,'submissionContext':submission_context(current),'check':check,'canSubmit':allowed,'dataSource':SOURCE,'cards':[card('submission',current['title'],id,status='待确认提交' if allowed else '需补充或核实',data={'draftId':id,'canSubmit':allowed})]}
        return self.store.mutate(validate)

    def submit_draft(self, id, version, idempotency_key):
        if not isinstance(idempotency_key,str) or not 1 <= len(idempotency_key) <= 200:
            raise BusinessError('VALIDATION_ERROR','提交需要有效的幂等标识。')
        if isinstance(version,bool) or not isinstance(version,int) or version<1:
            raise BusinessError('VALIDATION_ERROR','草稿版本无效。')
        fingerprint = hashlib.sha256(canonical({'id':id,'version':version}).encode()).hexdigest()
        snapshot = self.store.get_state()['data']
        if idempotency_key not in snapshot.get('submissionLedger', {}):
            draft = self._draft(snapshot, id)
            if draft['version'] != version:
                raise BusinessError('VERSION_CONFLICT', '草稿已变化，请重新核对后提交。')
            if any(r.get('metric') == 'semantic' for r in rules_for(snapshot, id)):
                cached = snapshot['submissions'].get('checks', {}).get(id)
                fresh, _ = self._check(snapshot, draft)
                if not cached or any(cached.get(key) != fresh[key] for key in ('version', 'signature', 'inputHash')):
                    self.validate_draft(id)
        def submit(state):
            data=state['data']
            ledger=data.setdefault('submissionLedger',{})
            if idempotency_key in ledger:
                entry=ledger[idempotency_key]
                if entry['fingerprint'] != fingerprint:
                    raise BusinessError('IDEMPOTENCY_CONFLICT','该提交标识已用于另一项操作。')
                return entry['result']
            draft=self._draft(data,id)
            if draft['version'] != version:
                raise BusinessError('VERSION_CONFLICT','草稿已变化，请重新核对后提交。')
            if draft.get('status') != 'draft':
                raise BusinessError('INVALID_STATE','该草稿已提交，请查询原回执。')
            check,allowed=self._check(data,draft)
            if any(r.get('metric') == 'semantic' for r in rules_for(data, id)):
                cached = data['submissions'].get('checks', {}).get(id)
                if not cached or any(cached.get(key) != check[key] for key in ('version', 'signature', 'inputHash')):
                    raise BusinessError('VERSION_CONFLICT', '检查依据已变化，请重新检查后提交。')
                check = {**check, 'review': deepcopy(cached['review']), 'checkedAt': cached['checkedAt']}
                allowed = self._allowed(check)
            if not allowed:
                raise BusinessError('VALIDATION_ERROR','单据尚未通过服务端检查。',{'check':check})
            created=now()
            business_id = draft.get('documentNumber') or f"LOCAL-{'TR' if draft_type(draft)=='travel' else 'BX'}-{datetime.now(timezone.utc):%Y%m%d}-{uuid4().hex[:8].upper()}"
            request_id='request-'+uuid4().hex
            receipt_id='receipt-'+uuid4().hex
            amount=draft_total(draft)
            request={'id':request_id,'draftId':id,'title':draft['title'],'applicant':draft['applicant'],'amountCents':amount,'createdAt':created,'status':'awaiting_receipt','localStatus':'accepted','businessId':business_id,'receiptId':receipt_id,'snapshot':deepcopy(draft),'check':check}
            receipt={'id':receipt_id,'requestId':request_id,'draftId':id,'businessId':business_id,'status':'accepted','acceptedAt':created,'externalStatus':'not_connected','source':'本地模拟业务服务','message':'本地已受理，尚未发送至外部业务系统。'}
            type_id='travel_application' if draft_type(draft)=='travel' else 'expense_claim'
            document={'key':f'local/{type_id}/{business_id}','source':{'id':'local','label':'本地业务服务'},'typeId':type_id,'typeLabel':'差旅申请' if draft_type(draft)=='travel' else '费用报销','id':business_id,'title':draft['title'],'sourceStatus':'本地已受理','status':'processing','phase':'approval','phaseLabel':'待本地审批','summary':[{'label':'申请人','value':draft['applicant']},{'label':'事由','value':draft['purpose']}],'updatedAt':created,'details':[{'label':'申请人','value':draft['applicant']},{'label':'部门','value':draft['department']},{'label':'所属公司','value':draft['paymentCompany']},{'label':'数据来源','value':'本地模拟业务服务；未发送外部系统'}],'steps':[{'id':'accepted','label':'本地受理','status':'done','time':created},{'id':'review','label':'待本地审批','status':'current'}],'synthetic':True}
            if draft_type(draft)!='travel':
                document['amount']={'label':'报销金额','value':f'¥{Decimal(amount)/100:,.2f}','currency':'CNY'}
                document['amountCents']=amount
            data['submissions']['requests'].insert(0,request)
            data['submissions']['checks'][id]=check
            draft['status']='awaiting_receipt'
            data.setdefault('receipts',{})[receipt_id]=receipt
            data.setdefault('documents',[]).insert(0,document)
            for task in state.get('tasks', []):
                linked = any(ref.get('kind') == 'submission' and ref.get('id') == id for ref in task.get('refs', []))
                linked = linked or any(c.get('kind') == 'submission' and c.get('id') == id for m in task.get('messages', []) for c in m.get('cards', []))
                if linked and not task.get('activeRunId'):
                    task['status'] = '本地已受理'

            data.setdefault('documentSources',{}).setdefault('states',{})['local']='ready'
            result={'request':request,'requests':deepcopy(data['submissions']['requests']),'receipt':receipt,'document':document,'dataSource':SOURCE,'cards':[card('submission','本地受理回执',id,status='本地已受理',data={'receipt':receipt,'requestId':request_id,'version':version,'snapshot':request['snapshot']})]}
            ledger[idempotency_key]={'fingerprint':fingerprint,'result':deepcopy(result)}
            return result
        return self.store.mutate(submit)

    def get_receipt(self, id):
        data=self.store.get_state()['data']
        receipt=next((r for r in data.get('receipts',{}).values() if id in (r['id'],r['requestId'],r['businessId'])),None)
        if not receipt:
            raise BusinessError('NOT_FOUND','尚未取得该提交的本地回执。')
        request=next((r for r in data['submissions']['requests'] if r['id']==receipt['requestId']),None)
        return {'receipt':receipt,'request':request,'dataSource':SOURCE,'cards':[card('submission','本地受理回执',receipt['draftId'],status='本地已受理',data={'receipt':receipt,'requestId':receipt['requestId']})]}

    def get_work_document(self, document_id, *, with_review=False):
        data = self.store.get_state()['data']
        doc = next((item for item in data.get('auditDocuments', []) if item['id'] == document_id), None)
        if doc is None:
            doc = data.get('handledWorkDocuments', {}).get(document_id)
        if doc is None:
            raise BusinessError('NOT_FOUND', '未找到这张待办单据，可能已移出当前工作清单。')
        result = {'document': doc, 'dataSource': SOURCE}
        if with_review:
            state = data.get('rulesSubmission', {})
            summary = work_review_summary(doc, state)
            result['review'] = summary
            if summary['checked']:
                saved = (doc.get('decisionReview') or state['reviewResults'][document_id])['review']
                result['passedRules'] = [rule['name'] for rule in saved.get('passed', [])]
                result['inapplicableRules'] = [rule['name'] for rule in saved.get('inapplicable', [])]
        return result

    def preaudit(self, system=None, ids=None, cancel_check=None):
        if system not in (None,'expense','oa'):
            raise BusinessError('VALIDATION_ERROR','预审系统无效。')
        if ids is not None and (not isinstance(ids, list) or any(not isinstance(item, str) for item in ids)):
            raise BusinessError('VALIDATION_ERROR', '预审单据范围无效。')
        snapshot = self.store.get_state()['data']
        selected = [doc for doc in snapshot.get('auditDocuments', [])
                    if (not system or doc['system'] == system) and (not ids or doc['id'] in ids)]
        items = []
        counts = {'attention': 0, 'unknown': 0, 'clear': 0}
        signatures = {}
        for original in selected:
            if cancel_check:
                cancel_check()
            doc = audit_document_input(deepcopy(original))
            active = rules_for(snapshot, scope='review', system=doc['system'])
            signatures[doc['system']] = signature(active)
            review = self.evaluate_rules(doc, active)
            items.append({'document': original, 'review': review})
            counts[review['status']] += 1
        def run(state):
            if cancel_check:
                cancel_check()
            data=state['data']
            current = {doc['id']: doc for doc in data.get('auditDocuments', [])}
            if any(current.get(doc['id']) != doc for doc in selected) or any(
                    signature(rules_for(data, scope='review', system=key)) != value for key, value in signatures.items()):
                raise BusinessError('VERSION_CONFLICT', '单据或规则已变化，请重新预审。')
            rules=data['rulesSubmission']
            for item in items:
                doc = item['document']
                rules.setdefault('reviewResults', {})[doc['id']] = {
                    'documentVersion': doc.get('version', 1), 'signature': signatures[doc['system']],
                    'review': item['review'], 'checkedAt': now(),
                }
            if system:
                rules['reviewedRules']=[r for r in rules.get('reviewedRules',[]) if r['system']!=system]+deepcopy([r for r in rules['rules'] if r['system']==system])
                rules['reviewedAt'][system]=now()
            else:
                rules['reviewedRules']=deepcopy(rules['rules'])
                rules['reviewedAt']={'expense':now(),'oa':now()}
            return {'items':items,'counts':counts,'reviewedAt':rules['reviewedAt'],'dataSource':SOURCE,'cards':[card('audit','待办预审','batch',status=f'{len(items)}张待办',data={**counts,'stale':False})]}
        return self.store.mutate(run)
