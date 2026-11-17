import asyncio
import pytest
from pathlib import Path
from store import Store


def service(tmp_path):
    from skill_artifacts import SkillArtifactService
    return SkillArtifactService(Store(tmp_path / 'state.db'), tmp_path / 'data')


def test_generated_file_is_copied_and_survives_workspace_removal(tmp_path):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    source = workspace / 'output' / '分析.csv'
    source.write_text('类别,金额\n交通,25.50\n')
    item = artifacts.publish(workspace, 'output/分析.csv', 'task-a', 'run-a')
    source.unlink()
    assert artifacts.path(item['id']).read_text() == '类别,金额\n交通,25.50\n'
    assert artifacts.get(item['id'])['taskId'] == 'task-a'
    assert artifacts.list('task-b') == []
    assert artifacts.list('task-a')[0]['id'] == item['id']
    assert artifacts.get(item['id'])['previewKind'] == 'text'
    assert 'storage_path' not in item
    assert service(tmp_path).get(item['id'])['name'] == '分析.csv'


@pytest.mark.parametrize('path', ['../private.txt', '/etc/passwd', 'work/code.py', 'output/../private.txt'])
def test_only_output_files_can_be_published(tmp_path, path):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    workspace.mkdir()
    with pytest.raises(ValueError):
        artifacts.publish(workspace, path, 't', 'r')


def test_symlink_cannot_publish_other_files(tmp_path):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    secret = tmp_path / 'private.txt'
    secret.write_text('private')
    (workspace / 'output' / 'leak.txt').symlink_to(secret)
    with pytest.raises(ValueError):
        artifacts.publish(workspace, 'output/leak.txt', 't', 'r')


def test_html_and_unknown_extension_do_not_become_unrestricted_inline_content(tmp_path):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    (workspace / 'output' / 'report.html').write_text('<script>alert(1)</script>')
    item = artifacts.publish(workspace, 'output/report.html', 't', 'r')
    assert item['previewKind'] == 'html'
    (workspace / 'output' / 'app.exe').write_bytes(b'executable')
    with pytest.raises(ValueError):
        artifacts.publish(workspace, 'output/app.exe', 't', 'r')


def test_long_text_preview_explains_truncation_and_preserves_full_download(tmp_path):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    (workspace / 'output/long.txt').write_text('文' * 80000)
    item = artifacts.publish(workspace, 'output/long.txt', 't', 'r')
    assert len(item['text']) == 60000
    assert item['warnings']
    assert len(artifacts.path(item['id']).read_text()) == 80000


def test_preview_converter_output_cannot_follow_a_symlink(tmp_path, monkeypatch):
    from skill_executor import LocalSkillExecutor
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    from pptx import Presentation
    presentation = Presentation()
    presentation.slides.add_slide(presentation.slide_layouts[0])
    presentation.save(workspace / 'output/deck.pptx')
    original = (workspace / 'output/deck.pptx').read_bytes()
    item = artifacts.publish(workspace, 'output/deck.pptx', 't', 'r')
    secret = tmp_path / 'private.txt'
    secret.write_text('private')

    async def compromised_converter(self, workspace, *args, **kwargs):
        (workspace / 'output/deck.pdf').symlink_to(secret)
        return {'exitCode': 0, 'status': 'success'}

    monkeypatch.setattr(LocalSkillExecutor, 'execute', compromised_converter)
    result = asyncio.run(artifacts.prepare_preview(item['id']))
    assert result['previewStatus'] == 'failed'
    assert not (artifacts.directory / item['id'] / '_preview.pdf').exists()
    assert artifacts.path(item['id']).read_bytes() == original


@pytest.mark.parametrize('suffix', ['xlsx', 'docx', 'pptx', 'pdf', 'csv'])
def test_disguised_or_damaged_documents_cannot_be_published(tmp_path, suffix):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    (workspace / f'output/broken.{suffix}').write_bytes(b'not a document\x00\xff')
    with pytest.raises(ValueError, match='格式|读取|损坏'):
        artifacts.publish(workspace, f'output/broken.{suffix}', 't', 'r')
    assert artifacts.list('t') == []


@pytest.mark.parametrize('suffix', ['xlsx', 'docx', 'pptx', 'pdf', 'csv'])
def test_readable_documents_publish_with_explicit_validation_scope(tmp_path, suffix):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    target = workspace / f'output/valid.{suffix}'
    if suffix == 'xlsx':
        from openpyxl import Workbook
        book = Workbook()
        book.active.append(['金额', 10.5])
        book.save(target)
    elif suffix == 'docx':
        from docx import Document
        doc = Document()
        doc.add_paragraph('报告')
        doc.save(target)
    elif suffix == 'pptx':
        from pptx import Presentation
        deck = Presentation()
        deck.slides.add_slide(deck.slide_layouts[0])
        deck.save(target)
    elif suffix == 'pdf':
        from reportlab.pdfgen.canvas import Canvas
        pdf = Canvas(str(target))
        pdf.drawString(30, 30, 'Report')
        pdf.save()
    else:
        target.write_text('类别,金额\n交通,10.50\n')
    item = artifacts.publish(workspace, f'output/valid.{suffix}', 't', 'r')
    assert item['validation']['structure']['status'] == 'passed'
    assert item['validation']['dataConsistency']['status'] == 'not_checked'
    assert item['validation']['visual']['status'] == 'not_checked'


def test_csv_with_inconsistent_columns_is_rejected(tmp_path):
    artifacts = service(tmp_path)
    workspace = tmp_path / 'job'
    (workspace / 'output').mkdir(parents=True)
    (workspace / 'output/bad.csv').write_text('类别,金额\n交通,10,多余\n')
    with pytest.raises(ValueError, match='CSV'):
        artifacts.publish(workspace, 'output/bad.csv', 't', 'r')
