"""Per-run skill inputs, package resources and generated work files."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import re
import shutil
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from skill_artifacts import SkillArtifactService, safe_file, read_task_bytes, csv_rows, validate_structure

MAX_WORKSPACE = 100 * 1024 * 1024


class SkillWorkspace:
    def __init__(self, store, data_dir, task_id, run_id, refs):
        self.store = store
        self.data_dir = Path(data_dir).resolve()
        self.task_id, self.run_id, self.refs = task_id, run_id, refs
        self.root = self.data_dir / 'skill-runs' / hashlib.sha256(str(run_id).encode()).hexdigest()[:32]
        self.artifacts = SkillArtifactService(store, self.data_dir)
        self.prepared = False
        self.busy = False
        self.execution_lock = asyncio.Lock()
        self.packages = {}
        self.business_inputs = {}
        self.validation_reports = {}
        self.content_validation_reports = {}

    def capture_business_result(self, name, result):
        """Called only by trusted backend tools, never registered as a model tool."""
        def without_internal_fields(value):
            if isinstance(value, dict):
                blocked = {'storage_name', 'storage_path', 'api_key', 'apikey', 'authorization', 'access_token', 'password'}
                return {key: without_internal_fields(item) for key, item in value.items()
                        if key.lower() not in blocked}
            if isinstance(value, list):
                return [without_internal_fields(item) for item in value]
            return value
        snapshot = {'schemaVersion': 1,
                    'source': {'tool': name, 'capturedAt': datetime.now(timezone.utc).isoformat(),
                               'stateRevision': self.store.snapshot()['revision']},
                    'units': {'*Minor': 'CNY_fen', 'note': '原始字段与单位保留；非Minor金额按来源字段说明读取。'},
                    'result': without_internal_fields(result)}
        if name in {'list_materials', 'extract_expense_materials'}:
            snapshot['units']['items[].amount'] = 'CNY_fen'
        elif name == 'analyze_expenses':
            snapshot['units'].update({'items[].amount': 'CNY_yuan', 'total': 'CNY_yuan'})
        content = json.dumps(snapshot, ensure_ascii=False, allow_nan=False).encode('utf-8')
        if len(content) > 2 * 1024 * 1024 or sum(len(item['content']) for item in self.business_inputs.values()) + len(content) > 10 * 1024 * 1024:
            raise ValueError('业务结果超出工作区输入上限，请缩小查询范围。')
        digest = hashlib.sha256(content).hexdigest()
        relative = f'input/business/{len(self.business_inputs) + 1:03d}-{name}-{digest[:12]}.json'
        self.business_inputs[relative] = {'content': content, 'sha256': digest, 'sourceTool': name}
        if self.prepared:
            self._materialize_business_inputs()
        return {'path': relative, 'sourceTool': name, 'sha256': digest, 'readOnly': True}

    def _materialize_business_inputs(self):
        for relative, item in self.business_inputs.items():
            target = safe_file(self.root, relative, must_exist=False)
            target.parent.mkdir(mode=0o700, exist_ok=True)
            if not target.exists():
                # Inputs cannot be changed through the tool API or sandboxed scripts.
                with target.open('xb') as stream:
                    stream.write(item['content'])
                target.chmod(0o400)
            elif hashlib.sha256(read_task_bytes(self.root, relative)).hexdigest() != item['sha256']:
                raise ValueError('业务快照已变化，不能继续使用。')

    def prepare(self):
        if self.prepared:
            return
        for name in ('input', 'skills', 'work', 'output', 'tmp'):
            (self.root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        file_ids = set()
        for ref in self.refs:
            if ref.get('kind') == 'file':
                file_ids.add(ref.get('id'))
            elif ref.get('kind') == 'materials' and isinstance(ref.get('fileIds'), list):
                file_ids.update(ref['fileIds'])
            elif ref.get('kind') == 'materials':
                files = self.store.get_state()['data'].get('materials', {}).get('files', [])
                file_ids.update(f['id'] for f in files if f.get('batchId') == ref.get('id'))
        for file_id in sorted(x for x in file_ids if isinstance(x, str)):
            row = self.store.get_file(file_id)
            if not row:
                raise ValueError('引用文件没有可用的原件，请重新上传。')
            source = safe_file(self.data_dir / 'files', row['storage_name'])
            name = Path(row['metadata']['name']).name[:140]
            target = self.root / 'input' / (file_id + '-' + name)
            if not target.exists():
                shutil.copyfile(source, target)
            target.chmod(0o400)
        self.prepared = True
        self._materialize_business_inputs()
        self._check_quota()

    def add_package(self, skill, version):
        from skill_packages import SkillPackageService
        self.prepare()
        file_id = version.get('file', {}).get('id')
        if not file_id:
            return {'skillId': skill['id'], 'instructions': version.get('instructions') or skill.get('instructions', ''), 'files': []}
        service = SkillPackageService(self.store, self.data_dir)
        inspection = service.inspect(file_id)
        if inspection['status'] != 'ready':
            raise ValueError('技能依赖尚未就绪：' + '；'.join(inspection.get('missingDependencies', [])))
        folder = 'skill-' + hashlib.sha256((skill['id'] + version['version']).encode()).hexdigest()[:12]
        destination = self.root / 'skills' / folder
        if not destination.exists():
            shutil.copytree(service.root(file_id), destination)
        for path in destination.rglob('*'):
            if path.is_symlink():
                raise ValueError('技能资源不允许符号链接。')
            path.chmod(0o500 if path.is_dir() else 0o400)
        destination.chmod(0o500)
        info = {'skillId': skill['id'], 'version': version['version'], 'name': skill['title'],
                'instructions': inspection['instructions'], 'basePath': 'skills/' + folder,
                'files': inspection['files'], 'scripts': inspection.get('scripts', []),
                'references': inspection.get('references', [])}
        self.packages[skill['id']] = info
        self._check_quota()
        return info

    def _check_quota(self):
        entries = [p for p in self.root.rglob('*') if not p.is_symlink()]
        if len(entries) > 1000 or sum(p.stat().st_size for p in entries if p.is_file()) > MAX_WORKSPACE:
            raise ValueError('任务文件超过容量限制，请减少材料或输出。')

    def files(self):
        self.prepare()
        self._check_quota()
        return {'files': [{'path': p.relative_to(self.root).as_posix(), 'size': p.stat().st_size}
                          for p in sorted(self.root.rglob('*'))
                          if p.is_file() and not p.is_symlink() and p.relative_to(self.root).parts[0] != 'tmp'][:500],
                'artifacts': self.artifacts.list(self.task_id),
                'businessInputs': [{'path': path, 'sourceTool': item['sourceTool'], 'sha256': item['sha256'], 'readOnly': True}
                                   for path, item in self.business_inputs.items()]}

    def read(self, path, offset=0):
        self.prepare()
        source = safe_file(self.root, path)
        if source.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('文件较大，请使用脚本按需读取。')
        try:
            content = read_task_bytes(self.root, path, 2 * 1024 * 1024).decode('utf-8-sig')
        except UnicodeError:
            raise ValueError('这是二进制文件，请用相应文档库读取。') from None
        if '\x00' in content:
            raise ValueError('这是二进制文件，请用相应文档库读取。')
        offset = max(0, min(int(offset), len(content)))
        text = content[offset:offset + 24000]
        return {'path': path, 'text': text, 'offset': offset, 'nextOffset': offset + len(text), 'truncated': offset + len(text) < len(content)}

    def write(self, path, content):
        self.prepare()
        if self.busy:
            raise ValueError('脚本运行期间不能修改工作文件。')
        if not isinstance(content, str) or len(content.encode()) > 256 * 1024:
            raise ValueError('单次写入须为256KB以内的文本。')
        if not path.startswith(('work/', 'output/')):
            raise ValueError('只能写入 work/ 或 output/ 目录。')
        target = safe_file(self.root, path, must_exist=False)
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = Path(path).parts
            for part in parts[:-1]:
                try:
                    os.mkdir(part, 0o700, dir_fd=directory)
                except FileExistsError:
                    pass
                next_dir = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = next_dir
            descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                stream.write(content)
        except OSError:
            raise ValueError('工作文件路径已变化，不能写入。') from None
        finally:
            os.close(directory)
        self._check_quota()
        return {'path': path, 'size': target.stat().st_size, 'status': '已保存'}

    async def execute(self, path, args=None, timeout=60):
        from skill_executor import LocalSkillExecutor
        self.prepare()
        async with self.execution_lock:
            self.busy = True
            try:
                result = await LocalSkillExecutor().execute(self.root, path, args or [], timeout=timeout)
                self._check_quota()
                return {**result, 'files': self.files()['files']}
            finally:
                self.busy = False

    def publish(self, path):
        self.prepare()
        if self.busy:
            raise ValueError('请等待脚本结束后发布成果。')
        report = self.validation_reports.get(path)
        digest = hashlib.sha256(read_task_bytes(self.root, path)).hexdigest()
        content_report = self.content_validation_reports.get(digest)
        if content_report and content_report.get('status') == 'failed':
            # Renaming or copying known failed bytes cannot turn them into an
            # unchecked artifact. Correct content or explicitly recheck first.
            report = content_report
        if report and report.get('sourcePath') in self.business_inputs:
            source = report['sourcePath']
            if hashlib.sha256(read_task_bytes(self.root, source)).hexdigest() != self.business_inputs[source]['sha256']:
                raise ValueError('业务快照已变化，请重新读取业务数据。')
        item = self.artifacts.publish(self.root, path, self.task_id, self.run_id, report)
        status = ('金额已核对' if item['validation']['dataConsistency']['status'] == 'passed' else
                  '结构已校验' if item['validation']['structure']['status'] == 'passed' else '已生成')
        return {'artifact': item, 'cards': [{'kind': 'artifact', 'id': item['id'], 'title': item['name'], 'status': status,
                 'subtitle': f"{item['size'] / 1024:.1f} KB", 'data': {'artifactId': item['id'], 'validation': item['validation']}}]}

    def validate_artifact(self, path, snapshot_path, amount_column, amount_unit='yuan', sheet=None):
        """Explicit whole-column sum check against an authenticated business total."""
        self.prepare()
        if self.busy:
            raise ValueError('请等待脚本结束后核验成果。')
        if snapshot_path not in self.business_inputs:
            raise ValueError('只能使用当前运行由业务工具提供的只读业务快照。')
        snapshot_bytes = read_task_bytes(self.root, snapshot_path)
        source = self.business_inputs[snapshot_path]
        if hashlib.sha256(snapshot_bytes).hexdigest() != source['sha256']:
            raise ValueError('业务快照完整性校验失败，请重新读取业务数据。')
        snapshot = json.loads(snapshot_bytes)
        result = snapshot['result']
        expected = result.get('totalMinor')
        if expected is None and isinstance(result.get('result'), dict):
            expected = result['result'].get('totalMinor')
        if isinstance(expected, bool) or not re.fullmatch(r'-?\d+', str(expected)):
            raise ValueError('该业务快照没有明确的 totalMinor 合计，不能执行金额一致性核验。')
        if not path.startswith('output/') or Path(path).suffix.lower() not in {'.csv', '.xlsx'}:
            raise ValueError('金额核验支持 output/ 下的 CSV 或 XLSX。')
        if amount_unit not in {'yuan', 'fen'}:
            raise ValueError('金额单位须明确选择 yuan（元）或 fen（分）。')
        content = read_task_bytes(self.root, path)
        # An attempted check that cannot parse amounts must not be bypassed by
        # publishing the same file with a structure-only status.
        self.validation_reports[path] = {
            'status': 'failed', 'artifactSha256': hashlib.sha256(content).hexdigest(),
            'sourcePath': snapshot_path, 'sourceSha256': source['sha256'],
            'scope': '金额核验尚未通过，请修正数据并重新核验。'}
        self.content_validation_reports[self.validation_reports[path]['artifactSha256']] = self.validation_reports[path]
        suffix = Path(path).suffix.lower()
        validate_structure(content, suffix)
        if suffix == '.csv':
            rows = csv_rows(content)
        else:
            from openpyxl import load_workbook
            book = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
            try:
                if sheet is None and len(book.sheetnames) != 1:
                    raise ValueError('工作簿含多个工作表，请明确指定 sheet。')
                selected = sheet or book.sheetnames[0]
                if selected not in book.sheetnames:
                    raise ValueError('指定的工作表不存在。')
                rows = list(book[selected].iter_rows(values_only=True))
                sheet = selected
            finally:
                book.close()
        headers = [str(cell).strip() if cell is not None else '' for cell in rows[0]] if rows else []
        if not amount_column or headers.count(amount_column) != 1:
            raise ValueError('金额列须在首行表头中唯一存在。')
        column = headers.index(amount_column)
        total, count = 0, 0
        for number, row in enumerate(rows[1:], 2):
            if not any(cell is not None and str(cell).strip() for cell in row):
                continue
            value = row[column] if column < len(row) else None
            try:
                text = str(value).strip()
                if not re.fullmatch(r'[+-]?\d+(?:\.\d+)?', text):
                    raise InvalidOperation()
                minor = Decimal(text) * (100 if amount_unit == 'yuan' else 1)
                if not minor.is_finite() or minor != minor.to_integral_value() or abs(minor) > 10 ** 18:
                    raise InvalidOperation()
            except InvalidOperation:
                raise ValueError(f'第 {number} 行金额无效；不接受空值、未计算公式或不足一分的金额。') from None
            total += int(minor)
            count += 1
        if not count:
            raise ValueError('成果没有可核验的金额明细。')
        report = {'status': 'passed' if total == int(expected) else 'failed',
                  'scope': '仅核对所选金额列全部明细之和与来源 totalMinor，不代表逐笔业务或版面验收。',
                  'expectedTotalMinor': str(expected), 'actualTotalMinor': str(total), 'rowCount': count,
                  'amountColumn': amount_column, 'amountUnit': amount_unit, 'sheet': sheet,
                  'sourcePath': snapshot_path, 'sourceTool': source['sourceTool'], 'sourceSha256': source['sha256'],
                  'artifactSha256': hashlib.sha256(content).hexdigest(), 'checkedAt': datetime.now(timezone.utc).isoformat()}
        if report['status'] == 'failed':
            report['error'] = '成果金额与业务快照不一致，请修正后重新核验。'
        self.validation_reports[path] = report
        self.content_validation_reports[report['artifactSha256']] = report
        return report

    def import_artifact(self, artifact_id):
        self.prepare()
        item = self.artifacts.get(artifact_id)
        if item['taskId'] != self.task_id:
            raise ValueError('只能读取当前会话生成的文件。')
        relative = 'input/' + item['id'] + '-' + item['name']
        destination = safe_file(self.root, relative, must_exist=False)
        shutil.copyfile(self.artifacts.path(artifact_id), destination)
        destination.chmod(0o400)
        self._check_quota()
        return {'path': relative, 'name': item['name']}
