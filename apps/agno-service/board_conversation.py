"""Conversation-bound analytics. Amounts and permissions come from the board adapter."""
from __future__ import annotations

import calendar
import hashlib
import json
import re
from datetime import date, timedelta

from business import BusinessError, is_date
from business_analytics import DEPARTMENTS, business_options, query_board
from store import now

FOCUS_TITLES = {'overview': '概览', 'ranking': '员工差旅费用排行', 'travel': '出差线路',
                'trend': '趋势', 'breakdown': '构成', 'routeSpend': '线路差旅费用'}


def _named_departments(question, options):
    named = [key for key, label in DEPARTMENTS.items() if label in question]
    allowed = {d['id'] for d in options['departments']}
    if not set(named).issubset(allowed):
        raise BusinessError('ANALYTICS_FORBIDDEN', '无权查看所选部门的数据。')
    return named


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _assert_permitted(scope, options):
    allowed = {item['id'] for item in options['departments']}
    ids = scope.get('departmentIds') if isinstance(scope, dict) else None
    if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in allowed for i in ids):
        raise BusinessError('ANALYTICS_FORBIDDEN', '所选部门超出当前权限，请重新选择看板范围。')
    if scope.get('system') not in {item['id'] for item in options['systems']}:
        raise ValueError('找不到该业务系统的看板。')
    if not is_date(scope.get('startDate')) or not is_date(scope.get('endDate')) or scope['startDate'] > scope['endDate']:
        raise ValueError('看板的日期范围无效，请重新选择日期。')


def _public_section(snapshot, question):
    dataset = snapshot.get('dataset') or {}
    currency = dataset.get('currency')
    if currency not in {'CNY', 'USD'} or not snapshot.get('metrics'):
        return None
    unit = '亿元' if currency == 'CNY' else '亿美元'
    metrics = [{'label': item['label'], 'value': item['value'] / 100_000_000, 'unit': unit}
               for item in snapshot['metrics']]
    return {'kind': 'publicFinance', 'question': question, 'snapshot': {
        'title': (dataset.get('shortName') or dataset['entity']) + '公开财报',
        'scopeLabel': snapshot['period']['label'], 'source': dataset['source']['provider'],
        'sourceId': dataset['id'] + '/' + dataset['version'], 'unit': unit, 'metrics': metrics,
        'breakdown': [{'name': metric['label'], 'value': metric['value']} for metric in metrics],
    }}


def _csv_section(result, question):
    if result.get('toolId') != 'expense-summary':
        return None
    return {'kind': 'expenseCsv', 'question': question, 'snapshot': {
        'title': result['fileName'] + '费用汇总', 'scopeLabel': f"共 {result['rowCount']} 条记录",
        'source': '用户上传文件 · ' + result['fileName'], 'sourceId': result['fileId'], 'unit': '元',
        'metrics': [{'label': '费用合计', 'value': int(result['totalMinor']) / 100, 'unit': '元'},
                    {'label': '记录数', 'value': result['rowCount'], 'unit': '条'}],
        'breakdown': [{'name': item['name'], 'value': int(item['amountMinor']) / 100} for item in result['groups']],
    }}


def _travel_spend_view(question):
    if re.search(r'路线|线路|目的地', question) and re.search(r'费用?|金额|支出', question):
        return 'routeSpend'
    if not re.search(r'(?:出差|差旅)(?:的)?(?:费用?|金额|支出)', question):
        return None
    if re.search(r'构成|结构|占比|类别|类型|住宿.*交通|交通.*住宿', question):
        return 'unavailableBreakdown'
    if re.search(r'趋势|走势', question):
        return 'unavailableTrend'
    return None


def _section_allowed(section, options=None):
    if 'scope' in section['snapshot']:
        _assert_permitted(section['snapshot']['scope'], options or business_options())


