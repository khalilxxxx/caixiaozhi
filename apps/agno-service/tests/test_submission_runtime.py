"""智能提单运行器：北京时间锚点及真实草稿工具链，不访问模型服务。"""
import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from agno.tools.function import Function

import agent_runtime
from business import Business


@pytest.mark.parametrize(('instant', 'expected'), [
    (datetime(2026, 11, 16, 16, 30, tzinfo=timezone.utc), {
        'timezone': 'Asia/Shanghai', 'today': '2026-11-17',
        'tomorrow': '2026-11-18', 'dayAfterTomorrow': '2026-11-19',
        'thisWeek': {'周一': '2026-11-16', '周二': '2026-11-17', '周三': '2026-11-18',
                     '周四': '2026-11-19', '周五': '2026-11-20', '周六': '2026-11-21', '周日': '2026-11-22'},
        'nextWeek': {'周一': '2026-11-23', '周二': '2026-11-24', '周三': '2026-11-25',
                     '周四': '2026-11-26', '周五': '2026-11-27', '周六': '2026-11-28', '周日': '2026-11-29'},
    }),
    (datetime(2026, 12, 31, 16, 30, tzinfo=timezone.utc), {
        'timezone': 'Asia/Shanghai', 'today': '2027-01-01',
        'tomorrow': '2027-01-02', 'dayAfterTomorrow': '2027-01-03',
        'thisWeek': {'周一': '2026-12-28', '周二': '2026-12-29', '周三': '2026-12-30',
                     '周四': '2026-12-31', '周五': '2027-01-01', '周六': '2027-01-02', '周日': '2027-01-03'},
        'nextWeek': {'周一': '2027-01-04', '周二': '2027-01-05', '周三': '2027-01-06',
                     '周四': '2027-01-07', '周五': '2027-01-08', '周六': '2027-01-09', '周日': '2027-01-10'},
    }),
])
def test_submission_calendar_uses_shanghai_day_and_calendar_weeks(instant, expected):
    assert agent_runtime.submission_calendar(instant) == expected


