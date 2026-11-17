"""Generate an Excel workbook from JSON or CSV with explicit data types."""
from collections import OrderedDict
from decimal import Decimal, InvalidOperation
from pathlib import Path
import csv
import io
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

INK, BLUE, PALE = '24354C', '315F8E', 'EFF3F7'
FONT = 'Hiragino Sans GB'


def number(value, label):
    if value is None or value == '':
        return None
    try:
        parsed = Decimal(str(value).replace(',', '').strip())
    except InvalidOperation as error:
        raise ValueError(f'{label}不是有效数值。') from error
    if not parsed.is_finite() or abs(parsed) > Decimal('1000000000000000'):
        raise ValueError(f'{label}不是有限数值或超出范围。')
    return parsed


def literal(cell, value):
    cell.value = '' if value is None else str(value)
    cell.data_type = 's'
    cell.alignment = Alignment(vertical='center', wrap_text=True)


def input_content(source):
    if source.stat().st_size > 5 * 1024 * 1024:
        raise ValueError('输入文件不能超过5MB。')
    if source.suffix.lower() != '.csv':
        result = json.loads(source.read_text(encoding='utf-8-sig'))
        if not isinstance(result, dict):
            raise ValueError('输入JSON根节点必须是对象。')
        return result
    content = source.read_bytes()
    try:
        raw = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        raw = content.decode('gb18030')
    reader = csv.DictReader(io.StringIO(raw))
    headers = reader.fieldnames
    if not headers or len(set(headers)) != len(headers) or any(not label for label in headers):
        raise ValueError('CSV表头不能为空或重复。')
    rows = list(reader)
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError('CSV每行列数必须与表头一致。')
    columns = []
    for label in headers:
        values = [row[label].strip() for row in rows if row[label].strip()]
        numeric = bool(values) and all(re.fullmatch(r'[-+]?(?:0|[1-9]\d*)(?:\.\d+)?', value) for value in values)
        columns.append({'key': label, 'label': label, 'type': 'number' if numeric else 'text'})
    return {'title': source.stem, 'source': '来源：' + source.name, 'columns': columns, 'rows': rows}


def heading(sheet, title, source, width):
    sheet.sheet_view.showGridLines = False
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(width, 2))
    literal(sheet.cell(1, 1), title)
    sheet.cell(1, 1).font = Font(name=FONT, size=18, bold=True, color=INK)
    sheet.row_dimensions[1].height = 32
    sheet.merge_cells(start_row=2, start_column=1, end_row=2, end_column=max(width, 2))
    literal(sheet.cell(2, 1), source)
    sheet.cell(2, 1).font = Font(name=FONT, size=10, color='667184')
    sheet.row_dimensions[2].height = 27
    sheet.freeze_panes = 'A5'
    sheet.print_title_rows = '1:4'


def table_style(sheet, headers, last_row, name):
    for index, label in enumerate(headers, 1):
        cell = sheet.cell(4, index)
        literal(cell, label)
        cell.font = Font(name=FONT, bold=True, color='FFFFFF', size=11)
        cell.fill = PatternFill('solid', fgColor=INK)
        cell.alignment = Alignment(vertical='center', wrap_text=True)
        sheet.column_dimensions[get_column_letter(index)].width = min(38, max(18, len(label) * 2 + 5))
    sheet.row_dimensions[4].height = 28
    table = Table(displayName=name, ref=f'A4:{get_column_letter(len(headers))}{last_row}')
    table.tableStyleInfo = TableStyleInfo(name='TableStyleMedium2', showRowStripes=True)
    sheet.add_table(table)
    for row in sheet.iter_rows(min_row=5, max_row=last_row, max_col=len(headers)):
        for cell in row:
            cell.font = Font(name=FONT, size=11, color=INK)
            cell.alignment = Alignment(vertical='center', wrap_text=True)
        sheet.row_dimensions[row[0].row].height = 27
    sheet.sheet_properties.pageSetUpPr.fitToPage = True
    sheet.page_setup.orientation = 'landscape'
    sheet.page_setup.paperSize = sheet.PAPERSIZE_A4
    sheet.page_setup.fitToWidth, sheet.page_setup.fitToHeight = 1, 0
    sheet.print_options.horizontalCentered = True