def _file_granted(refs, result):
    return any((r.get('kind') == 'file' and r.get('id') == result.get('fileId')) or
               (r.get('kind') == 'materials' and result.get('fileId') in (r.get('fileIds') or [])) or
               (r.get('kind') == 'tool' and result.get('id') and r.get('id') == result['id'])
               for r in refs)


class BoardConversation:
    def __init__(self, store, task_id, refs=(), run_id=None, question=''):
        self.store, self.task_id, self.refs = store, task_id, refs
        self.run_id, self.question = run_id, question

    def sections(self, current_turn_only=False):
        with self.store.connect() as db:
            rows = db.execute("""SELECT b.body FROM business_board_results b JOIN runs r ON r.id=b.run_id
                               WHERE r.task_id=? AND b.kind IN ('query','expenseCsv','publicFinance') AND (? IS NULL OR b.run_id=?) ORDER BY r.rowid,b.rowid""",
                              (self.task_id, self.run_id if current_turn_only else None, self.run_id)).fetchall()
        sections = [json.loads(row['body']) for row in rows]
        for section in sections:
            _section_allowed(section)
        return sections

    def scope(self):
        with self.store.connect() as db:
            row = db.execute("""SELECT json_extract(b.body, '$.snapshot.scope') AS scope
                               FROM business_board_results b JOIN runs r ON r.id=b.run_id
                               WHERE r.task_id=? AND b.kind IN ('query','scope') ORDER BY b.rowid DESC LIMIT 1""", (self.task_id,)).fetchone()
        if row:
            scope = json.loads(row['scope'])
            _assert_permitted(scope, business_options())
            return scope
        board = next((r for r in self.refs if r.get('kind') == 'business-board'), None)
        options = business_options()
        if board:
            scope = board.get('scope')
            _assert_permitted(scope, options)
            return scope
        report = next((r for r in self.refs if r.get('kind') == 'report'
                       and str(r.get('id', '')).startswith('business-report-')), None)
        if report:
            sections = get_board_report(self.store, report['id'])['sections']
            return next((s['snapshot']['scope'] for s in reversed(sections) if 'scope' in s['snapshot']), options['defaultScope'])
        return options['defaultScope']

    def _save(self, result_id, kind, body):
        with self.store.lock, self.store.connect() as db:
            db.execute('INSERT OR IGNORE INTO business_board_results (id,run_id,kind,body) VALUES(?,?,?,?)',
                       (result_id, self.run_id, kind, _encode(body)))
            row = db.execute('SELECT body FROM business_board_results WHERE id=?', (result_id,)).fetchone()
        return json.loads(row['body'])

    def capture(self, tool_name, result):
        section = None
        if tool_name == 'query_public_financials':
            section = _public_section(result, self.question)
        elif tool_name in {'summarize_expense_csv', 'read_expense_summary'}:
            source = result.get('result') or {}
            if _file_granted(self.refs, source):
                section = _csv_section(source, self.question)
        if section:
            digest = hashlib.sha256(_encode([self.run_id, section]).encode()).hexdigest()[:32]
            self._save('analysis-source-' + digest, section['kind'], section)

    def restore_previous_results(self):
        # Older runs have authoritative result events, predating the analytics ledger.
        # Use their exact snapshots and original file grants. Client workspace patches
        # or a result looked up by filename are not evidence that it belongs here.
        with self.store.connect() as db:
            rows = db.execute("""SELECT r.id,r.request,json_extract(e.data,'$.cards') AS cards
                               FROM runs r JOIN events e ON e.run_id=r.id AND e.kind='result'
                               WHERE r.task_id=? AND NOT EXISTS (
                                   SELECT 1 FROM business_board_results b WHERE b.run_id=r.id AND b.kind IN ('publicFinance','expenseCsv')
                               ) AND EXISTS (SELECT 1 FROM json_each(e.data,'$.cards') AS c
                                   WHERE json_extract(c.value,'$.data.publicFinance')=1 OR
                                         json_extract(c.value,'$.id') LIKE 'expense-summary-%')
                               ORDER BY r.rowid""", (self.task_id,)).fetchall()
        for row in rows:
            req = json.loads(row['request'])
            origin = BoardConversation(self.store, self.task_id, req.get('refs', []), row['id'], req.get('message', ''))
            for card in json.loads(row['cards'] or '[]'):
                data = card.get('data') or {}
                if data.get('publicFinance'):
                    snapshot = data.get('snapshot')
                    if card.get('kind') == 'report' and str(card.get('id', '')).startswith('public-report-'):
                        from financial_analytics import get_report
                        snapshot = get_report(self.store, card['id'])['snapshot']
                    if not snapshot or not _public_section(snapshot, origin.question):
                        raise ValueError('历史财报结果缺少可核验的指标，请重新查询后生成报告。')
                    origin.capture('query_public_financials', snapshot)
                if card.get('kind') == 'tool' and str(card.get('id', '')).startswith('expense-summary-'):
                    from expense_summary import get_result
                    result = get_result(self.store, card['id'])
                    if not _file_granted([*origin.refs, *self.refs], result):
                        raise ValueError('请将此前汇总的 CSV 文件或其汇总结果加入当前会话，再生成报告。')
                    origin.refs = [*origin.refs, *self.refs]
                    origin.capture('read_expense_summary', {'result': result})

    def query(self, focus='overview', system=None, start_date=None, end_date=None, department_ids=None):
        spend_view = _travel_spend_view(self.question)
        if spend_view:
            focus, system = spend_view, 'travel'
        if focus not in FOCUS_TITLES and focus not in {'unavailableBreakdown', 'unavailableTrend'}:
            raise ValueError('不支持的图表类型。')
        scope = self.scope()
        named = _named_departments(self.question, business_options())
        if named and department_ids is None:
            department_ids = named
        if named and not set(department_ids).issubset(named):
            raise ValueError('查询部门与问题中指定的部门不一致。')
        snapshot = query_board(system if system is not None else scope['system'],
                               start_date if start_date is not None else scope['startDate'],
                               end_date if end_date is not None else scope['endDate'],
                               department_ids if department_ids is not None else scope['departmentIds'])
        digest = hashlib.sha256(_encode([self.run_id, snapshot['scope'], focus]).encode()).hexdigest()[:32]
        result_id = 'board-result-' + digest
        if focus in {'unavailableBreakdown', 'unavailableTrend'}:
            self._save(result_id, 'scope', {'snapshot': {'scope': snapshot['scope']}})
            metric = next(m for m in snapshot['metrics'] if m['id'] == 'travelAmount')
            unavailable = ('台账未提供住宿、交通等费用的分类金额，无法按费用类型拆分。' if focus == 'unavailableBreakdown'
                           else '当前差旅看板按日期汇总行程次数，无法据此绘制费用走势。')
            return {'snapshot': {**snapshot, 'analysisLimitation': f"差旅费用合计 {metric['value']:,.2f} 元。{unavailable}"},
                    'cards': []}
        section = self._save(result_id, 'query', {'question': self.question, 'focus': focus, 'snapshot': snapshot})
        snapshot = section['snapshot']
        title = snapshot['title'] if focus == 'overview' else FOCUS_TITLES[focus]
        card = {'kind': 'analysis', 'id': result_id, 'title': title,
                'data': {'businessBoard': True, 'focus': focus, 'snapshot': snapshot}}
        return {'snapshot': snapshot, 'cards': [card]}

    def report(self, current_turn_only=False):
        if not current_turn_only:
            self.restore_previous_results()
        history = self.sections(current_turn_only)
        if not history:
            raise ValueError('请先查询需要纳入报告的数据。')
        csv_files = {s['snapshot']['sourceId'] for s in history if s.get('kind') == 'expenseCsv'}
        for ref in self.refs:
            if (not current_turn_only and ref.get('kind') == 'file'
                and str(ref.get('title', '')).lower().endswith('.csv') and ref['id'] not in csv_files):
                raise ValueError('请先汇总当前选择的 CSV 文件，再生成报告。')
        # Reopening the same view should not repeat an identical figure in the report.
        distinct = {(_encode(s['snapshot']), s.get('focus', s.get('kind'))): s for s in history}
        sections = list(distinct.values())
        if all('scope' in s['snapshot'] for s in sections):
            departments = {s['snapshot']['departmentLabel'] for s in sections}
            owner = next(iter(departments)) if len(departments) == 1 else '多部门'
            systems = {s['snapshot']['scope']['system'] for s in sections}
            subject = '费用与差旅' if len(systems) > 1 else ('差旅' if 'travel' in systems else '费用')
            title = f'{owner}{subject}分析报告'
        else:
            title = sections[0]['snapshot']['title'] + '报告' if len(sections) == 1 else '会话数据分析报告'
        result_id = 'business-report-' + self.run_id
        report = self._save(result_id, 'report', {'id': result_id, 'title': title,
                                                  'createdAt': now(), 'sections': sections})
        return {'report': report, 'cards': [{'id': result_id, 'kind': 'report', 'title': report['title'],
                'status': '已生成', 'data': {'businessReport': True, 'report': report}}]}


