from pathlib import Path
import pytest
from store import Store
from file_service import save_file


def make_workspace(tmp_path, refs=None):
    from skill_workspace import SkillWorkspace
    store = Store(tmp_path / 'workspace.db')
    return store, SkillWorkspace(store, tmp_path / 'data', 'task-a', 'run-a', refs or [])


def test_only_referenced_uploads_enter_the_job(tmp_path):
    from skill_workspace import SkillWorkspace
    store = Store(tmp_path / 'workspace.db')
    directory = tmp_path / 'data' / 'files'
    chosen = save_file(store, directory, 'selected.txt', 'text/plain', b'selected')
    save_file(store, directory, 'private.txt', 'text/plain', b'private')
    job = SkillWorkspace(store, tmp_path / 'data', 't', 'r', [{'kind': 'file', 'id': chosen['id']}])
    paths = [f['path'] for f in job.files()['files']]
    assert len(paths) == 1 and paths[0].endswith('selected.txt')
    assert job.read(paths[0])['text'] == 'selected'


def test_legacy_batch_reference_selects_only_its_uploads(tmp_path):
    from skill_workspace import SkillWorkspace
    store = Store(tmp_path / 'workspace.db')
    chosen = save_file(store, tmp_path / 'data/files', 'old.txt', 'text/plain', b'old')
    def update(state):
        next(f for f in state['data']['materials']['files'] if f['id'] == chosen['id'])['batchId'] = 'old-batch'
    store.mutate(update)
    save_file(store, tmp_path / 'data/files', 'other.txt', 'text/plain', b'other')
    job = SkillWorkspace(store, tmp_path / 'data', 't', 'legacy', [{'kind': 'materials', 'id': 'old-batch'}])
    files = job.files()['files']
    assert len(files) == 1 and chosen['id'] in files[0]['path']


def test_write_cannot_overwrite_inputs_or_escape(tmp_path):
    _, job = make_workspace(tmp_path)
    for path in ['input/test.txt', '../test.txt', '/tmp/test.txt', 'work/../../test.txt']:
        with pytest.raises(ValueError):
            job.write(path, 'bad')
    job.write('work/data.json', '{"value": 12}')
    assert job.read('work/data.json')['text'] == '{"value": 12}'


def test_outputs_persist_as_artifacts_and_only_same_task_can_import(tmp_path):
    from skill_workspace import SkillWorkspace
    store, job = make_workspace(tmp_path)
    job.write('output/result.txt', 'finished')
    result = job.publish('output/result.txt')
    identifier = result['artifact']['id']
    next_job = SkillWorkspace(store, tmp_path / 'data', 'task-a', 'run-b', [])
    imported = next_job.import_artifact(identifier)
    assert next_job.read(imported['path'])['text'] == 'finished'
    other_job = SkillWorkspace(store, tmp_path / 'data', 'task-b', 'run-c', [])
    with pytest.raises(ValueError):
        other_job.import_artifact(identifier)


def test_jobs_have_distinct_directories_and_no_symlink_reads(tmp_path):
    from skill_workspace import SkillWorkspace
    store, job = make_workspace(tmp_path)
    second = SkillWorkspace(store, tmp_path / 'data', 'task-a', 'run-b', [])
    assert job.root != second.root
    job.write('work/a.txt', 'a')
    (job.root / 'work/link.txt').symlink_to(tmp_path / 'workspace.db')
    with pytest.raises(ValueError):
        job.read('work/link.txt')
