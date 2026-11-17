"""Read uploaded skill packages without importing or executing their contents."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import re
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from pathlib import Path, PurePosixPath

import yaml
from packaging.requirements import InvalidRequirement, Requirement


MAX_FILES = 500
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_READ_CHARS = 60000
TEXT_EXTENSIONS = {'.md', '.txt', '.json', '.yaml', '.yml'}
SCRIPT_EXTENSIONS = {'.py', '.js', '.mjs', '.cjs', '.sh'}
NODE_MODULES = Path(__file__).resolve().parent / 'skill-node' / 'node_modules'


def _safe_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValueError('技能文件路径无效')
    if value.startswith('/') or re.match(r'^[A-Za-z]:', value):
        raise ValueError('技能文件路径必须为相对路径')
    parts = value.split('/')
    if len(parts) > 32 or len(value.encode('utf-8')) > 1024 or any(len(part.encode('utf-8')) > 240 for part in parts):
        raise ValueError('技能文件路径过长或目录层级过深')
    if any(part in {'', '.', '..'} or any(ord(char) < 32 for char in part) for part in parts):
        raise ValueError('技能文件路径包含不安全的目录')
    return PurePosixPath(value)


def _text(path: Path) -> str:
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('技能文件大小超过 10 MiB 限制')
    try:
        result = path.read_bytes().decode('utf-8-sig')
    except UnicodeError as exc:
        raise ValueError('该资源不是 UTF-8 文本文件') from exc
    if '\x00' in result:
        raise ValueError('该资源不是文本文件')
    return result


class SkillPackageService:
    def __init__(self, store, data_dir):
        self.store = store
        self.data_dir = Path(data_dir).resolve()

    def _source(self, file_id):
        record = self.store.get_file(file_id)
        if not record:
            raise ValueError('技能文件不存在')
        name = record.get('storage_name')
        relative = _safe_path(name)
        if len(relative.parts) != 1:
            raise ValueError('技能原件存储路径无效')
        directory = self.data_dir / 'files'
        source = directory / name
        if directory.is_symlink() or source.is_symlink() or not source.is_file():
            raise ValueError('技能原件存储路径无效或文件不存在')
        if not source.resolve().is_relative_to(self.data_dir):
            raise ValueError('技能原件存储路径越界')
        if source.stat().st_size > MAX_TOTAL_BYTES:
            raise ValueError('技能包总大小超过 50 MiB 限制')
        return record, source

    def root(self, file_id) -> Path:
        _, source = self._source(file_id)
        # Only trusted storage identity and uploaded bytes determine cache paths.
        digest = hashlib.sha256()
        with source.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        identity = hashlib.sha256(str(file_id).encode()).hexdigest()[:24]
        cache = self.data_dir / 'skill-packages'
        if cache.is_symlink():
            raise ValueError('技能缓存路径无效')
        cache.mkdir(parents=True, exist_ok=True)
        destination = cache / f'v1-{identity}-{digest.hexdigest()}'
        if destination.is_symlink():
            raise ValueError('技能缓存路径不允许链接')
        if destination.exists():
            self._validate_root(destination)
            return destination
        temporary = Path(tempfile.mkdtemp(prefix='.extract-', dir=cache))
        try:
            if source.suffix.lower() == '.zip':
                self._extract(source, temporary)
            elif source.suffix.lower() in TEXT_EXTENSIONS:
                content = _text(source)
                (temporary / 'SKILL.md').write_text(content, encoding='utf-8')
            else:
                raise ValueError('技能文件仅支持 Markdown、TXT、JSON、YAML 或 ZIP')
            self._validate_root(temporary)
            try:
                temporary.rename(destination)
            except OSError:
                # Concurrent inspections can finish the identical content first.
                if not destination.is_dir() or destination.is_symlink():
                    raise
                self._validate_root(destination)
            return destination
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)

    @staticmethod
    def _validate_root(root):
        if not root.is_dir() or root.is_symlink():
            raise ValueError('技能缓存路径无效')
        count = total = 0
        for path in root.rglob('*'):
            if path.is_symlink():
                raise ValueError('技能目录不允许符号链接')
            if not path.is_file() and not path.is_dir():
                raise ValueError('技能目录包含不支持的文件类型')
            if path.is_file():
                count += 1
                size = path.stat().st_size
                total += size
                if size > MAX_FILE_BYTES:
                    raise ValueError('技能文件大小超过 10 MiB 限制')
        if count > MAX_FILES:
            raise ValueError('技能文件数量超过 500 个限制')
        if total > MAX_TOTAL_BYTES:
            raise ValueError('技能包总大小超过 50 MiB 限制')
        if not (root / 'SKILL.md').is_file():
            raise ValueError('技能包根目录必须包含 SKILL.md')

    @staticmethod
    def _extract(source, target):
        try:
            with zipfile.ZipFile(source) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_FILES * 2:
                    raise ValueError('技能包目录及文件数量过多')
                names, files = set(), []
                total = 0
                for info in entries:
                    name = info.orig_filename
                    relative = _safe_path(name[:-1] if info.is_dir() else name)
                    normalized = unicodedata.normalize('NFC', relative.as_posix()).casefold()
                    if normalized in names:
                        raise ValueError('技能包存在重复路径')
                    names.add(normalized)
                    mode = info.external_attr >> 16
                    kind = stat.S_IFMT(mode)
                    if kind == stat.S_IFLNK:
                        raise ValueError('技能包不允许符号链接')
                    if kind not in {0, stat.S_IFREG, stat.S_IFDIR}:
                        raise ValueError('技能包包含不支持的文件类型')
                    if info.flag_bits & 1:
                        raise ValueError('不支持加密技能包')
                    if info.is_dir():
                        continue
                    if info.file_size > MAX_FILE_BYTES:
                        raise ValueError('技能文件大小超过 10 MiB 限制')
                    total += info.file_size
                    if total > MAX_TOTAL_BYTES:
                        raise ValueError('技能包总大小超过 50 MiB 限制')
                    files.append((info, relative))
                if len(files) > MAX_FILES:
                    raise ValueError('技能文件数量超过 500 个限制')
                paths = {relative.as_posix() for _, relative in files}
                prefix = None
                if 'SKILL.md' in paths:
                    prefix = ''
                else:
                    roots = {relative.parts[0] for _, relative in files}
                    if len(roots) == 1:
                        candidate = next(iter(roots))
                        if candidate + '/SKILL.md' in paths:
                            prefix = candidate
                if prefix is None:
                    raise ValueError('技能包根目录或单个外层目录必须包含 SKILL.md')
                written = 0
                for info, relative in files:
                    parts = relative.parts[1:] if prefix else relative.parts
                    output = target.joinpath(*parts)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    size = 0
                    with archive.open(info) as stream, output.open('xb') as destination:
                        while chunk := stream.read(65536):
                            size += len(chunk)
                            written += len(chunk)
                            if size > MAX_FILE_BYTES or written > MAX_TOTAL_BYTES:
                                raise ValueError('技能包解压大小超过限制')
                            destination.write(chunk)
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError) as exc:
            raise ValueError('技能 ZIP 无法读取或压缩格式不受支持') from exc
        except (FileExistsError, NotADirectoryError, IsADirectoryError) as exc:
            raise ValueError('技能包文件路径相互冲突') from exc
        except OSError as exc:
            raise ValueError('技能包无法解压，请检查文件路径及磁盘空间') from exc

    def read(self, file_id, path, offset=0) -> dict:
        relative = _safe_path(path)
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError('文本读取位置无效')
        root = self.root(file_id)
        target = root.joinpath(*relative.parts)
        if not target.resolve().is_relative_to(root.resolve()) or target.is_symlink():
            raise ValueError('技能资源路径越界')
        if not target.is_file():
            raise ValueError('技能资源不存在')
        text = _text(target)
        end = offset + MAX_READ_CHARS
        return {'path': relative.as_posix(), 'text': text[offset:end],
                'offset': offset, 'truncated': len(text) > end,
                'nextOffset': end if len(text) > end else None}

    def inspect(self, file_id) -> dict:
        root = self.root(file_id)
        record, source = self._source(file_id)
        content = _text(root / 'SKILL.md')
        metadata, instructions = {}, content
        lines = content.splitlines(keepends=True)
        if lines and lines[0].strip() == '---':
            closing = next((i for i in range(1, len(lines)) if lines[i].strip() in {'---', '...'}), None)
            if closing is None:
                raise ValueError('SKILL.md 元数据缺少结束标记')
            try:
                metadata = yaml.safe_load(''.join(lines[1:closing])) or {}
            except yaml.YAMLError as exc:
                raise ValueError('SKILL.md 元数据格式无效') from exc
            if not isinstance(metadata, dict):
                raise ValueError('SKILL.md 元数据必须为对象')
            instructions = ''.join(lines[closing + 1:]).strip()
        if not instructions.strip():
            raise ValueError('技能说明不能为空')
        original_name = str(record.get('metadata', {}).get('name') or source.name)
        name = metadata.get('name') or Path(original_name).stem
        description = metadata.get('description') or ''
        if not isinstance(name, str) or not isinstance(description, str):
            raise ValueError('技能名称和描述必须为文本')
        files, scripts, references = [], [], []
        for path in sorted(root.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if path.suffix.lower() in SCRIPT_EXTENSIONS:
                kind = 'script'
                scripts.append(relative)
            elif relative.startswith('references/'):
                kind = 'reference'
                references.append(relative)
            elif relative.startswith('assets/'):
                kind = 'asset'
            elif relative == 'SKILL.md':
                kind = 'instructions'
            else:
                kind = 'file'
            files.append({'path': relative, 'size': path.stat().st_size, 'kind': kind})
        requirements, missing, warnings = self._dependencies(root)
        if not scripts and missing:
            warnings.append('依赖尚未满足；当前技能仅含说明和资源，可继续读取。')
        return {'packageId': str(file_id), 'name': name.strip(), 'description': description.strip(),
                'instructions': instructions, 'files': files, 'scripts': scripts, 'references': references,
                'requirements': requirements, 'missingDependencies': missing,
                'status': 'blocked' if scripts and missing else 'ready', 'warnings': warnings}

    @staticmethod
    def _dependencies(root):
        requirements, missing, warnings = [], [], []
        for manifest in sorted(root.rglob('requirements.txt')):
            for raw in _text(manifest).splitlines():
                line = re.split(r'\s+#', raw, maxsplit=1)[0].strip()
                if not line or line.startswith('#'):
                    continue
                requirements.append(line)
                try:
                    requirement = Requirement(line)
                except InvalidRequirement:
                    missing.append(f'{line}（依赖声明不受支持，未运行安装命令）')
                    continue
                if requirement.marker and not requirement.marker.evaluate():
                    continue
                if requirement.url:
                    missing.append(f'{line}（外部依赖来源未验证）')
                    continue
                try:
                    installed = importlib.metadata.version(requirement.name)
                except importlib.metadata.PackageNotFoundError:
                    missing.append(line)
                    continue
                if requirement.specifier and not requirement.specifier.contains(installed, prereleases=True):
                    missing.append(f'{line}（当前版本 {installed}）')
                if requirement.extras:
                    # Optional groups can bring additional packages; do not infer readiness.
                    missing.append(f'{line}（可选依赖组尚未验证）')
        for manifest in sorted(root.rglob('package.json')):
            try:
                package = json.loads(_text(manifest))
                dependencies = package.get('dependencies', {})
                if not isinstance(dependencies, dict):
                    raise ValueError()
            except (json.JSONDecodeError, AttributeError, ValueError) as exc:
                raise ValueError('package.json 依赖声明格式无效') from exc
            for name, version in dependencies.items():
                declaration = f'{name}@{version}'
                requirements.append(declaration)
                if not isinstance(name, str) or not re.fullmatch(r'(?:@[a-z0-9_-][a-z0-9_.-]*/)?[a-z0-9_-][a-z0-9_.-]*', name):
                    missing.append(f'{declaration}（包名无效）')
                    continue
                installed_manifest = NODE_MODULES / name / 'package.json'
                if not installed_manifest.is_file():
                    missing.append(declaration)
                    continue
                try:
                    installed = json.loads(installed_manifest.read_text(encoding='utf-8')).get('version', '')
                except (OSError, ValueError):
                    missing.append(declaration)
                    continue
                if not _node_version_satisfies(installed, str(version)):
                    missing.append(f'{declaration}（当前版本 {installed}，版本要求未满足或不受支持）')
            if package.get('scripts'):
                warnings.append(f'{manifest.relative_to(root).as_posix()} 中的安装与生命周期命令不会自动执行。')
        return requirements, list(dict.fromkeys(missing)), warnings


def _node_version_satisfies(installed, requested):
    """Conservative, non-executing checks for common npm version declarations."""
    if requested in {'*', 'latest', ''}:
        return requested != 'latest'
    actual_match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', installed)
    wanted_match = re.fullmatch(r'([~^]?)(\d+)\.(\d+)\.(\d+)', requested)
    if not actual_match or not wanted_match:
        return False
    actual = tuple(map(int, actual_match.groups()))
    operator, *numbers = wanted_match.groups()
    wanted = tuple(map(int, numbers))
    if not operator:
        return actual == wanted
    if actual < wanted:
        return False
    if operator == '~':
        return actual[:2] == wanted[:2]
    if wanted[0]:
        return actual[0] == wanted[0]
    if wanted[1]:
        return actual[:2] == wanted[:2]
    return actual == wanted
