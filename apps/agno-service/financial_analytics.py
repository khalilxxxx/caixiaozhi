"""海康威视法定年度合并财报，原始 PDF 校验、分币计算与独立报告快照。"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import zlib
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

from pypdf import PdfReader
from pypdf.errors import PdfReadError


ENTITY = '杭州海康威视数字技术股份有限公司'
SNAPSHOT_PATH = Path(__file__).with_name('data') / 'hikvision-2025-annual.json'
PERIODS = {year: (f'{year}-01-01', f'{year}-12-31') for year in (2023, 2024, 2025)}
DOCUMENTS = {
    2025: {'id': 'hikvision-2025', 'label': '海康威视 2025年年度报告',
           'url': 'https://static.cninfo.com.cn/finalpage/2026-04-18/1225123062.PDF',
           'accession': '1225123062', 'filedAt': '2026-04-18',
           'sha256': 'a805779efb81bea8158e119ad7c733c4669b8d492dc03c7613199970bfa4b8b2',
           'pages': {'income': 151, 'cashFlow': 153}},
    2024: {'id': 'hikvision-2024', 'label': '海康威视 2024年年度报告',
           'url': 'https://static.cninfo.com.cn/finalpage/2025-04-19/1223153152.PDF',
           'accession': '1223153152', 'filedAt': '2025-04-19',
           'sha256': 'f1a8771d81d6ed723c4d1a7d552400cf408cca4752033f5bbd0f88ae2729757b',
           'pages': {'income': 161, 'cashFlow': 163}},
}
SOURCE_URL = DOCUMENTS[2025]['url']
FILING_URL = SOURCE_URL
METRICS = {
    'revenue': ('营业收入', '营业收入'),
    'costOfRevenue': ('营业成本', '营业成本'),
    'researchAndDevelopment': ('研发费用', '研发费用'),
    'sellingGeneralAndAdministrative': ('销售及管理费用', '销售费用 + 管理费用'),
    'operatingIncome': ('营业利润', '营业利润'),
    'netIncome': ('合并净利润', '净利润'),
    'attributableNetIncome': ('归母净利润', '归属于母公司所有者的净利润'),
    'operatingCashFlow': ('经营活动现金流净额', '经营活动产生的现金流量净额'),
}
INCOME_ROWS = {
    'revenue': '一、营业收入', 'costOfRevenue': '减：营业成本',
    'taxesAndSurcharges': '税金及附加', 'sellingExpenses': '销售费用',
    'administrativeExpenses': '管理费用', 'researchAndDevelopment': '研发费用',
    'financialExpenses': '财务费用', 'otherIncome': '加：其他收益',
    'investmentIncome': '投资收益', 'fairValueChanges': '公允价值变动收益',
    'creditImpairment': '信用减值利得', 'assetImpairment': '资产减值利得',
    'assetDisposalIncome': '资产处置收益', 'operatingIncome': '二、营业利润',
    'nonOperatingIncome': '加：营业外收入', 'nonOperatingExpenses': '减：营业外支出',
    'profitBeforeTax': '三、利润总额', 'incomeTaxExpense': '减：所得税费用',
    'netIncome': '四、净利润', 'attributableNetIncome': '1.归属于母公司所有者的净利润',
    'minorityInterest': '2.少数股东损益',
}
CASH_ROWS = {
    'operatingCashFlow': '经营活动产生的现金流量净额',
    'operatingCashInflows': '经营活动现金流入小计',
    'operatingCashOutflows': '经营活动现金流出小计',
}
AMOUNT_PATTERN = re.compile(r'(?<![\d,.])\(?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?!\d)')


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def extract_report_pages(raw, year):
    """只读取固定合并报表物理页，保留完整页面文本供结构与金额校验。"""
    try:
        reader = PdfReader(io.BytesIO(raw), strict=True)
        return {section: reader.pages[page - 1].extract_text(extraction_mode='layout')
                for section, page in DOCUMENTS[year]['pages'].items()}
    except (PdfReadError, OSError, TypeError, ValueError, IndexError, KeyError) as error:
        raise ValueError('公开财报 PDF 页面校验失败。') from error


def _row_amounts(text, label):
    compact_label = re.sub(r'\s+', '', label)
    lines = [line for line in text.splitlines()
             if re.sub(r'\s+', '', line).startswith(compact_label)]
    if len(lines) != 1:
        raise ValueError(f'合并报表{label}缺少唯一行，校验失败。')
    tokens = AMOUNT_PATTERN.findall(lines[0])
    if len(tokens) != 2:
        raise ValueError(f'合并报表{label}的两个年度金额校验失败。')
    # Decimal 仅负责文本转分，后续金额运算全部使用整数分。
    return [int(Decimal(token.strip('()').replace(',', '')) * 100) * (-1 if token.startswith('(') else 1)
            for token in tokens]


def _reconcile(values, year):
    expenses = sum(values[key] for key in ('costOfRevenue', 'taxesAndSurcharges', 'sellingExpenses',
                                         'administrativeExpenses', 'researchAndDevelopment', 'financialExpenses'))
    gains = sum(values[key] for key in ('otherIncome', 'investmentIncome', 'fairValueChanges',
                                      'creditImpairment', 'assetImpairment', 'assetDisposalIncome'))
    checks = (
        values['revenue'] - expenses + gains == values['operatingIncome'],
        values['operatingIncome'] + values['nonOperatingIncome'] - values['nonOperatingExpenses'] == values['profitBeforeTax'],
        values['profitBeforeTax'] - values['incomeTaxExpense'] == values['netIncome'],
        values['attributableNetIncome'] + values['minorityInterest'] == values['netIncome'],
        values['operatingCashInflows'] - values['operatingCashOutflows'] == values['operatingCashFlow'],
    )
    if not all(checks):
        raise ValueError(f'{year} 年合并报表勾稽校验失败。')


def parse_report_pages(pages, year):
    """将两列法定合并报表解析为整数分，并执行完整利润与现金流勾稽。"""
    try:
        for section, title in (('income', '合并利润表'), ('cashFlow', '合并现金流量表')):
            compact = re.sub(r'\s+', '', pages[section])
            if title not in compact or ENTITY not in compact or '单位：人民币元' not in compact or f'{year}年12月31日止年度' not in compact:
                raise ValueError('合并年度报表主体、年度、标题或币种校验失败。')
            if '母公司利润表' in compact or '母公司现金流量表' in compact:
                raise ValueError('合并报表页面混入母公司报表，校验失败。')
            if year == 2024 and '上年发生额(已重述)' not in compact:
                raise ValueError('2023 年已重述比较列校验失败。')
        columns = {key: _row_amounts(pages['income'], label) for key, label in INCOME_ROWS.items()}
        columns.update({key: _row_amounts(pages['cashFlow'], label) for key, label in CASH_ROWS.items()})
        records = {}
        for index, period_year in enumerate((year, year - 1)):
            values = {key: amounts[index] for key, amounts in columns.items()}
            values['sellingGeneralAndAdministrative'] = values['sellingExpenses'] + values['administrativeExpenses']
            _reconcile(values, period_year)
            records[period_year] = values
        return records
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError('合并报表页面结构校验失败。') from error


def _sources(year, document_year):
    document = DOCUMENTS[document_year]
    return {key: [{'year': year, 'documentId': document['id'],
                   'page': document['pages']['cashFlow' if key in CASH_ROWS else 'income'],
                   'section': '合并现金流量表' if key in CASH_ROWS else '合并利润表',
                   'restated': year == 2023}]
            for key in (*INCOME_ROWS, *CASH_ROWS, 'sellingGeneralAndAdministrative')}


def normalize_reports(payloads, retrieved_at):
    """从固定两份官方 PDF 生成快照，业务版本与获取时间无关。"""
    parsed = {}
    documents = []
    try:
        for year, definition in DOCUMENTS.items():
            raw = payloads[definition['id']]
            digest = hashlib.sha256(raw).hexdigest()
            if digest != definition['sha256']:
                raise ValueError(f'{year} 年官方 PDF SHA-256 校验失败，请核对固定披露原件。')
            parsed[year] = parse_report_pages(extract_report_pages(raw, year), year)
            documents.append({**definition, 'rawFile': f"cninfo-hikvision-{year}-{digest}.pdf.gz"})
        if parsed[2025][2024] != parsed[2024][2024]:
            raise ValueError('两份年报的 2024 年合并报表比较值不一致，校验失败。')
        records = []
        for year, (start, end) in PERIODS.items():
            document_year = 2024 if year == 2023 else 2025
            values = parsed[document_year][year]
            records.append({'year': year, 'periodStart': start, 'periodEnd': end,
                            'restated': year == 2023, 'values': {key: value / 100 for key, value in values.items()},
                            'valuesMinor': {key: str(value) for key, value in values.items()},
                            'sources': _sources(year, document_year)})
    except (KeyError, TypeError) as error:
        raise ValueError('官方年报原始快照结构校验失败。') from error
    selected = {'schemaVersion': 2, 'entity': ENTITY, 'currency': 'CNY',
                'documents': documents, 'records': records,
                'formulas': {'sellingGeneralAndAdministrative': 'sellingExpenses + administrativeExpenses',
                             'totalCosts': 'costOfRevenue + researchAndDevelopment + sellingGeneralAndAdministrative'}}
    version = 'sha256-' + hashlib.sha256(_canonical(selected)).hexdigest()
    primary = DOCUMENTS[2025]
    return {'dataset': {'id': 'cninfo-hikvision-2025', 'version': version,
                        'label': '海康威视 2023—2025年度合并财报', 'shortName': '海康威视', 'entity': ENTITY,
                        'currency': 'CNY', 'displayUnit': '亿元', 'periodLabel': '年度', 'years': list(PERIODS),
                        'source': {'provider': '巨潮资讯·深交所法定披露', 'url': SOURCE_URL,
                                   'filingUrl': SOURCE_URL, 'accession': primary['accession'],
                                   'filedAt': primary['filedAt'], 'retrievedAt': retrieved_at,
                                   'sha256': primary['sha256'], 'documents': documents}},
            'records': records}


def _load_snapshot():
    try:
        manifest = json.loads(SNAPSHOT_PATH.read_text(encoding='utf-8'))
        documents = manifest['dataset']['source']['documents']
        payloads = {}
        for document in documents:
            raw_name = document['rawFile']
            if not isinstance(raw_name, str) or Path(raw_name).name != raw_name:
                raise ValueError('公开财报原始快照路径校验失败。')
            raw = gzip.decompress((SNAPSHOT_PATH.parent / raw_name).read_bytes())
            if hashlib.sha256(raw).hexdigest() != document['sha256']:
                raise ValueError('公开财报原始快照 SHA-256 校验失败，请重新获取官方数据。')
            payloads[document['id']] = raw
        normalized = normalize_reports(payloads, manifest['dataset']['source']['retrievedAt'])
        if normalized != manifest:
            raise ValueError('公开财报归一化数据校验失败，请重新获取官方数据。')
        return normalized
    except FileNotFoundError as error:
        raise ValueError('公开财报数据快照缺失，请重新获取官方数据。') from error
    except (OSError, EOFError, UnicodeError, KeyError, TypeError, json.JSONDecodeError, zlib.error) as error:
        raise ValueError('公开财报数据快照校验失败，请重新获取官方数据。') from error


def _percentage(numerator, denominator):
    return numerator / denominator * 100 if denominator else None


def _totals(values):
    expenses = values['researchAndDevelopment'] + values['sellingGeneralAndAdministrative']
    total_costs = values['costOfRevenue'] + expenses
    return {**{key: value / 100 for key, value in values.items()},
            'operatingExpenses': expenses / 100, 'totalCosts': total_costs / 100,
            'grossProfit': (values['revenue'] - values['costOfRevenue']) / 100,
            'otherOperatingNet': (values['operatingIncome'] - (values['revenue'] - total_costs)) / 100,
            'operatingMargin': _percentage(values['operatingIncome'], values['revenue']),
            'netMargin': _percentage(values['netIncome'], values['revenue']),
            'minorityProfitShare': _percentage(values['minorityInterest'], values['netIncome'])}


def query_financials(year=2025, metric=None):
    if type(year) is not int or year not in PERIODS:
        raise ValueError('公开财报支持海康威视 2023、2024、2025 年度，请使用整数年度。')
    if metric not in (None, '', 'all') and (not isinstance(metric, str) or metric not in METRICS):
        raise ValueError('财务指标无效，请选择营业收入、营业成本、研发费用、销售及管理费用、营业利润、合并净利润、归母净利润或经营活动现金流净额。')
    snapshot = _load_snapshot()
    records = {record['year']: record for record in snapshot['records']}
    current = records[year]
    previous = records.get(year - 1)
    values = {key: int(value) for key, value in current['valuesMinor'].items()}
    metrics = []
    for metric_id, (label, concept) in METRICS.items():
        if metric not in (None, '', 'all', metric_id):
            continue
        value = values[metric_id]
        base = int(previous['valuesMinor'][metric_id]) if previous else None
        item = {'id': metric_id, 'label': label, 'value': value / 100,
                'previousValue': base / 100 if base is not None else None,
                'valueMinor': str(value), 'previousValueMinor': str(base) if base is not None else None,
                'yoy': _percentage(value - base, base) if base is not None else None,
                'concept': 'cas:' + concept, 'unit': 'CNY',
                'sources': current['sources'][metric_id] + (previous['sources'][metric_id] if previous else [])}
        if metric_id == 'sellingGeneralAndAdministrative':
            item['formula'] = 'sellingExpenses + administrativeExpenses'
        metrics.append(item)
    totals = _totals(values)
    findings = [
        {'title': '收入与利润', 'text': f"{year} 年营业收入 {totals['revenue'] / 100000000:,.2f} 亿元，营业利润 {totals['operatingIncome'] / 100000000:,.2f} 亿元，合并净利润 {totals['netIncome'] / 100000000:,.2f} 亿元，归母净利润 {totals['attributableNetIncome'] / 100000000:,.2f} 亿元。"},
        {'title': '毛利与费用构成', 'text': f"毛利 {totals['grossProfit'] / 100000000:,.2f} 亿元，毛利率 {_percentage(totals['grossProfit'], totals['revenue']):.2f}%。营业成本、研发费用、销售及管理费用三项合计 {totals['totalCosts'] / 100000000:,.2f} 亿元，占营业收入 {_percentage(totals['totalCosts'], totals['revenue']):.2f}%。"},
        {'title': '经营活动现金流', 'text': f"经营活动现金流净额 {totals['operatingCashFlow'] / 100000000:,.2f} 亿元。"},
    ]
    if previous:
        prior = {key: int(value) for key, value in previous['valuesMinor'].items()}
        revenue_change = _percentage(values['revenue'] - prior['revenue'], prior['revenue'])
        profit_change = _percentage(values['netIncome'] - prior['netIncome'], prior['netIncome'])
        revenue_description = '，收入几乎持平' if abs(revenue_change) < 0.1 else ''
        findings.append({'title': '同口径年度比较', 'text': f'营业收入较 {year - 1} 年变动 {revenue_change:+.2f}%{revenue_description}，合并净利润变动 {profit_change:+.2f}%。2023 年比较数采用 2024 年报已重述口径。'})
        prior_share = _percentage(prior['minorityInterest'], prior['netIncome'])
        share = totals['minorityProfitShare']
        growth = _percentage(values['minorityInterest'] - prior['minorityInterest'], prior['minorityInterest'])
        if prior_share is not None and share is not None:
            delta = share - prior_share
            change = '持平' if abs(delta) < 0.005 else f"{'上升' if delta > 0 else '下降'} {abs(delta):.2f} 个百分点"
            amount = f'金额同比变动 {growth:+.2f}%，' if growth is not None else ''
            findings.append({'title': '少数股东损益', 'text': f'{amount}占合并净利润的比例由 {year - 1} 年的 {prior_share:.2f}% 变为 {year} 年的 {share:.2f}%，{change}。'})
    else:
        findings.append({'title': '年度比较范围', 'text': '本数据集从 2023 年开始，缺少 2022 年基期，2023 年同比不计算。'})
    result = {
        'dataset': snapshot['dataset'], 'year': year,
        'period': {'start': current['periodStart'], 'end': current['periodEnd'],
                   'label': f'{year} 年度（已重述）' if current['restated'] else f'{year} 年度'},
        'metrics': metrics, 'totals': totals,
        'trend': [{'year': record['year'], 'periodStart': record['periodStart'], 'periodEnd': record['periodEnd'],
                   **_totals({key: int(value) for key, value in record['valuesMinor'].items()}),
                   'valuesMinor': record['valuesMinor'], 'restated': record['restated'], 'sources': record['sources']}
                  for record in snapshot['records']],
        'findings': findings,
        'limitations': [
            '统计范围为杭州海康威视数字技术股份有限公司合并年度财务报表，金额单位为人民币元，展示单位为亿元，年度为自然年。',
            '2025、2024 年取自 2025 年报合并利润表及合并现金流量表，PDF 物理页 151、153。2023 年取自 2024 年报已重述比较列，PDF 物理页 161、163。两份年报共同披露的 2024 年全部提取指标已逐项核对一致。',
            '2023 年已重述比较数反映同一控制下合并赋睿科技及《企业会计准则解释第18号》调整。2023 年保证类质保费用 95,712,702.24 元由销售费用转入营业成本。相关披露见 2024 年报 PDF 物理页 9、199、241—242。',
            '净利润采用合并净利润，归母净利润单独列示。销售及管理费用由销售费用与管理费用相加，营业费用采用研发费用与销售及管理费用之和。三项成本费用合计采用营业成本、研发费用、销售及管理费用之和。',
            '营业利润按合并利润表完整公式勾稽，含税金及附加、财务费用、其他收益、投资收益、公允价值变动、信用及资产减值、资产处置等。其他营业净额为营业利润减去营业收入扣除三项成本费用后的余额。财务费用括号金额按负数处理。',
            '同比以上一年同指标为分母，利润率以同期营业收入为分母。缺少 2022 年数据，2023 年同比不计算。',
            '金额变动的业务原因需结合年报附注与管理层讨论核实。数据覆盖上述年度合并指标，部门、月度及企业报销数据需另行接入。',
        ],
    }
    result['cards'] = [{'kind': 'analysis', 'title': f'海康威视 {year} 年度分析', 'status': '已查询',
                        'data': {'publicFinance': True, 'year': year, 'datasetId': snapshot['dataset']['id'],
                                 'datasetVersion': snapshot['dataset']['version'], 'snapshot': dict(result)}}]
    return result


def create_report(store, year=2025, dataset_id=None, dataset_version=None):
    snapshot = query_financials(year)
    if ((dataset_id is not None and dataset_id != snapshot['dataset']['id'])
            or (dataset_version is not None and dataset_version != snapshot['dataset']['version'])):
        raise ValueError('财报来源或版本已变更，请重新查询后生成报告。')
    snapshot.pop('cards')
    report = {'id': 'public-report-' + uuid4().hex, 'title': f'海康威视{year}年度财务分析报告',
              'createdAt': datetime.now(timezone.utc).isoformat(), 'version': 1, 'snapshot': snapshot}

    def save(state):
        state.setdefault('data', {}).setdefault('publicFinancialReports', {})[report['id']] = report
        return {'report': report, 'cards': [{'kind': 'report', 'id': report['id'], 'title': report['title'],
                                            'status': '已保存', 'data': {'publicFinance': True, 'year': year,
                                            'datasetId': snapshot['dataset']['id'], 'datasetVersion': snapshot['dataset']['version']}}]}

    return store.mutate(save)


def get_report(store, report_id):
    report = store.get_state().get('data', {}).get('publicFinancialReports', {}).get(report_id)
    if report is None:
        raise ValueError('公开财报报告不存在。')
    return report


def list_reports(store):
    reports = store.get_state().get('data', {}).get('publicFinancialReports', {}).values()
    return [{'id': report['id'], 'title': report['title'], 'createdAt': report['createdAt'],
             'year': report['snapshot']['year'], 'version': report['version'],
             'datasetVersion': report['snapshot']['dataset']['version'],
             'entity': report['snapshot']['dataset'].get('entity'),
             'shortName': report['snapshot']['dataset'].get('shortName', report['snapshot']['dataset'].get('entity')),
             'currency': report['snapshot']['dataset'].get('currency'),
             'sourceLabel': report['snapshot']['dataset'].get('source', {}).get('provider')}
            for report in sorted(reports, key=lambda report: (report['createdAt'], report['id']), reverse=True)]
