import importlib
import importlib.util
import io
import json
import stat
import zipfile
from pathlib import Path

import pytest


class FileStore:
    def __init__(self, records):
        self.records = records

    def get_file(self, file_id):
        return self.records.get(file_id)


def package(tmp_path, content, suffix='.zip', metadata=None):
    directory = tmp_path / 'files'
    directory.mkdir(exist_ok=True)
    if isinstance(content, dict):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for name, value in content.items():
                archive.writestr(name, value)
        content = buffer.getvalue()
    if isinstance(content, str):
        content = content.encode()
    (directory / ('upload' + suffix)).write_bytes(content)
    store = FileStore({'file-1': {'storage_name': 'upload' + suffix,
                                'metadata': metadata or {'name': '技能' + suffix}}})
    assert importlib.util.find_spec('skill_packages') is not None, '缺少技能包解析模块'
    return importlib.import_module('skill_packages').SkillPackageService(store, tmp_path)


def test_plain_text_creates_skill_root_and_metadata(tmp_path):
    service = package(tmp_path, '---\nname: office\ndescription: 创建文档\n---\n# 办公技能\n完成文档。', '.md')
    result = service.inspect('file-1')
    assert result['name'] == 'office'
    assert result['description'] == '创建文档'
    assert result['instructions'] == '# 办公技能\n完成文档。'
    assert result['status'] == 'ready'
    assert result['missingDependencies'] == []
    assert (service.root('file-1') / 'SKILL.md').is_file()
    assert service.read('file-1', 'SKILL.md')['text'].startswith('---')


def test_wrapped_zip_preserves_resources_and_restart(tmp_path):
    service = package(tmp_path, {'office/SKILL.md': '# 生成文档',
                                 'office/scripts/make.py': 'print(1)',
                                 'office/references/guide.md': '资料',
                                 'office/assets/logo.bin': b'\x00\xff'})
    result = service.inspect('file-1')
    assert result['scripts'] == ['scripts/make.py']
    assert result['references'] == ['references/guide.md']
    assert {f['path'] for f in result['files']} == {'SKILL.md', 'scripts/make.py', 'references/guide.md', 'assets/logo.bin'}
    restarted = type(service)(service.store, tmp_path)
    assert restarted.root('file-1') == service.root('file-1')
    assert restarted.read('file-1', 'references/guide.md')['text'] == '资料'


@pytest.mark.parametrize('name', ['../outside', '/absolute', 'a/../../outside', 'a\\outside', 'C:/outside', 'a/./b', 'a//b'])
def test_zip_rejects_unsafe_paths(tmp_path, name):
    service = package(tmp_path, {'SKILL.md': '技能', name: '不应写入'})
    with pytest.raises(ValueError, match='路径'):
        service.inspect('file-1')
    assert not (tmp_path / 'outside').exists()


