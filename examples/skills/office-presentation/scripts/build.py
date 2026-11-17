"""Create a readable Chinese presentation from supplied JSON; no network or installs."""
from pathlib import Path
import json
import math
import sys

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt

INK = '24354C'
MUTED = '667184'
BLUE = '315F8E'
PALE = 'EFF3F7'
FONT = 'Hiragino Sans GB'


def text(value, limit, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{field}不能为空。')
    if len(value) > limit:
        raise ValueError(f'{field}不能超过{limit}个字符，请拆分内容。')
    return value.strip()


def font(run, size, color=INK, bold=False):
    run.font.name = FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)
    east_asian = OxmlElement('a:ea')
    east_asian.set('typeface', FONT)
    run._r.get_or_add_rPr().append(east_asian)


def textbox(slide, value, x, y, width, height, size=20, color=INK, bold=False):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(width), Inches(height))
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    for index, line in enumerate(str(value).split('\n')):
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.space_after = Pt(8)
        font(paragraph.add_run(), size, color, bold)
        paragraph.runs[-1].text = line
    return box


def base_slide(deck, title, source='', continuation=False):
    slide = deck.slides.add_slide(deck.slide_layouts[6])
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = RGBColor(255, 255, 255)
    textbox(slide, title + ('（续）' if continuation else ''), 0.7, 0.5, 11.9, 1.0, 26 if len(title) > 28 else 28, bold=True)
    textbox(slide, source, 0.7, 6.9, 10.8, 0.25, 10, MUTED)
    textbox(slide, str(len(deck.slides)), 12.0, 6.9, 0.5, 0.25, 10, MUTED)
    return slide


def line_units(value):
    width = sum(1 if ord(char) > 255 else 0.55 for char in value)
    return max(1, math.ceil(width / 38))


def bullet_pages(bullets):
    page, units = [], 0
    for item in bullets:
        item = text(item, 180, '要点')
        cost = line_units(item) + 0.65
        if page and units + cost > 8:
            yield page
            page, units = [], 0
        page.append((item, cost))
        units += cost
    if page:
        yield page