def build(content, destination):
    columns, rows = content.get('columns'), content.get('rows')
    if not isinstance(columns, list) or not 1 <= len(columns) <= 30:
        raise ValueError('columns需要包含1至30列。')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 10000:
        raise ValueError('rows需要包含1至10000行。')
    if any(not isinstance(column, dict) for column in columns):
        raise ValueError('columns中每列必须是JSON对象。')
    keys = [column.get('key') for column in columns]
    if any(not isinstance(key, str) or not key for key in keys) or len(set(keys)) != len(keys):
        raise ValueError('列key不能为空或重复。')
    labels = [str(column.get('label') or column['key']) for column in columns]
    if len(set(labels)) != len(labels):
        raise ValueError('列名称不能重复。')
    if any(column.get('type', 'text') not in {'text', 'number'} for column in columns):
        raise ValueError('列type仅支持text或number。日期请保留为text。')
    title, source = str(content.get('title') or '数据明细'), str(content.get('source') or '')
    workbook = Workbook()
    workbook.calculation.fullCalcOnLoad = True
    detail = workbook.active
    detail.title = '明细'
    heading(detail, title, source, len(columns))
    converted = []
    for row_index, row in enumerate(rows, 5):
        if not isinstance(row, dict):
            raise ValueError('每行数据必须是JSON对象。')
        values = {}
        for col_index, column in enumerate(columns, 1):
            key = column['key']
            value = row.get(key)
            cell = detail.cell(row_index, col_index)
            if column.get('type') == 'number':
                value = number(value, f'第{row_index - 4}行“{labels[col_index - 1]}”')
                cell.value = float(value) if value is not None else None
                cell.number_format = '#,##0.00;[Red]-#,##0.00'
            else:
                literal(cell, value)
            values[key] = value
        converted.append(values)
    table_style(detail, labels, len(rows) + 4, 'DetailData')
    summary = content.get('summary')
    if summary:
        if not isinstance(summary, dict):
            raise ValueError('summary必须是指定分组与数值字段的对象。')
        group_key, value_key = summary.get('groupBy'), summary.get('valueKey')
        if group_key not in keys or value_key not in keys:
            raise ValueError('汇总字段必须出现在columns中。')
        if columns[keys.index(value_key)].get('type') != 'number':
            raise ValueError('汇总数值字段必须明确设置type为number。')
        groups = OrderedDict()
        missing = {}
        for row in converted:
            group = str(row[group_key] if row[group_key] not in (None, '') else '未填写')
            groups.setdefault(group, None)
            missing.setdefault(group, 0)
            if row[value_key] is None:
                missing[group] += 1
            else:
                groups[group] = (groups[group] or Decimal(0)) + row[value_key]
        has_missing = any(missing.values())
        sheet = workbook.create_sheet('汇总')
        heading(sheet, title + ' · 汇总', source, 3 if has_missing else 2)
        for row_index, (group, total) in enumerate(groups.items(), 5):
            literal(sheet.cell(row_index, 1), group)
            sheet.cell(row_index, 2).value = float(total) if total is not None else None
            sheet.cell(row_index, 2).number_format = '#,##0.00;[Red]-#,##0.00'
            if has_missing:
                sheet.cell(row_index, 3).value = missing[group]
        summary_headers = [labels[keys.index(group_key)], labels[keys.index(value_key)] + '合计']
        if has_missing:
            summary_headers.append('缺失数值行数')
        table_style(sheet, summary_headers, len(groups) + 4, 'SummaryData')
        if len(groups) <= 20:
            chart = BarChart()
            chart.title = labels[keys.index(value_key)] + '分组汇总'
            chart.add_data(Reference(sheet, min_col=2, min_row=4, max_row=len(groups) + 4), titles_from_data=True)
            chart.set_categories(Reference(sheet, min_col=1, min_row=5, max_row=len(groups) + 4))
            chart.legend = None
            chart.width, chart.height = 20, 10
            sheet.add_chart(chart, 'E4' if has_missing else 'D4')
    destination.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(destination)
    return {'file': destination.name, 'rows': len(rows), 'sheets': workbook.sheetnames, 'bytes': destination.stat().st_size}


def main():
    if len(sys.argv) != 3:
        raise ValueError('用法：build.py 输入.json或.csv 输出.xlsx')
    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    if destination.suffix.lower() != '.xlsx':
        raise ValueError('输出文件必须使用.xlsx扩展名。')
    print(json.dumps(build(input_content(source), destination), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('生成失败：' + str(error), file=sys.stderr)
        sys.exit(1)
