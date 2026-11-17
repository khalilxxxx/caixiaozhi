"""Small evidence checks for the current run, never a second planning agent."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import PurePosixPath


# Deliberately narrow: an explicit creation request at the beginning of a clause.
# Questions, quoted examples and discussion of file formats are not file orders.
_CREATE_FILE = re.compile(
    r'^(?:(?:请|麻烦|能否|可以|能)(?:你)?\s*)?(?:(?:帮我|给我|为我)\s*)?'
    r'(?:生成|制作|创建|导出|保存|输出|做(?:一份|一个|一张))(?!方法|方式|流程|步骤|原理)'
    r'[^。！？\n]{0,64}?(?:pptx?|excel|xlsx?|pdf|docx?|word|csv|文件|演示文稿|幻灯片|电子表格)', re.I)


def explicitly_requests_file(message):
    text = str(message or '').strip()
    match = _CREATE_FILE.search(text)
    if not match:
        return False
    tail = text[match.end():]
    if re.search(r'(?:的方法|的步骤|的流程|的原理|需要什么|需要哪些|要用什么|怎么|如何|是什么|有什么区别)', tail):
        return False
    return True


_FORMATS = {
    'excel': 'xlsx', 'xls': 'xlsx', 'xlsx': 'xlsx', '电子表格': 'xlsx',
    'ppt': 'pptx', 'pptx': 'pptx', '演示文稿': 'pptx', '幻灯片': 'pptx',
    'word': 'docx', 'doc': 'docx', 'docx': 'docx', 'pdf': 'pdf', 'csv': 'csv',
}
_FORMAT_TOKEN = re.compile(r'(?<![a-z])(?:excel|xlsx?|pptx?|docx?|word|pdf|csv)(?![a-z])|电子表格|演示文稿|幻灯片', re.I)
_QUANTITY = r'([1-9]\d?|[一二两三四五六七八九十])\s*(?:个|份|张)\s*'
_NUMBERS = dict(zip('一二两三四五六七八九十', (1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10)))
_DOCUMENT_SUFFIXES = {'.csv', '.xls', '.xlsx', '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.txt', '.md', '.json'}


def _quantity(value):
    return int(value) if value.isdigit() else _NUMBERS[value]


def explicit_delivery_requirements(message):
    """Check only direct, explicit quantities/types in the creation clause.

    References in later clauses and working files are not a delivery manifest.
    This intentionally does not infer an arbitrary project plan from prose.
    """
    clause = re.split(r'[，,；;。！？\n]|根据|参考|使用|基于', str(message), maxsplit=1)[0]
    formats = {}
    for match in _FORMAT_TOKEN.finditer(clause):
        prefix = clause[:match.start()]
        count = re.search(_QUANTITY + r'$', prefix)
        family = _FORMATS[match.group().lower()]
        formats[family] = max(formats.get(family, 0), _quantity(count[1]) if count else 1)
    generic = re.search(_QUANTITY + r'(?:文件|成果)', clause)
    minimum = max(1, _quantity(generic[1]) if generic else 0, sum(formats.values()))
    return minimum, formats


def _document_output(path):
    path = PurePosixPath(str(path or ''))
    return bool(path.parts and path.parts[0] == 'output' and path.suffix.lower() in _DOCUMENT_SUFFIXES
                and not any(part in {'tmp', 'work'} for part in path.parts))


class CompletionCheck:
    def __init__(self, request):
        self.file_requested = explicitly_requests_file(request.get('message'))
        self.minimum_files, self.required_formats = explicit_delivery_requirements(request.get('message', '')) if self.file_requested else (0, {})
        self.generation_started = False
        self.failures = {}

    def observe(self, name, key, result, status):
        if name == 'publish_skill_artifact' or (name == 'write_skill_file' and _document_output(result.get('path'))):
            self.generation_started = True
        if name == 'run_skill_script' and any(_document_output(item.get('path')) for item in result.get('files', []) if isinstance(item, dict)):
            self.generation_started = True
        if status == 'failed':
            self.failures[key] = {
                'name': name,
                'recoverableOutput': name == 'run_skill_script' and result.get('status') == 'resource_limit'
                    and result.get('exitCode') == 0 and any(
                        _document_output(item.get('path')) for item in result.get('files', [])
                        if isinstance(item, dict)),
            }
        elif status == 'completed':
            self.failures.pop(key, None)

    def issue(self, artifacts=()):
        # One artifact shown twice, or several revisions of the same filename,
        # cannot satisfy a request for distinct files. Only verified current-run
        # artifact records are supplied by Runtime.
        delivered = {item['name']: item for item in artifacts if item.get('id') and item.get('name')}
        delivered_file = bool(delivered)
        if (self.file_requested or self.generation_started) and not delivered_file:
            return '文件尚未生成并交付，已保存的内容仍保留，请继续处理。'
        counts = Counter(_FORMATS.get(PurePosixPath(name).suffix.lstrip('.').lower(), '') for name in delivered)
        if len(delivered) < self.minimum_files or any(counts[family] < count for family, count in self.required_formats.items()):
            return '所需文件尚未全部交付，已生成的文件仍保留，请继续完成剩余成果。'
        # A separately validated, persisted output can salvage a script that
        # produced a valid file before hitting a resource limit. Other failures
        # still require a successful retry of the same operation.
        unresolved = [failure for failure in self.failures.values()
                      if not (delivered_file and failure['recoverableOutput'])]
        if unresolved:
            return '部分操作未完成，已保存的内容仍保留，请重试未完成步骤。'
        return None
