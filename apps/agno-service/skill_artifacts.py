"""Durable, immutable results of local skill jobs; never serve arbitrary paths."""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import mimetypes
import os
import stat
import shutil
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

ALLOWED = {'.pptx', '.xlsx', '.docx', '.pdf', '.csv', '.txt', '.md', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.html', '.zip'}
TEXT = {'.csv', '.txt', '.md', '.json', '.yaml', '.yml'}
OFFICE = {'.pptx', '.xlsx', '.docx'}
MAX_BYTES = 25 * 1024 * 1024


def csv_rows(content):
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            decoded = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError('CSV 编码无法读取，请使用 UTF-8 或 GB18030。')
    if any(ord(char) < 32 and char not in '\t\r\n' for char in decoded):
        raise ValueError('CSV 格式无效，文件含有二进制内容。')
    try:
        rows = [row for row in csv.reader(io.StringIO(decoded, newline=''), strict=True) if row]
    except csv.Error:
        raise ValueError('CSV 格式无效，请检查引号和分隔符。') from None
    if not rows or not any(cell.strip() for cell in rows[0]) or any(len(row) != len(rows[0]) for row in rows):
        raise ValueError('CSV 格式无效，表头为空或列数不一致。')
    if len(rows) > 100001 or sum(map(len, rows)) > 500000:
        raise ValueError('CSV 内容超出结构校验上限，请拆分文件。')
    return rows


def validate_structure(content, suffix):
    """Check real parsability, without claiming business or visual correctness."""
    details = {}
    try:
        if suffix in OFFICE:
            with zipfile.ZipFile(io.BytesIO(content)) as package:
                members = package.infolist()
                if len(members) > 5000 or sum(member.file_size for member in members) > 100 * 1024 * 1024:
                    raise ValueError('文档解压后内容超出校验上限。')
                names = {member.filename for member in members}
                required = {'.xlsx': 'xl/workbook.xml', '.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml'}[suffix]
                if not {'[Content_Types].xml', '_rels/.rels', required} <= names or len(names) != len(members):
                    raise ValueError('文档格式与扩展名不符或文件损坏。')
                if package.testzip() is not None:
                    raise ValueError('文档压缩内容损坏。')
                for member in members:
                    if member.filename.endswith(('.xml', '.rels')):
                        xml = package.read(member)
                        if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml:
                            raise ValueError('文档 XML 格式不受支持。')
                        ElementTree.fromstring(xml)
            if suffix == '.xlsx':
                from openpyxl import load_workbook
                book = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
                try:
                    count = 0
                    for sheet in book:
                        if (sheet.max_row or 0) * (sheet.max_column or 0) > 500000:
                            raise ValueError('表格内容超出结构校验上限。')
                        for row in sheet.iter_rows():
                            count += len(row)
                            if count > 500000:
                                raise ValueError('表格内容超出结构校验上限。')
                    details = {'sheets': len(book.sheetnames), 'cells': count}
                finally:
                    book.close()
            elif suffix == '.docx':
                from docx import Document
                document = Document(io.BytesIO(content))
                details = {'paragraphs': len(document.paragraphs), 'tables': len(document.tables)}
            else:
                from pptx import Presentation
                presentation = Presentation(io.BytesIO(content))
                details = {'slides': len(presentation.slides)}
        elif suffix == '.pdf':
            from pypdf import PdfReader
            if not content.startswith(b'%PDF-') or b'%%EOF' not in content[-1024:]:
                raise ValueError('PDF 格式无效或文件损坏。')
            reader = PdfReader(io.BytesIO(content), strict=True)
            if reader.is_encrypted or not 0 < len(reader.pages) <= 1000:
                raise ValueError('PDF 无法读取：文件加密、没有页面或超过1000页。')
            for page in reader.pages:
                stream = page.get_contents()
                if stream is not None:
                    stream.get_data()
            details = {'pages': len(reader.pages)}
        elif suffix == '.csv':
            rows = csv_rows(content)
            details = {'rows': len(rows) - 1, 'columns': len(rows[0])}
        elif suffix == '.json':
            json.loads(content)
        elif suffix in TEXT:
            content.decode('utf-8-sig')
        else:
            return {'status': 'not_checked', 'scope': '已确认文件非空；该格式未执行结构校验。'}
    except ValueError:
        raise
    except Exception:
        raise ValueError(f'{suffix.lstrip(".").upper()} 格式无法读取或文件已损坏，请重新生成。') from None
    return {'status': 'passed', 'scope': '文件格式与结构可读取，不代表业务内容或版面已验收。', **details}


def safe_file(root: Path, relative: str, *, must_exist=True) -> Path:
    if not isinstance(relative, str) or not relative or '\\' in relative or '\x00' in relative:
        raise ValueError('文件路径无效。')
    p = PurePosixPath(relative)
    if p.is_absolute() or any(x in {'.', '..', ''} for x in relative.split('/')):
        raise ValueError('文件路径须位于当前任务目录内。')
    root = root.resolve()
    target = root.joinpath(*p.parts)
    current = root
    for part in p.parts:
        current /= part
        if current.is_symlink():
            raise ValueError('不允许使用符号链接。')
    if not target.resolve().is_relative_to(root):
        raise ValueError('文件路径超出当前任务。')
    if must_exist and not target.is_file():
        raise ValueError('文件不存在。')
    return target


def read_task_bytes(root: Path, relative: str, limit=MAX_BYTES) -> bytes:
    """Open every component without following links, including concurrent replacements."""
    safe_file(root, relative)
    directory = os.open(root.resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    try:
        parts = PurePosixPath(relative).parts
        for part in parts[:-1]:
            next_dir = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_dir
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('文件类型或大小不符合限制。')
        with os.fdopen(descriptor, 'rb') as stream:
            descriptor = None
            content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError('文件超过大小限制。')
        return content
    except OSError:
        raise ValueError('文件已变化或不是可读取的普通文件。') from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


class SkillArtifactService:
    def __init__(self, store, data_dir):
        self.store = store
        self.data_dir = Path(data_dir).resolve()
        self.directory = self.data_dir / 'skill-artifacts'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.preview_locks = {}
        with store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS skill_artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, metadata TEXT NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS skill_artifacts_task ON skill_artifacts(task_id)')

    def get(self, artifact_id):
        with self.store.connect() as db:
            row = db.execute('SELECT metadata FROM skill_artifacts WHERE id=?', (artifact_id,)).fetchone()
        if not row:
            raise ValueError('生成文件不存在。')
        return json.loads(row['metadata'])

    def list(self, task_id):
        with self.store.connect() as db:
            rows = db.execute('SELECT metadata FROM skill_artifacts WHERE task_id=? ORDER BY rowid DESC LIMIT 100', (task_id,)).fetchall()
        return [json.loads(row['metadata']) for row in rows]

    def path(self, artifact_id):
        item = self.get(artifact_id)
        return safe_file(self.directory, item['id'] + '/' + item['name'])

    def publish(self, workspace, relative, task_id, run_id, data_validation=None):
        if not relative.startswith('output/'):
            raise ValueError('请将成果保存到 output/ 目录后再发布。')
        source = safe_file(Path(workspace), relative)
        if source.suffix.lower() not in ALLOWED:
            raise ValueError('该类型不能作为生成成果发布。')
        if not 0 < source.stat().st_size <= MAX_BYTES:
            raise ValueError('成果须非空，且单个文件不超过25MB。')
        if len(source.name) > 160:
            raise ValueError('成果文件名过长，请缩短至160字以内。')
        existing = [item for item in self.list(task_id) if item['runId'] == run_id]
        content = read_task_bytes(Path(workspace), relative)
        if not content:
            raise ValueError('成果文件为空。')
        digest = hashlib.sha256(content).hexdigest()
        structure = validate_structure(content, source.suffix.lower())
        if data_validation:
            if data_validation.get('artifactSha256') != digest:
                raise ValueError('成果在金额核验后已变化，请重新核验。')
            if data_validation.get('status') != 'passed':
                raise ValueError('成果金额与业务快照不一致，请修正并重新核验。')
        for item in existing:
            prior_validation = item.get('validation', {}).get('dataConsistency')
            same_validation = (prior_validation == data_validation if data_validation else
                               prior_validation is None or prior_validation.get('status') == 'not_checked')
            if item['name'] == source.name and item['sha256'] == digest and same_validation:
                return item
        if len(existing) >= 30:
            raise ValueError('单次任务最多发布30个成果。')
        identifier = 'artifact-' + uuid.uuid4().hex
        target = self.directory / identifier
        target.mkdir(mode=0o700)
        (target / source.name).write_bytes(content)
        (target / source.name).chmod(0o600)
        suffix = source.suffix.lower()
        preview = 'text' if suffix in TEXT else 'html' if suffix == '.html' else 'pdf' if suffix == '.pdf' or suffix in OFFICE else 'image' if suffix in {'.png', '.jpg', '.jpeg', '.webp'} else 'none'
        item = {'id': identifier, 'name': source.name, 'size': len(content),
                'mimeType': mimetypes.guess_type(source.name)[0] or 'application/octet-stream',
                'taskId': task_id, 'runId': run_id, 'sha256': digest,
                'createdAt': datetime.now(timezone.utc).isoformat(), 'previewKind': preview,
                'previewStatus': 'pending' if suffix in OFFICE else 'ready', 'warnings': [],
                'validation': {'structure': structure,
                    'dataConsistency': data_validation or {'status': 'not_checked', 'scope': '未执行与业务来源的数据一致性核验。'},
                    'visual': {'status': 'not_checked', 'scope': '未执行版面视觉验收。'}}}
        if preview == 'text':
            decoded = content.decode('utf-8', errors='replace')
            item['text'] = decoded[:60000]
            item['truncated'] = len(decoded) > 60000
            if item['truncated']:
                item['warnings'].append('预览仅显示前60000字符，下载可查看完整内容。')
        with self.store.connect() as db:
            db.execute('INSERT INTO skill_artifacts VALUES(?,?,?,?)', (identifier, task_id, run_id, json.dumps(item, ensure_ascii=False)))
        return item

    def _save(self, item):
        with self.store.connect() as db:
            db.execute('UPDATE skill_artifacts SET metadata=? WHERE id=?', (json.dumps(item, ensure_ascii=False), item['id']))

    async def prepare_preview(self, artifact_id):
        lock = self.preview_locks.setdefault(artifact_id, asyncio.Lock())
        async with lock:
            item = self.get(artifact_id)
            if item['previewStatus'] not in {'pending', 'failed'}:
                return item
            from skill_executor import LocalSkillExecutor
            workspace = self.data_dir / 'skill-previews' / artifact_id
            for name in ('input', 'work', 'output', 'tmp', 'skills'):
                (workspace / name).mkdir(parents=True, exist_ok=True, mode=0o700)
            source = self.path(artifact_id)
            shutil.copyfile(source, workspace / 'input' / source.name)
            code = """import os, pathlib, subprocess
source = next(pathlib.Path('input').iterdir())
binary = os.environ.get('SOFFICE_BIN')
if not binary:
    raise RuntimeError('当前环境缺少文档预览程序')
profile = pathlib.Path('tmp/office-profile').resolve().as_uri()
subprocess.run([binary, '-env:UserInstallation=' + profile, '--headless', '--convert-to', 'pdf', '--outdir', 'output', str(source)], check=True, timeout=80)
"""
            (workspace / 'work' / 'preview.py').write_text(code)
            try:
                result = await LocalSkillExecutor().execute(workspace, 'work/preview.py', [], timeout=90)
                if result.get('status') != 'success' or result.get('exitCode') != 0:
                    raise ValueError('预览转换未完成。')
                content = read_task_bytes(workspace, 'output/' + source.stem + '.pdf')
                if not content:
                    raise ValueError('预览转换文件为空。')
                validate_structure(content, '.pdf')
                (self.directory / artifact_id / '_preview.pdf').write_bytes(content)
                item.update(previewKind='pdf', previewStatus='ready', warnings=[])
            except asyncio.CancelledError:
                raise
            except Exception:
                item.update(previewKind='none', previewStatus='failed', warnings=['暂时无法生成在线预览，可以下载原文件查看。'])
            finally:
                shutil.rmtree(workspace, ignore_errors=True)
            self._save(item)
            return item

    def preview_path(self, artifact_id):
        item = self.get(artifact_id)
        if item['previewStatus'] != 'ready' or item['previewKind'] == 'none':
            raise ValueError('该文件暂无在线预览。')
        if Path(item['name']).suffix.lower() in OFFICE:
            return safe_file(self.directory, artifact_id + '/_preview.pdf'), 'application/pdf'
        return self.path(artifact_id), item['mimeType']
