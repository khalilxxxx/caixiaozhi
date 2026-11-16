from datetime import datetime
from zoneinfo import ZoneInfo
from business import Business
from store import Store
from scheduler import tick


def test_daily_schedule_is_durable_and_not_replayed(tmp_path):
    store=Store(tmp_path/'test.db')
    store.mutate(lambda s:s['data']['rulesSubmission']['schedule'].update(enabled=True, time='08:30'))
    at=datetime(2026,11,16,20,0,tzinfo=ZoneInfo('Asia/Shanghai'))
    assert tick(store,Business(store),at)
    assert not tick(store,Business(store),at)
    reopened=Store(tmp_path/'test.db')
    assert not tick(reopened,Business(reopened),at)
    assert len(reopened.get_state()['data']['notifications'])==1
    reopened.mutate(lambda s:s['data']['rulesSubmission']['schedule'].update(enabled=False))
    assert not tick(reopened,Business(reopened),at.replace(day=17))
