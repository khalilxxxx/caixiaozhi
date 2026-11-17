import asyncio
import json
import stat
from pathlib import Path

import pytest
from business import Business
from skill_agent_tools import SkillToolset
from skill_workspace import SkillWorkspace
from store import Store


def toolset(tmp_path, task_id='task-a', run_id='run-a'):
    store = Store(tmp_path / 'state.db')
    tool = SkillToolset(store, tmp_path / 'data', {'task_id': task_id, 'id': run_id, 'request': {}},
                        lambda name, label, fn, *args: fn(*args), None)
    return tool


def test_business_results_are_lazy_immutable_provenanced_inputs(tmp_path):
    tools = toolset(tmp_path)
    result = Business(tools.store).analyze('10')
    original_total = result['totalMinor']
    captured = tools.capture_result('analyze_expenses', result)
    assert not tools.job.root.exists()
    result['totalMinor'] = '1'
    tools.job.prepare()
    listing = tools.job.files()
    assert captured['path'] in [row['path'] for row in listing['files']]
    snapshot = json.loads(tools.job.read(captured['path'])['text'])
    assert snapshot['result']['totalMinor'] == original_total
    assert snapshot['source']['tool'] == 'analyze_expenses'
    assert snapshot['source']['capturedAt']
    assert snapshot['source']['stateRevision'] >= 0
    assert snapshot['units']['*Minor'] == 'CNY_fen'
    assert snapshot['result']['dataSource'] == result['dataSource']
    assert not (stat.S_IMODE((tools.job.root / captured['path']).stat().st_mode) & 0o222)
    with pytest.raises(ValueError):
        tools.job.write(captured['path'], '{}')
    other = toolset(tmp_path, 'task-b', 'run-b')
    assert other.job.files()['files'] == []
    with pytest.raises(ValueError):
        other.job.read(captured['path'])


def test_capture_excludes_mutations_errors_and_internal_secrets(tmp_path):
    tools = toolset(tmp_path)
    assert tools.capture_result('update_submission_draft', {'draft': {'id': 'a'}}) is None
    assert tools.capture_result('analyze_expenses', {'error': '失败'}) is None
    assert tools.capture_result('run_skill_script', {'stdout': 'secret'}) is None
    captured = tools.capture_result('query_documents', {'items': [], 'storage_name': '/private/raw', 'api_key': 'secret'})
    tools.job.prepare()
    text = tools.job.read(captured['path'])['text']
    assert '/private/raw' not in text and 'secret' not in text
    assert len(tools.job.files()['files']) == 1


def test_capture_after_prepare_is_immediately_discoverable(tmp_path):
    tools = toolset(tmp_path)
    tools.job.prepare()
    captured = tools.capture_result('validate_submission', {'canSubmit': False, 'check': {'issues': ['缺字段']}, 'draft': {'version': 7}})
    text = tools.job.read(captured['path'])['text']
    assert json.loads(text)['result']['draft']['version'] == 7
    assert json.loads(text)['result']['canSubmit'] is False


def snapshot_with_total(tools, total='1050'):
    return tools.capture_result('analyze_expenses', {'totalMinor': total, 'items': [{'amount': 10.5}], 'dataSource': '测试业务数据'})['path']


def test_sum_validation_is_bound_to_real_input_and_output_hashes(tmp_path):
    tools = toolset(tmp_path)
    snapshot = snapshot_with_total(tools)
    tools.job.write('output/result.csv', '类别,金额\n交通,10.00\n办公,0.50\n')
    report = tools.job.validate_artifact('output/result.csv', snapshot, '金额', 'yuan')
    assert report['status'] == 'passed'
    assert report['actualTotalMinor'] == report['expectedTotalMinor'] == '1050'
    item = tools.job.publish('output/result.csv')['artifact']
    assert item['validation']['dataConsistency']['status'] == 'passed'
    assert item['validation']['visual']['status'] == 'not_checked'
    tools.job.write('output/result.csv', '类别,金额\n交通,11.00\n')
    with pytest.raises(ValueError, match='重新核验'):
        tools.job.publish('output/result.csv')
    failed = tools.job.validate_artifact('output/result.csv', snapshot, '金额', 'yuan')
    assert failed['status'] == 'failed'
    with pytest.raises(ValueError, match='不一致'):
        tools.job.publish('output/result.csv')


