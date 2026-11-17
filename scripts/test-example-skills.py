"""Run sample skill scripts against temporary inputs and verify real Office files."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest

from openpyxl import load_workbook
from pptx import Presentation

ROOT = Path(__file__).resolve().parents[1]


class ExampleSkillTests(unittest.TestCase):
    def run_skill(self, name, input_path, output_path):
        return subprocess.run([sys.executable, str(ROOT / 'examples' / 'skills' / name / 'scripts' / 'build.py'), str(input_path), str(output_path)], text=True, capture_output=True, check=False)

    def test_two_content_pages_do_not_receive_an_extra_cover(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.json', base / '两页汇报.pptx'
            source.write_text(json.dumps({'title': '办公处理能力', 'include_cover': False, 'total_slides': 2,
                'slides': [{'title': '文稿生成', 'bullets': ['根据材料制作文稿，保留待核对事项。']},
                           {'title': '表格汇总', 'table': {'headers': ['任务', '结果'], 'rows': [['费用整理', '汇总表']]}}]}, ensure_ascii=False), encoding='utf-8')
            process = self.run_skill('office-presentation', source, result)
            self.assertEqual(process.returncode, 0, process.stderr)
            deck = Presentation(result)
            self.assertEqual(len(deck.slides), 2)
            self.assertEqual(json.loads(process.stdout)['slides'], 2)
            self.assertEqual(deck.slides[0].shapes[0].text, '文稿生成')
            self.assertEqual(deck.slides[1].shapes[0].text, '表格汇总')
            self.assertEqual(next(shape.table for shape in deck.slides[1].shapes if shape.has_table).cell(1, 1).text, '汇总表')
            self.assertEqual(deck.core_properties.title, '办公处理能力')

    def test_page_count_mismatch_reports_actual_pages_without_truncating(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.json', base / '错误页数.pptx'
            source.write_text(json.dumps({'title': '两项能力', 'total_slides': 2,
                'slides': [{'title': '文稿生成', 'bullets': ['内容一']}, {'title': '表格汇总', 'bullets': ['内容二']}]}), encoding='utf-8')
            process = self.run_skill('office-presentation', source, result)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn('3页', process.stderr)
            self.assertIn('2页', process.stderr)
            self.assertFalse(result.exists())

    def test_no_cover_preserves_all_automatically_paginated_content(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.json', base / '完整内容.pptx'
            bullets = [f'核对要点{i}：' + '保留全部内容与条件。' * 12 for i in range(12)]
            rows = [[f'事项{i}', f'状态{i}'] for i in range(13)]
            source.write_text(json.dumps({'title': '完整材料', 'include_cover': False,
                'slides': [{'title': '要点', 'bullets': bullets}, {'title': '明细', 'table': {'headers': ['事项', '状态'], 'rows': rows}}]}, ensure_ascii=False), encoding='utf-8')
            process = self.run_skill('office-presentation', source, result)
            self.assertEqual(process.returncode, 0, process.stderr)
            deck = Presentation(result)
            self.assertGreater(len(deck.slides), 4)
            all_text = '\n'.join(shape.text for slide in deck.slides for shape in slide.shapes if shape.has_text_frame)
            for bullet in bullets:
                self.assertIn(bullet, all_text)
            actual_rows = [[cell.text for cell in row.cells] for slide in deck.slides for shape in slide.shapes
                           if shape.has_table for row in list(shape.table.rows)[1:]]
            self.assertEqual(actual_rows, rows)

    def test_cover_and_total_page_fields_reject_ambiguous_types(self):
        for fields in ({'include_cover': 'false'}, {'total_slides': True}, {'total_slides': 0}):
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as temp:
                base = Path(temp)
                source, result = base / 'content.json', base / 'invalid.pptx'
                source.write_text(json.dumps({'title': '校验', 'slides': [{'title': '内容', 'bullets': ['保留内容']}], **fields}), encoding='utf-8')
                process = self.run_skill('office-presentation', source, result)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(result.exists())

    def test_presentation_uses_supplied_content_and_paginates_tables(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.json', base / '汇报.pptx'
            source.write_text(json.dumps({'title': '材料整理结果', 'subtitle': '用户提供内容', 'slides': [{'title': '待确认事项', 'bullets': ['合同金额尚未核对', '付款日期待补充'], 'source': '来源：用户说明'}, {'title': '数据明细', 'table': {'headers': ['事项', '状态'], 'rows': [[f'事项{i}', '待确认'] for i in range(12)]}}]}, ensure_ascii=False), encoding='utf-8')
            process = self.run_skill('office-presentation', source, result)
            self.assertEqual(process.returncode, 0, process.stderr)
            deck = Presentation(result)
            self.assertEqual(len(deck.slides), 4)
            content = '\n'.join(shape.text for slide in deck.slides for shape in slide.shapes if shape.has_text_frame)
            self.assertIn('合同金额尚未核对', content)
            self.assertIn('来源：用户说明', content)
            self.assertGreater(result.stat().st_size, 10000)

    def test_workbook_preserves_text_and_summarizes_only_requested_values(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.json', base / '明细.xlsx'
            source.write_text(json.dumps({'title': '费用核对表', 'source': '用户提供', 'columns': [{'key': 'team', 'label': '部门', 'type': 'text'}, {'key': 'amount', 'label': '金额', 'type': 'number'}, {'key': 'note', 'label': '备注', 'type': 'text'}], 'rows': [{'team': '研发', 'amount': '100.20', 'note': '=HYPERLINK("https://example.invalid")'}, {'team': '研发', 'amount': '-50.10', 'note': '冲销'}, {'team': '运营', 'amount': 40, 'note': '用户输入'}], 'summary': {'groupBy': 'team', 'valueKey': 'amount'}}, ensure_ascii=False), encoding='utf-8')
            process = self.run_skill('table-report', source, result)
            self.assertEqual(process.returncode, 0, process.stderr)
            workbook = load_workbook(result, data_only=False)
            self.assertEqual(workbook['明细']['C5'].data_type, 's')
            self.assertEqual(workbook['明细']['B5'].value, 100.2)
            self.assertEqual(workbook['汇总']['B5'].value, 50.1)
            self.assertEqual(workbook['汇总']['B6'].value, 40)

    def test_csv_preserves_identifier_and_rejects_bad_numeric_json(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.csv', base / '明细.xlsx'
            source.write_text('编号,金额\n0012,12.50\n0013,6.25\n', encoding='utf-8')
            process = self.run_skill('table-report', source, result)
            self.assertEqual(process.returncode, 0, process.stderr)
            workbook = load_workbook(result)
            self.assertEqual(workbook['明细']['A5'].value, '0012')
            self.assertEqual(workbook['明细']['B5'].value, 12.5)
            invalid = base / 'invalid.json'
            invalid.write_text(json.dumps({'title': '校验', 'columns': [{'key': 'amount', 'label': '金额', 'type': 'number'}], 'rows': [{'amount': 'NaN'}]}), encoding='utf-8')
            process = self.run_skill('table-report', invalid, base / 'invalid.xlsx')
            self.assertNotEqual(process.returncode, 0)
            self.assertFalse((base / 'invalid.xlsx').exists())

    def test_group_with_no_known_amount_remains_empty(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, result = base / 'content.json', base / 'missing.xlsx'
            source.write_text(json.dumps({'columns': [{'key': 'kind', 'type': 'text'}, {'key': 'amount', 'type': 'number'}], 'rows': [{'kind': '待核对', 'amount': None}], 'summary': {'groupBy': 'kind', 'valueKey': 'amount'}}), encoding='utf-8')
            process = self.run_skill('table-report', source, result)
            self.assertEqual(process.returncode, 0, process.stderr)
            workbook = load_workbook(result)
            self.assertIsNone(workbook['汇总']['B5'].value)
            self.assertEqual(workbook['汇总']['C5'].value, 1)


if __name__ == '__main__':
    unittest.main()
