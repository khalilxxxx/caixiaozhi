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

SOURCE = '本地模拟业务数据'
DRAFT_IDS = ('travel', 'expense', 'personal')
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


def rules_for(data, draft_id=None, scope='submit', system=None):
    rules = data.get('rulesSubmission', {}).get('rules', [])
    target = system or ('oa' if draft_id == 'travel' else 'expense')
    return [r for r in rules if r.get('enabled') and r.get('system') == target and r.get('scope') in ('both', scope) and (draft_id != 'travel' or r.get('metric') == 'days')]


def signature(rules):
    keys = ('id','name','system','origin','scope','metric','thresholdMinor','thresholdDays','effect','enabled','version','description')
    values = [{k:r[k] for k in keys if k in r} for r in sorted(rules, key=lambda r:r['id'])]
    # 与前端 ruleSignature 的 JSON.stringify 字段顺序一致。
    return json.dumps(values, ensure_ascii=False, separators=(',', ':'))


def evaluate(document, rules):
    review = {'status':'clear','findings':[],'passed':[],'inapplicable':[],'applicable':[]}
    value_fields = {'amount':'amountCents','hotelNight':'hotelNightCents','meal':'mealCents','days':'days','attachment':'attachment','invoiceUnique':'invoiceUnique','validInvoice':'validInvoice'}
    for rule in rules:
        metric = rule.get('metric')
        if (metric == 'hotelNight' and 'hotel' not in document.get('categories', [])) or (metric == 'meal' and 'meal' not in document.get('categories', [])):
            review['inapplicable'].append(rule)
            continue
        review['applicable'].append(rule)
        value = document.get(value_fields.get(metric, ''))
        threshold = rule.get('thresholdDays' if metric == 'days' else 'thresholdMinor')
        if value is None:
            review['findings'].append({'rule':rule,'state':'unknown','actual':'尚未取得必要数据','expected':rule.get('description','补充资料后核验'),'detail':'缺少可靠的业务数据，请补全后重新检查。'})
        elif value is False or (threshold is not None and isinstance(value, (int, float, Decimal)) and not isinstance(value, bool) and value > threshold):
            review['findings'].append({'rule':rule,'state':'hit','actual':str(value),'expected':rule.get('description','满足规则条件'),'detail':'达到个人提醒条件。' if rule.get('origin') == 'personal' else '未满足公司规则，请处理后重新检查。'})
        else:
            review['passed'].append(rule)
    review['status'] = 'attention' if any(f['state']=='hit' for f in review['findings']) else 'unknown' if review['findings'] else 'clear'
    return review