def build(content, destination):
    title = text(content.get('title'), 48, '汇报标题')
    subtitle = str(content.get('subtitle', '')).strip()
    if len(subtitle) > 180:
        raise ValueError('副标题过长，请缩短至180个字符以内。')
    include_cover = content.get('include_cover', True)
    if not isinstance(include_cover, bool):
        raise ValueError('include_cover必须为JSON布尔值true或false。')
    total_slides = content.get('total_slides')
    if total_slides is not None and (isinstance(total_slides, bool) or not isinstance(total_slides, int) or total_slides < 1):
        raise ValueError('total_slides必须为正整数，表示包含封面和自动分页的总页数。')
    author = text(content['author'], 70, '署名') if content.get('author') else ''
    slides = content.get('slides')
    if not isinstance(slides, list) or not 1 <= len(slides) <= 40:
        raise ValueError('slides需要包含1至40组内容。')
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    deck.core_properties.title = title
    deck.core_properties.subject = subtitle
    deck.core_properties.author = author
    if include_cover:
        cover = deck.slides.add_slide(deck.slide_layouts[6])
        cover.background.fill.solid()
        cover.background.fill.fore_color.rgb = RGBColor.from_string(PALE)
        textbox(cover, title, 0.95, 2.0, 11.4, 1.7, 34, bold=True)
        textbox(cover, subtitle, 0.98, 4.05, 10.9, 1.25, 19, MUTED)
        if author:
            textbox(cover, author, 0.98, 6.35, 10.9, 0.4, 13, MUTED)
    for item in slides:
        if not isinstance(item, dict):
            raise ValueError('每组页面内容必须是JSON对象。')
        heading = text(item.get('title'), 48, '页面标题')
        source = str(item.get('source', '')).strip()
        if len(source) > 120:
            raise ValueError('来源说明不能超过120个字符。')
        notes = str(item.get('notes', ''))
        bullets, table = item.get('bullets', []), item.get('table')
        if not isinstance(bullets, list) or len(bullets) > 80:
            raise ValueError('每组要点必须是最多80项的列表。')
        if not bullets and not table:
            raise ValueError('每组页面需提供bullets或table。')
        for page_index, page in enumerate(bullet_pages(bullets)):
            slide = base_slide(deck, heading, source, continuation=page_index > 0)
            y = 1.65
            for value, cost in page:
                height = cost * 0.43
                textbox(slide, '•', 0.82, y, 0.3, 0.45, 20, BLUE)
                textbox(slide, value, 1.2, y, 11.0, height, 22)
                y += height + 0.12
            if notes:
                slide.notes_slide.notes_text_frame.text = notes
        if table:
            if not isinstance(table, dict):
                raise ValueError('table必须是包含headers与rows的对象。')
            headers, rows = table.get('headers'), table.get('rows')
            if not isinstance(headers, list) or not 1 <= len(headers) <= 6:
                raise ValueError('表格需要1至6列。')
            if not isinstance(rows, list) or not rows or len(rows) > 200:
                raise ValueError('表格需要1至200行。')
            for row in [headers, *rows]:
                if not isinstance(row, list) or len(row) != len(headers):
                    raise ValueError('表格每行列数必须与表头一致。')
                limit = min(44, max(14, 96 // len(headers)))
                if any(len(str(value)) > limit for value in row):
                    raise ValueError(f'当前列数下表格单元格不能超过{limit}个字符，请将长说明放入要点。')
            # Six rows leave enough vertical space for wrapped Chinese cells.
            for start in range(0, len(rows), 6):
                page_rows = rows[start:start + 6]
                slide = base_slide(deck, heading, source, continuation=start > 0)
                shape = slide.shapes.add_table(len(page_rows) + 1, len(headers), Inches(0.75), Inches(1.55), Inches(11.85), Inches(4.65))
                for row_index, row in enumerate([headers, *page_rows]):
                    for col_index, value in enumerate(row):
                        cell = shape.table.cell(row_index, col_index)
                        cell.margin_left = cell.margin_right = Inches(0.12)
                        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                        cell.fill.solid()
                        cell.fill.fore_color.rgb = RGBColor.from_string(INK if row_index == 0 else PALE if row_index % 2 else 'FFFFFF')
                        cell.text = str(value)
                        for paragraph in cell.text_frame.paragraphs:
                            for run in paragraph.runs:
                                font(run, 15 if len(headers) > 4 else 17, 'FFFFFF' if row_index == 0 else INK, row_index == 0)
                if notes:
                    slide.notes_slide.notes_text_frame.text = notes
    if total_slides is not None and len(deck.slides) != total_slides:
        cover_description = '含1页封面' if include_cover else '不含封面'
        raise ValueError(f'完整内容分页后为{len(deck.slides)}页（{cover_description}），与要求的总页数{total_slides}页不一致。请调整include_cover或重新组织内容；不要删减内容或截断页面。')
    destination.parent.mkdir(parents=True, exist_ok=True)
    deck.save(destination)
    return {'file': destination.name, 'slides': len(deck.slides), 'bytes': destination.stat().st_size}


def main():
    if len(sys.argv) != 3:
        raise ValueError('用法：build.py 输入.json 输出.pptx')
    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    if destination.suffix.lower() != '.pptx':
        raise ValueError('输出文件必须使用.pptx扩展名。')
    if source.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('输入JSON不能超过2MB。')
    content = json.loads(source.read_text(encoding='utf-8-sig'))
    if not isinstance(content, dict):
        raise ValueError('输入JSON根节点必须是对象。')
    print(json.dumps(build(content, destination), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('生成失败：' + str(error), file=sys.stderr)
        sys.exit(1)