def test_zip_rejects_symbolic_links(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('SKILL.md', '技能')
        link = zipfile.ZipInfo('references/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, '/etc/passwd')
    service = package(tmp_path, buffer.getvalue())
    with pytest.raises(ValueError, match='链接'):
        service.inspect('file-1')


def test_zip_rejects_duplicates(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('SKILL.md', '技能')
        with pytest.warns(UserWarning):
            archive.writestr('SKILL.md', '重复')
    service = package(tmp_path, buffer.getvalue())
    with pytest.raises(ValueError, match='重复'):
        service.inspect('file-1')


@pytest.mark.parametrize('contents, message', [
    ({'SKILL.md': '技能', **{f'assets/{n}': '' for n in range(500)}}, '数量'),
    ({'SKILL.md': '技能', 'assets/large': b'0' * (10 * 1024 * 1024 + 1)}, '大小'),
    ({'SKILL.md': '技能', **{f'assets/{n}': b'0' * (10 * 1024 * 1024) for n in range(5)}}, '总大小'),
])
def test_zip_enforces_quotas(tmp_path, contents, message):
    service = package(tmp_path, contents)
    with pytest.raises(ValueError, match=message):
        service.inspect('file-1')


def test_declared_missing_dependency_blocks_script(tmp_path):
    service = package(tmp_path, {'SKILL.md': '技能', 'scripts/run.py': 'print(1)',
                                 'requirements.txt': 'caixiaozhi-impossible-package-123456>=1.0\n'})
    result = service.inspect('file-1')
    assert result['status'] == 'blocked'
    assert len(result['missingDependencies']) == 1
    assert 'caixiaozhi-impossible-package-123456' in result['missingDependencies'][0]


def test_installed_dependency_version_is_checked(tmp_path):
    service = package(tmp_path, {'SKILL.md': '技能', 'scripts/run.py': 'print(1)', 'requirements.txt': 'pytest>=9999\n'})
    assert service.inspect('file-1')['status'] == 'blocked'


def test_instruction_only_package_remains_readable_with_missing_dependency(tmp_path):
    service = package(tmp_path, {'SKILL.md': '按以下步骤手动整理。', 'requirements.txt': 'caixiaozhi-impossible-package-123456\n'})
    result = service.inspect('file-1')
    assert result['status'] == 'ready'
    assert result['warnings']


def test_read_cannot_escape_or_read_binary(tmp_path):
    service = package(tmp_path, {'SKILL.md': '技能', 'assets/logo.bin': b'\x00\xff'})
    with pytest.raises(ValueError, match='路径'):
        service.read('file-1', '../files/upload.zip')
    with pytest.raises(ValueError, match='文本'):
        service.read('file-1', 'assets/logo.bin')


def test_metadata_cannot_override_root_and_large_text_is_truncated(tmp_path):
    service = package(tmp_path, 'a' * 70000, '.txt', {'root': '/etc', 'packageRoot': '/etc', 'name': 'notes.txt'})
    root = service.root('file-1')
    assert root.is_relative_to(tmp_path)
    result = service.read('file-1', 'SKILL.md')
    assert len(result['text']) == 60000
    assert result['truncated'] is True


def test_missing_skill_document_is_rejected(tmp_path):
    service = package(tmp_path, {'scripts/run.py': 'print(1)'})
    with pytest.raises(ValueError, match='SKILL.md'):
        service.inspect('file-1')


def test_frontmatter_uses_safe_yaml_and_requires_mapping(tmp_path):
    service = package(tmp_path, '---\n!!python/object/apply:os.system [echo unsafe]\n---\n正文', '.md')
    with pytest.raises(ValueError, match='元数据'):
        service.inspect('file-1')


def test_read_offset_supports_continued_resource_loading(tmp_path):
    service = package(tmp_path, '前' * 60000 + '后续内容', '.txt')
    first = service.read('file-1', 'SKILL.md')
    second = service.read('file-1', 'SKILL.md', offset=first['nextOffset'])
    assert second['text'] == '后续内容'
    assert second['truncated'] is False


@pytest.mark.parametrize('names', [('assets/Cafe\u0301.txt', 'assets/Caf\u00e9.txt'), ('assets/File.txt', 'assets/file.txt')])
def test_zip_rejects_filesystem_normalized_duplicates(tmp_path, names):
    service = package(tmp_path, {'SKILL.md': '技能', names[0]: 'a', names[1]: 'b'})
    with pytest.raises(ValueError, match='重复'):
        service.inspect('file-1')


def test_node_dependencies_are_checked_without_running_lifecycle_commands(tmp_path, monkeypatch):
    service = package(tmp_path, {'SKILL.md': '技能', 'scripts/run.js': 'console.log(1)',
                                 'package.json': json.dumps({'dependencies': {'pptxgenjs': '^4.0.0'},
                                                            'scripts': {'postinstall': 'touch pwned'}})})
    node_modules = tmp_path / 'node_modules'
    (node_modules / 'pptxgenjs').mkdir(parents=True)
    (node_modules / 'pptxgenjs' / 'package.json').write_text('{"version":"4.0.1"}')
    monkeypatch.setattr(importlib.import_module('skill_packages'), 'NODE_MODULES', node_modules)
    result = service.inspect('file-1')
    assert result['status'] == 'ready'
    assert result['missingDependencies'] == []
    assert result['warnings']
    assert not (service.root('file-1') / 'pwned').exists()


def test_invalid_node_package_name_cannot_resolve_parent_manifest(tmp_path, monkeypatch):
    service = package(tmp_path, {'SKILL.md': '技能', 'scripts/run.js': 'console.log(1)',
                                 'package.json': '{"dependencies":{"..":"1.0.0"}}'})
    node_modules = tmp_path / 'node_modules'
    node_modules.mkdir()
    (tmp_path / 'package.json').write_text('{"version":"1.0.0"}')
    monkeypatch.setattr(importlib.import_module('skill_packages'), 'NODE_MODULES', node_modules)
    assert service.inspect('file-1')['status'] == 'blocked'


def test_zip_rejects_unreasonably_deep_paths_with_chinese_error(tmp_path):
    service = package(tmp_path, {'SKILL.md': '技能', '/'.join(['dir'] * 500) + '/file': 'x'})
    with pytest.raises(ValueError, match='路径'):
        service.inspect('file-1')