def execute_submission(tmp_path, monkeypatch, message, journey, setup=None, *, expected_status='completed'):
    """只替换远程推理；持久化、业务默认、校验和运行事件全部执行真实代码。"""
    import config
    from store import Store
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    if setup:
        setup(store)
    observed = {}

    class ExecutingAgent:
        def __init__(self, **kwargs):
            self.tools = {}
            for tool in kwargs['tools']:
                if not hasattr(tool, '__name__'):
                    continue
                function = Function.from_callable(tool)
                function.process_entrypoint()
                self.tools[tool.__name__] = function.entrypoint
            observed['instructions'] = kwargs['instructions']

        async def arun(self, *args, **kwargs):
            observed['result'] = await journey(self.tools, observed['instructions'])
            yield SimpleNamespace(event='RunContent', content='草稿已保存，请核对行程。')

    monkeypatch.setattr(agent_runtime, 'Agent', ExecutingAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    store.mutate(lambda state: state['tasks'].append({
        'id': 'submission-test', 'activeRunId': 'submission-run',
        'messages': [{'role': 'user', 'text': message}],
    }))
    store.create_run('submission-run', 'submission-test', {'message': message, 'refs': [], 'capability': 'submission'})
    asyncio.run(agent_runtime.Runtime(store, Business(store)).execute('submission-run'))
    assert store.run('submission-run')['status'] == expected_status, store.events('submission-run')
    return store, observed


def test_runtime_get_update_validate_keeps_defaults_and_sources(tmp_path, monkeypatch):
    original_instructions = agent_runtime.submission_instructions
    monkeypatch.setattr(agent_runtime, 'submission_instructions',
                        lambda: original_instructions(datetime(2026, 11, 16, 16, 30, tzinfo=timezone.utc)))

    async def journey(tools, instructions):
        dates = json.loads(next(line.split('：', 1)[1] for line in instructions if line.startswith('日期锚点')))
        before = await tools['get_submission_draft']('travel')
        assert before['submissionContext']['employee']
        updated = await tools['update_submission_draft']('travel', {
            'purpose': '拜访客户',
            'legs': [{'id': 'go', 'arrivalCity': '上海', 'departureDate': dates['thisWeek']['周四']},
                     {'id': 'back', 'isReturn': True, 'departureDate': dates['thisWeek']['周五']}],
        })
        assert 'error' not in updated, updated
        checked = await tools['validate_submission']('travel')
        return {'updated': updated, 'checked': checked}

    store, observed = execute_submission(tmp_path, monkeypatch, '周四去上海拜访客户，周五回来', journey)
    result = observed['result']
    draft = result['checked']['draft']
    assert draft['purpose'] == '拜访客户'
    assert draft['legs'][0]['departureCity'] == '杭州'
    assert draft['legs'][1]['arrivalCity'] == '杭州'
    assert draft['legs'][0]['transport'] == '火车-二等座'
    assert draft['legs'][0]['departureDate'] == '2026-11-19'
    assert draft['legs'][1]['departureDate'] == '2026-11-20'
    assert draft['autoFill']['fields']['legs.go.departureCity']['source']
    assert draft['autoFill']['fields']['legs.go.transport']['source']
    assert result['updated']['submissionContext'] == result['checked']['submissionContext']
    assert not any(issue['path'].endswith(('departureCity', 'transport', 'purpose')) for issue in result['checked']['check']['issues'])
    completed = [event['data']['name'] for event in store.events('submission-run')
                 if event['kind'] == 'tool' and event['data']['status'] == 'completed']
    assert completed == ['get_submission_draft', 'update_submission_draft', 'validate_submission']
    task = next(task for task in store.get_state()['tasks'] if task['id'] == 'submission-test')
    assert task['messages'][-1]['cards'][0]['id'] == 'travel'
    assert task['refs'][0]['id'] == 'travel'


def test_runtime_week_only_request_saves_known_fields_and_leaves_dates_pending(tmp_path, monkeypatch):
    async def journey(tools, instructions):
        await tools['get_submission_draft']('travel')
        updated = await tools['update_submission_draft']('travel', {
            'purpose': '拜访客户',
            'legs': [{'id': 'go', 'arrivalCity': '上海'}, {'id': 'back', 'isReturn': True}],
        })
        assert 'error' not in updated, updated
        return await tools['validate_submission']('travel')

    _, observed = execute_submission(tmp_path, monkeypatch, '下周去上海拜访客户再回来，具体日期未定', journey)
    draft = observed['result']['draft']
    assert draft['purpose'] == '拜访客户'
    assert draft['legs'][0]['departureCity'] == '杭州'
    assert draft['legs'][0]['arrivalCity'] == '上海'
    assert draft['legs'][0]['transport'] == '火车-二等座'
    assert draft['legs'][0]['departureDate'] == draft['legs'][1]['departureDate'] == ''
    paths = [issue['path'] for issue in observed['result']['check']['issues']]
    assert any(path.endswith('departureDate') for path in paths)
    assert not any(path.endswith(('departureCity', 'arrivalCity', 'transport', 'purpose')) for path in paths)


def test_runtime_sparse_change_preserves_manual_fields_and_unknown_return_date(tmp_path, monkeypatch):
    def setup(store):
        Business(store).update_draft('travel', {
            'purpose': '客户评审（已人工确认）', 'companions': ['陈宁'],
            'legs': [{'id': 'go', 'departureCity': '南京', 'arrivalCity': '上海',
                      'departureDate': '2026-11-19', 'arrivalDate': '2026-11-20',
                      'transport': '火车-硬卧', 'isOvernight': True}],
        })

    async def journey(tools, instructions):
        await tools['get_submission_draft']('travel')
        updated = await tools['update_submission_draft']('travel', {
            'legs': [{'id': 'go'}, {'id': 'back', 'isReturn': True}],
        })
        assert 'error' not in updated, updated
        return await tools['validate_submission']('travel')

    _, observed = execute_submission(tmp_path, monkeypatch, '加上返程，日期还没定', journey, setup)
    draft = observed['result']['draft']
    assert draft['purpose'] == '客户评审（已人工确认）'
    assert draft['companions'] == ['陈宁']
    assert draft['legs'][0]['arrivalDate'] == '2026-11-20'
    assert draft['legs'][0]['transport'] == '火车-硬卧'
    assert draft['legs'][1]['arrivalCity'] == '南京'
    assert draft['legs'][1]['departureDate'] == ''
    assert draft['legs'][1]['arrivalDate'] == ''
    assert any(issue['path'].endswith('departureDate') for issue in observed['result']['check']['issues'])


@pytest.mark.parametrize(('container', 'retry'), [('drafts', True), ('edits', True), ('edits', False)])
def test_runtime_rejects_stale_patch_after_manual_changes(tmp_path, monkeypatch, container, retry):
    store = None

    def setup(workspace):
        nonlocal store
        store = workspace
        Business(workspace).update_draft('travel', {'legs': [
            {'id': 'go', 'arrivalCity': '上海', 'transport': '火车-二等座'},
        ]})

    async def journey(tools, instructions):
        get, update = tools['get_submission_draft'], tools['update_submission_draft']
        before = (await get('travel'))['draft']
        manual = {'travel': {
            'legs': [{'id': 'go', 'transport': '火车-一等座'}, {'id': 'manual-stop', 'arrivalCity': '北京'}],
        }}
        store.patch({'baseRevision': store.snapshot()['revision'], 'data': {'submissions': {container: manual}}})
        changed = Business(store).get_draft('travel')['draft']
        if container == 'edits':
            assert changed['version'] == before['version']
        stale = await update('travel', {'legs': [{**before['legs'][0], 'departureDate': '2026-11-19'}]})
        assert stale.get('code') == 'STALE_DRAFT', stale
        assert Business(store).get_draft('travel')['draft'] == changed
        if container == 'edits':
            assert store.get_state()['data']['submissions']['edits']['travel'] == changed

        if not retry:
            return stale
        await get('travel')
        return await update('travel', {'legs': [{'id': 'go', 'departureDate': '2026-11-19'}]})

    store, observed = execute_submission(tmp_path, monkeypatch, '去程改为周四', journey, setup,
                                         expected_status='completed' if retry else 'failed')
    if not retry:
        assistant = store.get_state()['tasks'][0]['messages'][-1]
        assert assistant['text'] == observed['result']['error']
        return
    draft = observed['result']['draft']
    assert [row['id'] for row in draft['legs']] == ['go', 'manual-stop']
    assert draft['legs'][0]['transport'] == '火车-一等座'
    assert draft['legs'][0]['departureDate'] == '2026-11-19'
    assert draft['legs'][1]['arrivalCity'] == '北京'
    assert store.get_state()['data']['submissions']['drafts']['travel'] == draft


def test_runtime_row_patch_requires_explicit_deletion_by_id(tmp_path, monkeypatch):
    def setup(store):
        Business(store).update_draft('expense', {
            'legs': [{'id': 'go', 'arrivalCity': '上海'}, {'id': 'stop', 'arrivalCity': '北京'}],
            'expenses': [{'id': 'fee', 'reason': '人工确认的交通费用'}],
            'activities': [{'id': 'visit', 'description': '客户拜访'}, {'id': 'review', 'description': '项目评审'}],
        })

    async def journey(tools, instructions):
        await tools['get_submission_draft']('expense')
        update = tools['update_submission_draft']
        changed = await update('expense', {
            'legs': [{'id': 'go', 'departureDate': '2026-11-19'}],
            'expenses': [],
            'activities': [{'id': 'visit', 'description': '客户签约'}],
        })
        assert [row['id'] for row in changed['draft']['legs']] == ['go', 'stop']
        assert [row['id'] for row in changed['draft']['expenses']] == ['fee']
        assert [row['id'] for row in changed['draft']['activities']] == ['visit', 'review']
        assert changed['draft']['activities'][0]['description'] == '客户签约'
        return await update('expense', {}, remove_rows={'legs': ['stop'], 'activities': ['review']})

    _, observed = execute_submission(tmp_path, monkeypatch, '更新出发日期和活动，再移除第二段和项目评审', journey, setup)
    draft = observed['result']['draft']
    assert [row['id'] for row in draft['legs']] == ['go']
    assert draft['legs'][0]['departureDate'] == '2026-11-19'
    assert draft['expenses'][0]['reason'] == '人工确认的交通费用'
    assert [row['id'] for row in draft['activities']] == ['visit']


@pytest.mark.parametrize('draft_id', ['expense', 'personal'])
def test_runtime_reimbursement_does_not_invent_actual_costs_or_transport(tmp_path, monkeypatch, draft_id):
    async def journey(tools, instructions):
        await tools['get_submission_draft'](draft_id)
        updated = await tools['update_submission_draft'](draft_id, {
            'purpose': '报销上海客户拜访费用',
            'legs': [{'id': 'go', 'arrivalCity': '上海', 'departureDate': '2026-11-10'}],
        })
        assert 'error' not in updated, updated
        return await tools['validate_submission'](draft_id)

    _, observed = execute_submission(tmp_path, monkeypatch, '报销去上海拜访客户的费用', journey)
    draft = observed['result']['draft']
    assert draft['legs'][0]['transport'] == ''
    assert draft['expenses'] == []
    assert not observed['result']['canSubmit']


def test_runtime_one_way_overnight_does_not_create_return_or_same_day_arrival(tmp_path, monkeypatch):
    async def journey(tools, instructions):
        await tools['get_submission_draft']('travel')
        updated = await tools['update_submission_draft']('travel', {
            'purpose': '参加客户会议',
            'legs': [{'id': 'go', 'departureCity': '杭州', 'arrivalCity': '北京',
                      'departureDate': '2026-11-19', 'transport': '火车-硬卧', 'isOvernight': True}],
        })
        assert 'error' not in updated, updated
        return await tools['validate_submission']('travel')

    _, observed = execute_submission(tmp_path, monkeypatch, '周四去北京参加客户会议，坐过夜火车，只填单程', journey)
    draft = observed['result']['draft']
    assert len(draft['legs']) == 1
    assert draft['legs'][0]['arrivalDate'] == ''
    assert draft['legs'][0]['transport'] == '火车-硬卧'
    assert any(issue['path'].endswith('arrivalDate') for issue in observed['result']['check']['issues'])


def test_runtime_new_independent_draft_accepts_returned_id_for_read_patch_and_validation(tmp_path, monkeypatch):
    async def journey(tools, instructions):
        created = await tools['new_submission_draft']('travel')
        draft_id = created['draft']['id']
        assert draft_id.startswith('travel-')
        await tools['get_submission_draft'](draft_id)
        saved = await tools['update_submission_draft'](draft_id, {
            'purpose': '拜访客户',
            'legs': [{'id': 'go', 'arrivalCity': '上海', 'departureDate': '2026-11-19'}],
        })
        assert 'error' not in saved, saved
        return await tools['validate_submission'](draft_id)

    store, observed = execute_submission(tmp_path, monkeypatch, '新建一张上海客户拜访申请', journey)
    draft = observed['result']['draft']
    assert draft['id'].startswith('travel-')
    assert draft['type'] == 'travel'
    assert draft['purpose'] == '拜访客户'
    assert draft['legs'][0]['departureCity'] == '杭州'
    assert store.get_state()['data']['submissions']['drafts']['travel']['purpose'] == ''
    task = next(task for task in store.get_state()['tasks'] if task['id'] == 'submission-test')
    assert task['refs'][0]['id'] == draft['id']


def test_runtime_explicit_empty_transport_on_first_request_suppresses_recommendation(tmp_path, monkeypatch):
    async def journey(tools, instructions):
        await tools['get_submission_draft']('travel')
        result = await tools['update_submission_draft']('travel', {
            'purpose': '拜访客户',
            'legs': [{'id': 'go', 'arrivalCity': '上海', 'departureDate': '2026-11-19', 'transport': ''}],
        }, manual_fields=['legs.go.transport'])
        assert 'error' not in result, result
        return await tools['validate_submission']('travel')

    _, observed = execute_submission(tmp_path, monkeypatch, '明天去上海拜访客户，交通留空，不要推荐', journey)
    draft = observed['result']['draft']
    assert draft['legs'][0]['transport'] == ''
    assert 'legs.go.transport' in draft['autoFill']['suppressed']
    assert 'legs.go.transport' not in draft['autoFill']['fields']
    assert any(issue['path'].endswith('transport') for issue in observed['result']['check']['issues'])


def test_runtime_explicit_same_transport_removes_automatic_source(tmp_path, monkeypatch):
    def setup(store):
        Business(store).update_draft('travel', {
            'purpose': '拜访客户',
            'legs': [{'id': 'go', 'arrivalCity': '上海', 'departureDate': '2026-11-19'}],
        })

    async def journey(tools, instructions):
        original = await tools['get_submission_draft']('travel')
        assert original['draft']['legs'][0]['transport'] == '火车-二等座'
        result = await tools['update_submission_draft']('travel', {
            'legs': [{'id': 'go', 'transport': '火车-二等座'}],
        }, manual_fields=['legs.go.transport'])
        assert 'error' not in result, result
        return await tools['validate_submission']('travel')

    _, observed = execute_submission(tmp_path, monkeypatch, '我确认就坐火车二等座', journey, setup)
    draft = observed['result']['draft']
    assert draft['legs'][0]['transport'] == '火车-二等座'
    assert 'legs.go.transport' not in draft['autoFill']['fields']