def get_board_report(store, report_id):
    with store.connect() as db:
        row = db.execute("SELECT body FROM business_board_results WHERE id=? AND kind='report'", (report_id,)).fetchone()
    if not row:
        raise BusinessError('BOARD_REPORT_NOT_FOUND', '分析报告不存在。')
    report = json.loads(row['body'])
    for section in report['sections']:
        _section_allowed(section)
    return report


_MONTHS = '一 二 三 四 五 六 七 八 九 十 十一 十二'.split()
_MONTH = re.compile(r'(?:(\d{4})年)?(1[0-2]|0?[1-9]|十一|十二|[一二三四五六七八九十])月(?:份)?')
_RANGE = re.compile(r'(\d{4}-\d{2}-\d{2})\s*(?:至|到|[~～—])\s*(\d{4}-\d{2}-\d{2})')
_REPORT = re.compile(r'(?:生成|保存|整理|制作|汇总成|出一份|做一份).*(?:报告|报表)|把.*(?:做成|整理成).*报告')
# This route supports finite data lookups. A non-vocabulary term, such as a city,
# a person or a comparison, leaves the entire question to the normal Agent.
_LOOKUP_WORDS = re.compile('|'.join(sorted((
    '想要', '想看一下', '看看', '看一下', '查询', '查一下', '看下', '查看', '看', '了解', '我想', '我', '我们',
    '可以', '请', '帮忙', '帮', '麻烦', '给', '那', '一下', '的话', '这个', '这次', '本次', '当前', '当期',
    '分析一下', '分析', '汇总', '统计', '数据', '智能', '可视化', '看板', '情况', '概况', '使用', '概览',
    '报销', '费用', '金额', '差旅', '出差', '费', '行程', '次数', '人次', '如何', '怎样', '怎么样', '多少',
    '谁', '哪位员工', '员工', '人员', '最多', '最高', '排行榜', '排行', '排名', '趋势', '走势', '类别',
    '类型', '构成', '占比', '结构', '目的地', '线路', '路线', '里面', '部门', '以及', '和', '与', '及',
    '跟', '的', '中', '里', '呢', '是', '有', '为', '把', '以', '按', '从', '到', '至', '切换', '改成',
    '切到', '换成', '改看', '换到', '换', '只看', '对话', '会话', '问答', '过程', '结果', '以上', '上述', '根据',
    '基于', '本轮', '整合', '最终', '全部', '所有', '授权', '已授权', '生成', '保存', '整理成', '整理', '制作',
    '汇总成', '出一份', '做成', '做一份', '一份', '一个', '报告', '报表', '并', '本月', '上月', '上个月', '这个月',
    '这段时间', '主要花在哪里', '主要花在哪', '这期间', '期间', '总额', '合计', '总共', '总计', '哪些', '支出', '花了', '花', '各', '怎么样', '比较多', '所属', '吗',
), key=len, reverse=True)))


