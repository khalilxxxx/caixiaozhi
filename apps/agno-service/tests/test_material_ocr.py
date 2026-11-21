import asyncio
import copy
import json
from types import SimpleNamespace

import pytest
import config
import translation_service
from file_service import save_file
from material_service import extract_materials
from store import Store


TEXT = '办公用品 80.50元 2026-11-17 打印资料'


def ocr_result():
    return {'pages': [{'page': 1, 'width': 600, 'height': 800, 'blocks': [
        {'id': 'p1-b1', 'source': TEXT, 'bbox': {'x': .1, 'y': .2, 'width': .8, 'height': .1}, 'confidence': .98}]}],
        'sourceLanguage': 'zh-Hans'}


@pytest.fixture(autouse=True)
def local_ocr_fallback(monkeypatch):
    # 这里专门覆盖没有配置视觉模型时的原文/OCR兼容路径。
    monkeypatch.setattr('material_vision.vision_settings', lambda: None)


def setup(tmp_path, monkeypatch, name='材料.png'):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    file = save_file(store, tmp_path / 'files', name, 'application/octet-stream', b'image')
    return store, file


def extractor(monkeypatch, callback=None):
    import agno.agent
    import agent_runtime
    class FakeAgent:
        def __init__(self, **kwargs):
            assert kwargs['output_schema'].__name__ == 'MaterialExtraction'
        async def arun(self, prompt):
            assert TEXT in json.loads(prompt)['text']
            if callback:
                callback()
            return SimpleNamespace(content={'items': [{'name': '办公用品', 'category': '办公', 'amount': 8050,
                'date': '2026-11-17', 'purpose': '打印资料', 'group': 'daily',
                'evidence': {'name': '办公用品', 'category': '办公用品', 'amount': '80.50元',
                             'date': '2026-11-17', 'purpose': '打印资料', 'group': '办公用品'}}]})
    monkeypatch.setattr(agno.agent, 'Agent', FakeAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    async def forbidden_translation(*args):
        pytest.fail('材料提取不应调用翻译模型')
    monkeypatch.setattr(translation_service, 'translate_blocks', forbidden_translation)


def test_materials_reuse_cached_source_ocr_and_preserve_block_coordinates(tmp_path, monkeypatch):
    store, file = setup(tmp_path, monkeypatch)
    cache = tmp_path / 'translations' / file['id']
    cache.mkdir(parents=True)
    cache.joinpath('ocr.json').write_text(json.dumps(ocr_result()))
    cache.joinpath('page-1.png').write_bytes(b'preview')
    def no_recognition(*args):
        pytest.fail('已缓存的 OCR 不应重新运行')
    monkeypatch.setattr(translation_service, 'recognize_document', no_recognition)
    extractor(monkeypatch)
    result = asyncio.run(extract_materials(store, [file['id']]))
    assert len(result['items']) == 1
    item = result['items'][0]
    assert item['amount'] == 8050 and item['confirmed'] is False
    location = item['evidenceLocations']['amount'][0]
    assert location['page'] == 1 and location['blockId'] == 'p1-b1'
    assert location['source'] == TEXT
    assert location['bbox']['x'] == .1
    assert result['files'][0]['extractionSource']['engine'] == 'Apple Vision'
    assert store.get_translation(file['id']) is None


@pytest.mark.parametrize('name', ['材料.png', '扫描件.pdf'])
def test_images_and_scanned_pdf_use_recognition_without_translation(tmp_path, monkeypatch, name):
    store, file = setup(tmp_path, monkeypatch, name)
    def recognize(source, output):
        assert source.name == store.get_file(file['id'])['storage_name']
        (output / 'page-1.png').write_bytes(b'preview')
        return ocr_result()
    monkeypatch.setattr(translation_service, 'recognize_document', recognize)
    extractor(monkeypatch)
    result = asyncio.run(extract_materials(store, [file['id']]))
    assert result['items'][0]['amount'] == 8050
    assert (tmp_path / 'translations' / file['id'] / 'ocr.json').is_file()


def test_platform_failure_is_explicit_and_does_not_erase_existing_manual_items(tmp_path, monkeypatch):
    store, file = setup(tmp_path, monkeypatch)
    reason = '当前票据识别依赖 macOS 的 Vision 服务，请在已配置的 Mac 上运行。'
    def unavailable(*args):
        raise translation_service.TranslationError(reason, 503)
    monkeypatch.setattr(translation_service, 'recognize_document', unavailable)
    before = copy.deepcopy(store.get_state()['data']['materials']['items'])
    result = asyncio.run(extract_materials(store, [file['id']]))
    assert result['items'] == []
    assert result['files'][0]['extractionError'] == reason
    assert store.get_state()['data']['materials']['items'] == before
    manual = {'id': 'manual-ocr', 'sourceFileId': file['id'], 'amount': 999, 'confirmed': True}
    store.mutate(lambda state: state['data']['materials']['items'].append(manual))
    assert asyncio.run(extract_materials(store, [file['id']]))['items'] == [manual]


def test_manual_edits_during_ocr_and_extraction_win(tmp_path, monkeypatch):
    store, file = setup(tmp_path, monkeypatch)
    monkeypatch.setattr(translation_service, 'recognize_document', lambda *args: ocr_result())
    manual = {'id': 'manual-ocr', 'sourceFileId': file['id'], 'amount': 999, 'confirmed': True}
    extractor(monkeypatch, lambda: store.mutate(lambda state: state['data']['materials']['items'].append(manual)))
    result = asyncio.run(extract_materials(store, [file['id']]))
    assert result['items'] == [manual]


def test_text_pdf_uses_existing_text_and_records_real_page_without_ocr(tmp_path, monkeypatch):
    from reportlab.pdfgen.canvas import Canvas
    import io
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'state.db')
    content = io.BytesIO()
    pdf = Canvas(content)
    pdf.drawString(30, 30, 'Office 80.50 CNY 2026-11-17')
    pdf.save()
    file = save_file(store, tmp_path / 'files', 'text.pdf', 'application/pdf', content.getvalue())
    def forbidden(*args):
        pytest.fail('文字 PDF 不应调用 OCR')
    monkeypatch.setattr(translation_service, 'recognize_document', forbidden)
    import agno.agent
    import agent_runtime
    class TextAgent:
        def __init__(self, **kwargs):
            pass
        async def arun(self, prompt):
            assert json.loads(prompt)['text'] == file['text']
            return SimpleNamespace(content={'items': [{'name': 'Office', 'amount': 8050,
                'evidence': {'name': 'Office', 'amount': '80.50 CNY'}}]})
    monkeypatch.setattr(agno.agent, 'Agent', TextAgent)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    result = asyncio.run(extract_materials(store, [file['id']]))
    assert result['items'][0]['amount'] == 8050
    assert result['items'][0]['evidenceLocations']['amount'][0]['page'] == 1
    assert result['files'][0]['extractionSource']['kind'] == 'pdf_text'