class Business:
    def __init__(self, store):
        self.store = store

    def query_documents(self, query=''):
        state = self.store.get_state()
        data = state['data']
        query = str(query).strip().lower()
        unavailable = [k for k,v in data.get('documentSources', {}).get('states', {}).items() if v != 'ready']
        def matches(doc):
            if not query or query in ('全部','所有','全部单据','所有单据'):
                return True
            text = json.dumps(doc, ensure_ascii=False).lower()
            if query in text:
                return True
            mappings = [(r'差旅|出差','travel_application'),(r'报销','expense_claim'),(r'请假|年假','oa_leave'),(r'采购|付款|支付|到账','payment_request'),(r'合同','contract_approval'),(r'预算','budget_transfer')]
            return any(re.search(pattern, query) and doc.get('typeId') == kind for pattern,kind in mappings)
        documents = [d for d in data.get('documents', []) if matches(d) and d.get('source', {}).get('id') not in unavailable]
        return {'items':documents,'count':len(documents),'unavailableSources':unavailable,'dataSource':SOURCE,'cards':[card('documents','单据查询',data={'query':query,'items':documents},status=f'{len(documents)}张单据')]}

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
        if id not in DRAFT_IDS:
            raise BusinessError('NOT_FOUND','草稿不存在。')
        return data['submissions']['drafts'][id]

    def _draft_result(self, draft):
        return {'draft':draft,'dataSource':SOURCE,'cards':[card('submission',draft['title'],draft['id'],status='待完善' if not draft.get('purpose') else '草稿已保存',data={'draftId':draft['id'],'version':draft['version']})]}

    def get_draft(self, id):
        data = self.store.get_state()['data']
        return {**self._draft_result(self._draft(data,id)),
                'expenseCategories':[c for c in data.get('expenseCategories',[]) if id in c['draftTypes']],
                'legFields':LEG_FIELDS,'activityFields':ACTIVITY_FIELDS}

    def new_draft(self, id):
        seed = json.loads(Path(__file__).with_name('seed.json').read_text())
        template = deepcopy(self._draft(seed['data'], id))
        def create(state):
            data = state['data']
            current = self._draft(data, id)
            effective = data['submissions'].get('edits', {}).get(id, current)
            filled = any(effective.get(key) != value for key, value in template.items()
                         if key not in ('version', 'savedAt', 'status'))
            if current.get('status') != 'awaiting_receipt' and (current.get('status') != 'draft' or filled):
                raise BusinessError('INVALID_STATE', '当前草稿尚有未提交内容，请先处理，不能直接覆盖。')
            draft = {**deepcopy(template), 'version': current['version'] + 1, 'savedAt': now()}
            data['submissions']['drafts'][id] = draft
            data['submissions'].setdefault('edits', {}).pop(id, None)
            data['submissions'].setdefault('checks', {}).pop(id, None)
            return self._draft_result(draft)
        return self.store.mutate(create)

    def update_draft(self, id, patch):
        if not isinstance(patch, dict):
            raise BusinessError('VALIDATION_ERROR','草稿修改必须是字段对象。')
        allowed = {'title','applicant','department','paymentCompany','travelType','purpose','legs','activities','activityMode','companions','applicationId','expenses','files','materialIds','subsidyCents'}
        if set(patch)-allowed:
            raise BusinessError('VALIDATION_ERROR','包含不可修改的草稿字段。',{'fields':sorted(set(patch)-allowed)})
        def update(state):
            data = state['data']
            draft = self._draft(data,id)
            if draft.get('status') != 'draft':
                raise BusinessError('INVALID_STATE','单据已提交，不能修改原申请。')
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
            draft.update(value)
            draft['version'] += 1
            draft['savedAt'] = now()
            data['submissions'].setdefault('checks',{}).pop(id,None)
            data['submissions'].setdefault('edits',{}).pop(id,None)
            return self._draft_result(draft)
        return self.store.mutate(update)

    def _check(self, data, draft):
        issues = []
        def issue(path, message):
            issues.append({'path':path,'message':message})
        def require(obj, field, path=''):
            if not isinstance(obj.get(field), str) or not obj[field].strip():
                issue(f'{path}{field}', f'请填写{LABELS.get(field,field)}。')
        for field in ('title','applicant','department','paymentCompany','purpose'):
            require(draft,field)
        if draft['id'] == 'travel':
            require(draft,'travelType')
        if draft['id'] == 'expense':
            require(draft,'applicationId')
        legs = draft.get('legs',[])
        if draft['id'] != 'personal':
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
                    if draft['id'] != 'personal' and start and end and (activity['expiryDate'] < start or activity['effectiveDate'] > end):
                        issue(f'activities.{i}.effectiveDate','活动日期须与差旅日期有交集。')
        categories = {c['id']:c for c in data['expenseCategories']}
        expenses = draft.get('expenses',[])
        totals,meals,hotels = [],[],[]
        if draft['id'] != 'travel':
            if not expenses:
                issue('expenses','请添加费用明细。')
            for i,item in enumerate(expenses):
                prefix = f'expenses.{i}.'
                definition = categories.get(item.get('categoryId'))
                if not definition or draft['id'] not in definition['draftTypes']:
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
        attached = [f.get('id') for f in draft.get('files',[]) if isinstance(f,dict)]
        line_files = set()
        duplicate_line_file = False
        for item in expenses:
            invoice_ids = {f.get('id') for f in item.get('files',[]) if isinstance(f,dict) and f.get('id')}
            if item.get('sourceFileId'):
                invoice_ids.add(item['sourceFileId'])
            duplicate_line_file = duplicate_line_file or bool(line_files & invoice_ids)
            line_files.update(invoice_ids)
            attached.extend(invoice_ids)
        unique_files = set(filter(None,attached))
        # 查验来源以只读初始种子为准，不能由草稿或可编辑 material.synthetic 伪造。
        seeded = json.loads(Path(__file__).with_name('seed.json').read_text())['data']['materials']['files']
        trusted = {f['id']:f for f in seeded}
        previous_files = set()
        for req in data['submissions'].get('requests',[]):
            previous_files.update(f.get('id') for f in req.get('snapshot', {}).get('files', []) if isinstance(f, dict))
            for item in req.get('snapshot',{}).get('expenses',[]):
                previous_files.update(f.get('id') for f in item.get('files',[]) if isinstance(f,dict))
                if item.get('sourceFileId'): previous_files.add(item['sourceFileId'])
        invoice_unique = bool(unique_files) and not duplicate_line_file and not bool(unique_files & previous_files) and not any(trusted.get(fid,{}).get('status')=='duplicate' for fid in unique_files)
        valid_invoice = True if unique_files and all(trusted.get(fid,{}).get('status')=='recognized' for fid in unique_files) else None
        try:
            total_amount = draft_total(draft)
        except (BusinessError, KeyError):
            total_amount = None
            if len(totals) == len(expenses):
                issue('subsidyCents', '补贴金额须为非负整数分。')
        review_doc = {'amountCents':total_amount,'mealCents':sum(meals),'hotelNightCents':max(hotels) if hotels and all(h is not None for h in hotels) else None,'days':(date.fromisoformat(end)-date.fromisoformat(start)).days+1 if start and end else None,'categories':(['hotel'] if hotels else [])+(['meal'] if meals else []),'invoiceUnique':invoice_unique if unique_files else None,'validInvoice':valid_invoice,'attachment':bool(draft.get('files')) or bool(expenses) and all(item.get('files') for item in expenses)}
        active = rules_for(data,draft['id'])
        review = evaluate(review_doc,active)
        check = {'version':draft['version'],'signature':signature(active),'checkedAt':now(),'issues':issues,'review':review}
        return check,not issues and not any(f['state']=='unknown' or f['rule'].get('effect')=='block' for f in review['findings'])

    def validate_draft(self, id):
        def validate(state):
            data=state['data']
            draft=self._draft(data,id)
            check,allowed=self._check(data,draft)
            data['submissions'].setdefault('checks',{})[id]=check
            return {'draft':draft,'check':check,'canSubmit':allowed,'dataSource':SOURCE,'cards':[card('submission',draft['title'],id,status='待确认提交' if allowed else '需补充或核实',data={'draftId':id,'canSubmit':allowed})]}
        return self.store.mutate(validate)

    def submit_draft(self, id, version, idempotency_key):
        if not isinstance(idempotency_key,str) or not 1 <= len(idempotency_key) <= 200:
            raise BusinessError('VALIDATION_ERROR','提交需要有效的幂等标识。')
        if isinstance(version,bool) or not isinstance(version,int) or version<1:
            raise BusinessError('VALIDATION_ERROR','草稿版本无效。')
        fingerprint = hashlib.sha256(canonical({'id':id,'version':version}).encode()).hexdigest()
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
            if not allowed:
                raise BusinessError('VALIDATION_ERROR','单据尚未通过服务端检查。',{'check':check})
            created=now()
            business_id=f"LOCAL-{'TR' if id=='travel' else 'BX'}-{datetime.now(timezone.utc):%Y%m%d}-{uuid4().hex[:8].upper()}"
            request_id='request-'+uuid4().hex
            receipt_id='receipt-'+uuid4().hex
            amount=draft_total(draft)
            request={'id':request_id,'draftId':id,'title':draft['title'],'applicant':draft['applicant'],'amountCents':amount,'createdAt':created,'status':'awaiting_receipt','localStatus':'accepted','businessId':business_id,'receiptId':receipt_id,'snapshot':deepcopy(draft),'check':check}
            receipt={'id':receipt_id,'requestId':request_id,'draftId':id,'businessId':business_id,'status':'accepted','acceptedAt':created,'externalStatus':'not_connected','source':'本地模拟业务服务','message':'本地已受理，尚未发送至外部业务系统。'}
            type_id='travel_application' if id=='travel' else 'expense_claim'
            document={'key':f'local/{type_id}/{business_id}','source':{'id':'local','label':'本地业务服务'},'typeId':type_id,'typeLabel':'差旅申请' if id=='travel' else '费用报销','id':business_id,'title':draft['title'],'sourceStatus':'本地已受理','status':'processing','phase':'approval','phaseLabel':'待本地审批','summary':[{'label':'申请人','value':draft['applicant']},{'label':'事由','value':draft['purpose']}],'updatedAt':created,'details':[{'label':'申请人','value':draft['applicant']},{'label':'部门','value':draft['department']},{'label':'所属公司','value':draft['paymentCompany']},{'label':'数据来源','value':'本地模拟业务服务；未发送外部系统'}],'steps':[{'id':'accepted','label':'本地受理','status':'done','time':created},{'id':'review','label':'待本地审批','status':'current'}],'synthetic':True}
            if id!='travel':
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

    def preaudit(self, system=None, ids=None):
        if system not in (None,'expense','oa'):
            raise BusinessError('VALIDATION_ERROR','预审系统无效。')
        def run(state):
            data=state['data']
            items=[]
            counts={'attention':0,'unknown':0,'clear':0}
            for doc in data.get('auditDocuments',[]):
                if system and doc['system']!=system or ids and doc['id'] not in ids:
                    continue
                review=evaluate(doc,rules_for(data,scope='review',system=doc['system']))
                items.append({'document':doc,'review':review})
                counts[review['status']]+=1
            rules=data['rulesSubmission']
            if system:
                rules['reviewedRules']=[r for r in rules.get('reviewedRules',[]) if r['system']!=system]+deepcopy([r for r in rules['rules'] if r['system']==system])
                rules['reviewedAt'][system]=now()
            else:
                rules['reviewedRules']=deepcopy(rules['rules'])
                rules['reviewedAt']={'expense':now(),'oa':now()}
            return {'items':items,'counts':counts,'reviewedAt':rules['reviewedAt'],'dataSource':SOURCE,'cards':[card('audit','待办预审','batch',status=f'{len(items)}张待办',data={**counts,'stale':False})]}
        return self.store.mutate(run)
