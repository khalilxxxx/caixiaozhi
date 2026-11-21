"""Business facts safe to persist alongside a completed tool event."""
import re
from decimal import Decimal


def _count(value):
    return type(value) is int and value >= 0


def tool_finding(name, result):
    """Only known result shapes contribute facts. Never copy arbitrary tool text."""
    if not isinstance(result, dict) or result.get('error'):
        return None

    if name in ('query_documents', 'list_reimbursable_travel_applications'):
        items = result.get('items')
        missing = result.get('unavailableSources', [])
        if isinstance(items, list) and isinstance(missing, list):
            subject = '张单据' if name == 'query_documents' else '张可报销差旅申请'
            count = f'查到 {len(items)} {subject}'
            return f'可用来源中{count}，另有 {len(missing)} 个来源未返回。' if missing else f'{count}。'

    if name == 'search_policies' and isinstance(result.get('items'), list):
        return f"检索到 {len(result['items'])} 份本地示例制度。"
    if name == 'read_current_rules' and isinstance(result.get('rules'), list):
        return f"当前规则清单中有 {len(result['rules'])} 条规则。"
    if name == 'read_work_document' and isinstance(result.get('document'), dict):
        document = result['document']
        expenses, files = document.get('expenses'), document.get('files')
        if isinstance(expenses, list) and isinstance(files, list):
            return f'这张单据有 {len(expenses)} 条费用明细、{len(files)} 份附件。'
    if name == 'analyze_expenses' and isinstance(result.get('items'), list):
        count, total = result.get('count'), result.get('totalMinor')
        if (_count(count) and count == len(result['items']) and
                isinstance(total, str) and re.fullmatch(r'-?[0-9]{1,24}', total)):
            return f'本地合成样例中，{count} 条费用汇总记录合计 {Decimal(total).scaleb(-2):.2f} 元。'
    if name == 'list_materials' and isinstance(result.get('files'), list):
        return f"已列出 {len(result['files'])} 份材料。"
    if name == 'extract_expense_materials':
        groups, unassigned = result.get('groupCount'), result.get('unassignedCount')
        if _count(groups) and _count(unassigned):
            remainder = f'，另有 {unassigned} 份材料待归组' if unassigned else ''
            return f'识别出 {groups} 组费用{remainder}。'
        files, items = result.get('files'), result.get('items')
        if isinstance(files, list) and isinstance(items, list):
            return f'本次 {len(files)} 份材料中有 {len(items)} 条费用记录。'
    if name in ('summarize_expense_csv', 'read_expense_summary'):
        summary = result.get('result')
        if isinstance(summary, dict) and _count(summary.get('rowCount')) and summary.get('currency') == 'CNY':
            amount = summary.get('total')
            if isinstance(amount, str) and re.fullmatch(r'-?[0-9]{1,24}\.[0-9]{2}', amount):
                return f"{summary['rowCount']} 条费用记录合计 {amount} 元。"
    if name in ('get_submission_draft', 'update_submission_draft', 'link_travel_application'):
        draft = result.get('draft')
        if isinstance(draft, dict):
            kind = draft.get('type') or draft.get('id')
            if kind == 'travel' and isinstance(draft.get('legs'), list):
                return f"差旅申请中已有 {len(draft['legs'])} 段行程。"
            if kind in ('personal', 'expense') and isinstance(draft.get('expenses'), list):
                return f"报销单中已有 {len(draft['expenses'])} 条费用明细。"
    if name == 'validate_submission' and isinstance(result.get('check'), dict):
        issues = result['check'].get('issues')
        if isinstance(issues, list):
            if issues:
                return f'草稿有 {len(issues)} 项字段需要核对。'
            if result.get('canSubmit') is True:
                return '草稿已通过提交校验，等待确认。'
    if name == 'preaudit_documents' and isinstance(result.get('items'), list):
        counts = result.get('counts')
        if isinstance(counts, dict) and all(_count(counts.get(key)) for key in ('attention', 'unknown', 'clear')):
            return (f"已预审 {len(result['items'])} 张单据，"
                    f"{counts['attention']} 张需关注，{counts['unknown']} 张待核实。")
    return None
