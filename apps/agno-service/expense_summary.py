"""CSV expense aggregation shared by the HTTP routes and Agno tools."""
from __future__ import annotations

import csv
import hashlib
import io
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import config

TOOL_ID = 'expense-summary'
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_ROWS = 10000
CATEGORY_HEADERS = {'费用类型', '费用类别', '类别', 'category', 'expense_category', 'expense_type'}
AMOUNT_HEADERS = {'金额', '费用金额', 'amount'}
AMOUNT_PATTERN = re.compile(r'[+-]?[0-9]{1,15}(?:\.[0-9]{1,2})?\Z')


def _read_content(file):
    metadata = file['metadata']
    if Path(metadata['name']).suffix.lower() != '.csv':
        raise ValueError('费用汇总仅支持 CSV 文件。')
    if metadata.get('size', 0) > MAX_FILE_BYTES:
        raise ValueError('CSV 文件大小不能超过 2 MiB。')
    directory = (config.DATA_DIR / 'files').resolve()
    target = (directory / file['storage_name']).resolve()
    if not target.is_relative_to(directory):
        raise ValueError('CSV 文件存储信息无效，请重新上传。')
    if target.is_file():
        with target.open('rb') as stream:
            content = stream.read(MAX_FILE_BYTES + 1)
        if len(content) > MAX_FILE_BYTES:
            raise ValueError('CSV 文件大小不能超过 2 MiB。')
        if metadata.get('sha256') and hashlib.sha256(content).hexdigest() != metadata['sha256']:
            raise ValueError('CSV 原件完整性校验失败，请重新上传。')
        return content

    # Existing uploads retain at most 60000 text characters. Never aggregate a preview.
    text = metadata.get('text', '')
    if not text or len(text) >= 60000 or metadata.get('truncated') or metadata.get('textTruncated'):
        raise ValueError('无法读取完整 CSV 原件，请重新上传。')
    for encoding in ('utf-8', 'utf-8-sig', 'gb18030'):
        try:
            content = text.encode(encoding)
        except UnicodeEncodeError:
            continue
        if len(content) != metadata.get('size'):
            continue
        if metadata.get('sha256') and hashlib.sha256(content).hexdigest() != metadata['sha256']:
            continue
        return content
    raise ValueError('无法确认 CSV 文本完整性，请重新上传。')


def _parse_csv(content):
    text = None
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            text = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None or '\x00' in text:
        raise ValueError('CSV 编码无效，请使用 UTF-8 或 GB18030 编码。')
    reader = csv.reader(io.StringIO(text, newline=''), strict=True)
    groups = {}
    rows = []
    try:
        headers = next(reader, [])
        normalized = [header.strip().lower() for header in headers]
        category_columns = [i for i, name in enumerate(normalized) if name in CATEGORY_HEADERS]
        amount_columns = [i for i, name in enumerate(normalized) if name in AMOUNT_HEADERS]
        if len(category_columns) != 1 or len(amount_columns) != 1:
            raise ValueError('CSV 须包含唯一的“费用类型”和“金额”列，或 category 和 amount 列。')
        category_column, amount_column = category_columns[0], amount_columns[0]
        while True:
            line_number = reader.line_num + 1
            fields = next(reader, None)
            if fields is None:
                break
            if not fields:
                continue
            if len(rows) >= MAX_ROWS:
                raise ValueError(f'CSV 最多包含 {MAX_ROWS} 条费用。')
            if len(fields) != len(headers):
                raise ValueError(f'第 {line_number} 行列数与表头不一致。')
            category = fields[category_column].strip()
            if not category or len(category) > 200:
                raise ValueError(f'第 {line_number} 行费用类型须填写 1 至 200 个字符。')
            amount = fields[amount_column].strip()
            if not AMOUNT_PATTERN.fullmatch(amount):
                raise ValueError(f'第 {line_number} 行金额无效，请填写最多 15 位整数、2 位小数的金额。')
            amount_minor = int(Decimal(amount) * 100)
            group = groups.setdefault(category, {'name': category, 'amountMinor': 0, 'count': 0})
            group['amountMinor'] += amount_minor
            group['count'] += 1
            rows.append({'lineNumber': line_number, 'category': category, 'amountMinor': str(amount_minor)})
    except csv.Error as error:
        raise ValueError(f'第 {reader.line_num} 行 CSV 格式无效，请检查引号和分隔符。') from error
    if not rows:
        raise ValueError('CSV 没有费用记录，请填写数据后重新上传。')
    return rows, [{**group, 'amountMinor': str(group['amountMinor'])} for group in groups.values()]


