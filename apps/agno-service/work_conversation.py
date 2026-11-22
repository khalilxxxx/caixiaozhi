"""工作台待办与报销办理方向。只处理能明确判断的业务意图。"""
import re


def inbox_scope(message):
    text = re.split(r'而是|我说的是|我指的是|改查|换成', message.strip())[-1].strip()
    # A request to perform a review/decision must continue through the action flow.
    if re.search(r'执行|预审|同意|驳回|帮我审批|帮我审核|提交审批|生成|导出|报告|'
                 r'(?:把|将|帮我|直接|批量).{0,25}退回|退回(?:(?:等我|待我)(?:审批|审核)|这[笔张些]|那[笔张些]|全部|所有)', message):
        return None
    if re.search(r'(?:等|待|需要|轮到)(?:我|本人)(?:来)?(?:审批|审核|批复)|我(?:要|需要)审批的', text):
        return 'approvals'
    if re.search(r'(?:退回|打回).{0,9}(?:待我|等我|要我|补件|补材料)|(?:待我|等我|需要我)(?:补件|补充|补材料)|待我处理的单据|我(?:需要|要)补(?:件|材料)', text):
        return 'returned'
    if re.fullmatch(r'(?:请|帮我|查一下|查看|看看|列出|请问|今天|今日|我|本人|的|现在|目前|有|哪些|什么|待办|事项|工作|任务|单据|[？?。！!\s])+', text) and '待办' in text:
        return 'both'
    return None


def reimbursement_choice(message, context):
    """For an answered fork, the server-persisted option contains the original place."""
    question = (context or {}).get('question', {})
    options = [item['id'] for item in question.get('options', [])]
    if len(options) == 2 and options[0].startswith('expense-lookup:'):
        place = options[0].partition(':')[2]
        if options == expense_option_ids(place):
            answer = question.get('answer') or {}
            choice = answer.get('optionIds') or []
            if choice == [options[0]]:
                return 'lookup', place
            if choice == [options[1]]:
                return 'create', place
            reply = answer.get('text', '').strip().rstrip('。！!')
            if re.fullmatch(r'(?:先|请)?(?:查|看|查询|查看)(?:一下|看)?(?:已有|原)?(?:报销单|单据|原单|进度|进展)', reply):
                return 'lookup', place
            if re.fullmatch(r'(?:请|帮我|我要)?(?:新建|新开|另建|新办)(?:一份|一张)?(?:差旅)?(?:报销单|报销)?', reply):
                return 'create', place
            if reply in ('不知道', '不确定', '没想好'):
                return 'choose', place
    if context:
        return None
    match = re.fullmatch(r'([\u3400-\u9fff]{0,7}?)(?:的)?(?:差旅|出差)报销(?:单)?[？?。]?', message.strip())
    if not match:
        return None
    place = match[1]
    if re.search(r'填|帮|查|看|要|我|申请|新增|新建|办|提交|统计|分析|审批|取消|能否|能不能|怎么|如何|关联|准备|发起|审核|整理|生成|导出|比较', place):
        return None
    return 'choose', place


def expense_option_ids(place):
    return [f'expense-lookup:{place}', f'expense-create:{place}']


def local_work_action(message, capability, context):
    context = context or {}
    question = context.get('question') or {}
    if context.get('mode') == 'policy_lookup':
        return None
    if (context.get('mode') == 'selection' and question.get('sourceDraftId')
            and question.get('answer', {}).get('optionIds') == ['view_existing']):
        return 'original', question.get('sourceDocumentId')
    if scope := inbox_scope(message):
        return 'inbox', scope
    if capability in (None, 'chat', 'documents'):
        return reimbursement_choice(message, context)


def returned_document_reply(title, document_id, reason, source, actors):
    parts = [f"{title}（{document_id}）已退回。"]
    if actors:
        parts.append(f"当前责任人是{'、'.join(actors)}。")
    if reason:
        parts.append(f"退回意见为“{reason.rstrip('。')}”。")
    parts.append(f"请到{source or '来源业务系统'}打开原单 {document_id} 补件。")
    return ''.join(parts)


def inbox_reply(result, scope):
    parts = []
    if scope in ('both', 'approvals'):
        items = result['approvals']
        counts = result['reviewCounts']
        parts.append(f"待我审批 {len(items)} 张（审批席位{result['approverName']}，{counts['attention']} 张需关注、{counts['unknown']} 张待核实、{counts['clear']} 张未发现异常）。")
        if scope == 'approvals':
            for item in items[:2]:
                parts.append(f"{item['title']}（{item['id']}）：{item['reason'].rstrip('。')}。")
    if scope in ('both', 'returned'):
        items = result['returned']
        employee = result.get('employeeName')
        label = f'（申请人{employee}）' if employee else ''
        parts.append(f"退回待我补件 {len(items)} 张{label}。")
        if items:
            item = items[0]
            parts.append(returned_document_reply(item['title'], item['id'], item['reason'], item['sourceLabel'], item['actors']))
    if result['unavailableSources']:
        parts.append('部分来源暂不可用，以上仅统计已读取的单据。')
    return '\n'.join(parts)


def progress_reply(result):
    if result.get('error'):
        raise ValueError(result['error'])
    if not result['items']:
        return ('部分来源暂不可用，已读取的范围内没有找到匹配的报销单。' if result['unavailableSources']
                else '当前个人单据中没有找到匹配的差旅报销。')
    doc = result['items'][0]
    status = doc.get('sourceStatus') or doc['status']
    if len(result['items']) > 1:
        return f"找到 {len(result['items'])} 张匹配的差旅报销，可打开对应单据查看进展。"
    reason = next((field['value'] for field in doc.get('details', []) if field['label'] == '退回原因'), '')
    current = doc.get('current') or {}
    actors = current.get('actors') or []
    if doc.get('status') == 'needs_action':
        if reason or '退回' in status or any(step.get('status') == 'returned' for step in doc.get('steps', [])):
            return returned_document_reply(doc['title'], doc['id'], reason, doc['source']['label'], actors)
        owner = f"当前责任人是{'、'.join(actors)}。" if actors else ''
        return f"{doc['title']}（{doc['id']}）{status}。{owner}请到{doc['source']['label']}按原单提示办理。"
    owner = f"，当前处理人为{'、'.join(actors)}" if actors else ''
    return f"{doc['title']}（{doc['id']}）{status}{owner}。"