def lookup_plan(store, task, refs, capability, question):
    """Recognize only fully understood board lookups; everything else uses Agno."""
    # A plain request from a result card compiles the confirmed history of this chat.
    # New uploads without a corresponding analysis must first be queried in the Agent.
    previous = next((c for m in reversed((task or {}).get('messages', [])) for c in reversed(m.get('cards', []))
                     if c.get('kind') in {'analysis', 'report'} or str(c.get('id', '')).startswith('expense-summary-')), {})
    previous_data = previous.get('data') or {}
    reportable = (previous_data.get('publicFinance') or previous_data.get('businessBoard') or
                  previous_data.get('businessReport') or str(previous.get('id', '')).startswith('expense-summary-'))
    simple = re.sub(r'[\s，。、！？?！,：:；;“”「」]+', '', question)
    specific_scope = bool(_MONTH.search(simple) or _RANGE.search(simple) or any(label in simple for label in DEPARTMENTS.values())
                          or re.search(r'只看|仅看|只要|只包含|仅包含|本月|上月|上个月|这个月|所有部门|全部部门', simple))
    if (capability in {None, 'analysis'} and _REPORT.search(simple) and not specific_scope
        and not _LOOKUP_WORDS.sub('', simple)):
        if not reportable and task:
            with store.connect() as db:
                reportable = db.execute("""SELECT 1 FROM business_board_results b JOIN runs r ON r.id=b.run_id
                                           WHERE r.task_id=? AND b.kind IN ('query','publicFinance','expenseCsv') LIMIT 1""",
                                        (task['id'],)).fetchone()
        if reportable:
            return {'queries': [], 'report': True}
    if capability not in {None, 'analysis'} or any(
        r.get('kind') != 'business-board' and not (r.get('kind') == 'report' and str(r.get('id', '')).startswith('business-report-'))
        for r in refs
    ):
        return None
    last_card = next((c for m in reversed((task or {}).get('messages', [])) for c in reversed(m.get('cards', []))
                      if c.get('kind') in {'analysis', 'report'}), None)
    last_data = (last_card or {}).get('data') or {}
    has_context = bool(last_data.get('businessBoard') or last_data.get('businessReport')) if last_card else bool(refs)
    if not has_context and not re.search(r'(?:费用|报销|差旅|出差|行程)(?:情况|费|数据|使用|分析|概览|趋势|最多|最高|排行|金额|总额|支出|结构|构成|目的地|主要花在哪)|部门.*(?:费用|报销|出差|差旅)', question):
        return None
    text = re.sub(r'[\s，。、！？?！,：:；;“”「」]+', '', question)
    dates = {}
    matched_range = _RANGE.search(text)
    months = list(_MONTH.finditer(text))
    if matched_range:
        dates = dict(start_date=matched_range[1], end_date=matched_range[2])
        text = _RANGE.sub('', text, count=1)
    elif len(months) > 1:
        return None
    elif months:
        matched = months[0]
        month = int(matched[2]) if matched[2].isdigit() else _MONTHS.index(matched[2]) + 1
        text = text[:matched.start()] + text[matched.end():]
    options = business_options()
    selected = _named_departments(question, options)
    for department in options['departments']:
        if department['name'] in text:
            text = text.replace(department['name'], '')
    all_depts = bool(re.search(r'(?:已授权|授权|全部|所有)部门', text))
    if _LOOKUP_WORDS.sub('', text):
        return None
    context = BoardConversation(store, (task or {}).get('id', ''), refs)
    scope = context.scope()
    if not dates and months:
        year = int(matched[1] or scope['endDate'][:4])
        dates = dict(start_date=date(year, month, 1).isoformat(),
                     end_date=date(year, month, calendar.monthrange(year, month)[1]).isoformat())
    elif not dates and re.search(r'本月|上月|上个月|这个月', text):
        # The demo calendar is the same dated snapshot as the dashboard.
        end = date.fromisoformat(options['defaultScope']['endDate'])
        if '上月' in text or '上个月' in text:
            end = end.replace(day=1) - timedelta(days=1)
        dates = dict(start_date=end.replace(day=1).isoformat(), end_date=end.isoformat())
    if all_depts:
        selected = [d['id'] for d in options['departments']]
    has_travel = bool(re.search(r'出差|差旅|行程', question))
    has_expense = bool(re.search(r'报销|(?<!差旅)(?<!出差)费用', question))
    report = bool(_REPORT.search(question))
    ranking = bool(re.search(r'排行|排名|谁|哪位员工', question))
    focus = ('ranking' if ranking else 'trend' if re.search(r'走势|趋势', question) else
             'breakdown' if re.search(r'构成|结构|占比|类别|类型|主要花在哪', question) else
             'travel' if re.search(r'路线|线路|目的地', question) else 'overview')
    focus = _travel_spend_view(question) or focus
    if focus == 'ranking' and (re.search(r'次数|行程|人次', question) or
                    (has_travel and not re.search(r'费|金额|花', question)) or
                    (not has_travel and (has_expense or not has_context))):
        return None
    if report and has_context and not (selected or dates or specific_scope):
        return {'queries': [] if context.sections() else [{'focus': 'overview'}], 'report': True}
    systems = ['expense', 'travel'] if has_expense and has_travel and not ranking else [
        'travel' if has_travel else 'expense' if has_expense else scope['system']]
    return {'queries': [dict(focus=focus, system=system, **dates, **({'department_ids': selected} if selected else {}))
                        for system in systems], 'report': report}