def list_results(store):
    results = store.get_state().get('data', {}).get('toolResults', {})
    values = results.values() if isinstance(results, dict) else results
    return sorted(
        (_with_display_amounts(result) for result in values if result.get('toolId') == TOOL_ID),
        key=lambda result: result['createdAt'], reverse=True,
    )


def get_result(store, result_id):
    result = next((item for item in list_results(store) if item['id'] == result_id), None)
    if result is None:
        raise ValueError('结果不存在。')
    return result


def _csv_input(store, file_id):
    file = store.get_file(file_id)
    if file is None:
        raise ValueError('文件不存在。')
    content = _read_content(file)
    return file, content


def _calculate(file, content):
    rows, groups = _parse_csv(content)
    return _with_display_amounts({
        'toolId': TOOL_ID, 'fileId': file['metadata']['id'], 'fileName': file['metadata']['name'],
        'rowCount': len(rows), 'totalMinor': str(sum(int(row['amountMinor']) for row in rows)),
        'groups': groups, 'rows': rows,
    })


def preview_csv(store, file_id):
    """Read and total the original CSV without creating a tool-result record."""
    file, content = _csv_input(store, file_id)
    return {'result': _calculate(file, content), 'cards': [{
        'kind': 'materials', 'id': file_id, 'title': file['metadata']['name'],
        'data': {'fileIds': [file_id]}, 'status': '汇总来源',
    }]}


def summarize_csv(store, file_id):
    file, content = _csv_input(store, file_id)
    fingerprint = hashlib.sha256(file_id.encode() + b'\x00' + content).hexdigest()
    result_id = 'expense-summary-' + fingerprint[:24]
    previous = next((item for item in list_results(store) if item['id'] == result_id), None)
    if previous is None:
        result = {**_calculate(file, content), 'id': result_id, 'createdAt': datetime.now(timezone.utc).isoformat()}

        def persist(state):
            results = state.setdefault('data', {}).setdefault('toolResults', {})
            if isinstance(results, list):
                results = {item['id']: item for item in results}
                state['data']['toolResults'] = results
            return results.setdefault(result_id, result)

        previous = store.mutate(persist)
    return {'result': _with_display_amounts(previous), 'cards': [{'kind': 'tool', 'id': previous['id'], 'title': '费用汇总', 'status': '已完成'}]}


def _format_minor(value):
    amount = int(value)
    sign = '-' if amount < 0 else ''
    major, minor = divmod(abs(amount), 100)
    return f'{sign}{major}.{minor:02d}'


def _with_display_amounts(result):
    """Enrich historical results with unambiguous yuan display values."""
    return {
        **result,
        'currency': 'CNY',
        'amountUnit': '分',
        'total': _format_minor(result['totalMinor']),
        'displayHint': '展示金额使用 total 和 groups[].amount，单位为元。totalMinor 和 amountMinor 的单位为分。',
        'groups': [{**group, 'amount': _format_minor(group['amountMinor'])} for group in result['groups']],
        'rows': [{**row, 'amount': _format_minor(row['amountMinor'])} for row in result['rows']],
    }


def export_result_csv(store, result_id):
    result = get_result(store, result_id)
    stream = io.StringIO(newline='')
    writer = csv.writer(stream)
    writer.writerow(['费用类型', '金额', '条数'])
    for group in result['groups']:
        name = group['name']
        if name.lstrip().startswith(('=', '+', '-', '@')) or name.startswith(('\t', '\r', '\n')):
            name = "'" + name
        writer.writerow([name, _format_minor(group['amountMinor']), group['count']])
    writer.writerow(['合计', _format_minor(result['totalMinor']), result['rowCount']])
    return stream.getvalue().encode('utf-8-sig')
