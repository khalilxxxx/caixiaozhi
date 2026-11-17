"""本地每日预审复用确定性及语义规则；不发送外部消息。"""
from datetime import datetime
from zoneinfo import ZoneInfo
import re
import uuid


def tick(store, business, current=None):
    current = current or datetime.now(ZoneInfo('Asia/Shanghai'))
    settings = store.get_state()['data'].get('rulesSubmission', {}).get('schedule', {})
    at = str(settings.get('time', ''))
    if not settings.get('enabled') or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', at):
        return False
    today = current.date().isoformat()
    if current.strftime('%H:%M') < at or settings.get('lastRunDate') == today:
        return False
    result = business.preaudit()
    def complete(state):
        rules = state['data'].get('rulesSubmission', {})
        rules.setdefault('schedule', {}).update(lastRunDate=today, lastRunAt=current.isoformat())
        counts = result['counts']
        state['data'].setdefault('notifications', []).insert(0, {
            'id': 'notice-' + uuid.uuid4().hex,
            'title': '定时预审已完成',
            'text': f"已核查{len(result['items'])}张单据，{counts['attention']}张需关注，{counts['unknown']}张待核实。",
            'createdAt': current.isoformat(), 'read': False, 'kind': 'audit',
        })
    store.mutate(complete)
    return True