def result_sentence(snapshot, focus):
    if snapshot.get('coverageStatus') == 'outside':
        period = snapshot['coverage']
        return f"所选日期超出台账覆盖期（{period['startDate']} 至 {period['endDate']}）。"
    coverage_note = '仅统计台账覆盖期内的数据。' if snapshot.get('coverageStatus') == 'partial' else ''
    if not snapshot['recordCount']:
        return f"{snapshot['departmentLabel']}在所选日期范围内没有{snapshot['title'].removesuffix('看板')}记录。" + coverage_note
    if snapshot.get('analysisLimitation'):
        return snapshot['analysisLimitation'] + coverage_note
    if focus == 'routeSpend' and snapshot['routes']:
        amount = max(r['amount'] for r in snapshot['routes'])
        names = '、'.join(r['name'] for r in snapshot['routes'] if r['amount'] == amount)
        return f"差旅费用最高的线路为{names}，金额 {amount:,.2f} 元。" + coverage_note
    if focus == 'ranking' and snapshot['ranking']:
        top_amount = snapshot['ranking'][0]['amount']
        names = '、'.join(r['name'] for r in snapshot['ranking'] if r['amount'] == top_amount)
        return f"{names}的差旅费用最高，为 {top_amount:,.2f} 元。" + coverage_note
    if focus == 'travel' and snapshot['routes']:
        first = snapshot['routes'][0]
        return f"出差次数最多的线路为{first['name']}，共 {first['trips']} 次。" + coverage_note
    if focus == 'breakdown' and snapshot['breakdown']:
        top = snapshot['breakdown'][0]
        value = f"{top['value']:,.2f} 元" if snapshot['scope']['system'] == 'expense' else f"{top['value']} 次"
        return f"{top['name']}占比最高，合计 {value}。" + coverage_note
    metrics = snapshot['metrics']
    selected = metrics[:2] if focus == 'overview' else []
    if not selected:
        return f"已按所选范围汇总{FOCUS_TITLES[focus]}。" + coverage_note
    return '，'.join(f"{m['label']} {m['value']:,.2f} 元" if m['unit'] == '元' else
                    f"{m['label']} {m['value']:,} {m['unit']}" for m in selected) + '。' + coverage_note