def test_xlsx_sum_validation_and_forged_snapshot_rejection(tmp_path):
    from openpyxl import Workbook
    tools = toolset(tmp_path)
    snapshot = snapshot_with_total(tools)
    tools.job.prepare()
    workbook = Workbook()
    workbook.active.append(['金额分'])
    workbook.active.append([1000])
    workbook.active.append([50])
    workbook.save(tools.job.root / 'output/result.xlsx')
    report = tools.job.validate_artifact('output/result.xlsx', snapshot, '金额分', 'fen')
    assert report['actualTotalMinor'] == '1050'
    assert tools.job.publish('output/result.xlsx')['cards'][0]['status'] == '金额已核对'
    tools.job.write('work/fake.json', '{"result":{"totalMinor":"1050"}}')
    with pytest.raises(ValueError, match='业务快照'):
        tools.job.validate_artifact('output/result.xlsx', 'work/fake.json', '金额分', 'fen')
    (tools.job.root / snapshot).chmod(0o600)
    (tools.job.root / snapshot).write_text('{"result":{"totalMinor":"1"}}')
    with pytest.raises(ValueError, match='业务快照'):
        tools.job.validate_artifact('output/result.xlsx', snapshot, '金额分', 'fen')


def test_failed_amount_format_prevents_publishing_as_validated(tmp_path):
    tools = toolset(tmp_path)
    snapshot = snapshot_with_total(tools)
    tools.job.write('output/result.csv', '类别,金额\n交通,未知\n')
    with pytest.raises(ValueError, match='金额无效'):
        tools.job.validate_artifact('output/result.csv', snapshot, '金额', 'yuan')
    with pytest.raises(ValueError, match='核验'):
        tools.job.publish('output/result.csv')


def test_republishing_after_amount_check_preserves_new_validation_metadata(tmp_path):
    tools = toolset(tmp_path)
    snapshot = snapshot_with_total(tools)
    tools.job.write('output/result.csv', '类别,金额\n交通,10.50\n')
    first = tools.job.publish('output/result.csv')['artifact']
    assert first['validation']['dataConsistency']['status'] == 'not_checked'
    tools.job.validate_artifact('output/result.csv', snapshot, '金额', 'yuan')
    checked = tools.job.publish('output/result.csv')['artifact']
    assert checked['validation']['dataConsistency']['status'] == 'passed'
    assert tools.job.artifacts.get(first['id'])['validation']['dataConsistency']['status'] == 'not_checked'


def test_skill_operations_pass_real_arguments_to_runtime_callback(tmp_path):
    tools = toolset(tmp_path)
    tools.executable = True
    calls = []
    def runtime_call(name, label, fn, *args):
        calls.append((name, args))
        return fn(*args)
    tools.sync_call = runtime_call
    snapshot = snapshot_with_total(tools)
    content = '类别,金额\n交通,10.50\n'
    async def run():
        await tools.write_skill_file('output/result.csv', content)
        with pytest.raises(ValueError):
            await tools.read_skill_file('work/missing.txt')
        await tools.read_skill_file('output/result.csv', 2)
        await tools.validate_skill_artifact('output/result.csv', snapshot, '金额', 'yuan')
        published = await tools.publish_skill_artifact('output/result.csv')
        await tools.import_skill_artifact(published['artifact']['id'])
        return published['artifact']['id']
    artifact_id = asyncio.run(run())
    assert calls == [
        ('write_skill_file', ('output/result.csv', content)),
        ('read_skill_file', ('work/missing.txt', 0)),
        ('read_skill_file', ('output/result.csv', 2)),
        ('validate_skill_artifact', ('output/result.csv', snapshot, '金额', 'yuan', None)),
        ('publish_skill_artifact', ('output/result.csv',)),
        ('import_skill_artifact', (artifact_id,)),
    ]


def test_known_failed_amount_content_cannot_be_published_under_another_name(tmp_path):
    tools = toolset(tmp_path)
    snapshot = snapshot_with_total(tools)
    wrong = '类别,金额\n交通,11.00\n'
    tools.job.write('output/wrong.csv', wrong)
    assert tools.job.validate_artifact('output/wrong.csv', snapshot, '金额')['status'] == 'failed'
    # Correcting the original must not forget the failed bytes held elsewhere.
    tools.job.write('output/wrong.csv', '类别,金额\n交通,10.50\n')
    assert tools.job.validate_artifact('output/wrong.csv', snapshot, '金额')['status'] == 'passed'
    tools.job.write('output/renamed.csv', wrong)
    with pytest.raises(ValueError, match='不一致'):
        tools.job.publish('output/renamed.csv')
    # Unknown content retains the supported structure-only publishing behavior.
    tools.job.write('output/unrelated.csv', '名称,数量\n纸张,20\n')
    assert tools.job.publish('output/unrelated.csv')['artifact']['validation']['dataConsistency']['status'] == 'not_checked'
