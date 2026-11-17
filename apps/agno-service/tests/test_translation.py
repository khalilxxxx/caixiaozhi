import asyncio
from pathlib import Path
import platform
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from file_service import save_file
from server import create_app
from store import Store


def test_translation_rejects_non_image_and_missing_file(tmp_path, monkeypatch):
    import config
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    with TestClient(create_app(Store(tmp_path / 'state.db'))) as client:
        file = client.post('/api/local/files', files={'file': ('notes.txt', b'Hello', 'text/plain')}).json()['file']
        response = client.post(f"/api/local/files/{file['id']}/translation")
        assert response.status_code == 422
        assert 'PNG' in response.json()['message']
        assert client.post('/api/local/files/missing/translation').status_code == 404


def sample_ocr():
    return {'sourceLanguage': 'en', 'pages': [{'page': 1, 'width': 800, 'height': 1200, 'blocks': [
        {'id': 'p1-b1', 'source': 'Invoice INV-2026-1', 'bbox': {'x': .1, 'y': .1, 'width': .5, 'height': .04}, 'confidence': .98},
        {'id': 'p1-b2', 'source': 'Total USD 123.45', 'bbox': {'x': .1, 'y': .7, 'width': .5, 'height': .04}, 'confidence': .96},
    ]}]}


def test_translation_persists_results_and_serves_only_known_pages(tmp_path, monkeypatch):
    import config
    import translation_service
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'API_KEY', 'test-placeholder')
    async def translate(blocks):
        return {'p1-b1': '发票 INV-2026-1', 'p1-b2': '总计 USD 123.45'}
    def recognize(source, output):
        output.mkdir(parents=True, exist_ok=True)
        (output / 'page-1.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        return sample_ocr()
    monkeypatch.setattr(translation_service, 'recognize_document', recognize)
    monkeypatch.setattr(translation_service, 'translate_blocks', translate)
    store = Store(tmp_path / 'state.db')
    with TestClient(create_app(store)) as client:
        file = client.post('/api/local/files', files={'file': ('invoice.png', b'image', 'image/png')}).json()['file']
        endpoint = f"/api/local/files/{file['id']}/translation"
        assert client.get(endpoint).status_code == 404
        # A source preview is available before model translation has completed.
        assert client.get(f"/api/local/files/{file['id']}/pages/1").status_code == 200
        assert client.get(endpoint).status_code == 404
        response = client.post(endpoint)
        assert response.status_code == 200
        result = response.json()
        assert result['fileId'] == file['id']
        assert result['status'] == 'completed'
        assert result['targetLanguage'] == 'zh-CN'
        assert result['pages'][0]['blocks'][1]['target'] == '总计 USD 123.45'
        assert client.get(endpoint).json() == result
        preview = client.get(result['pages'][0]['imageUrl'])
        assert preview.status_code == 200
        assert preview.headers['content-type'] == 'image/png'
        assert 'attachment' not in preview.headers.get('content-disposition', '')
        assert client.get(f"/api/local/files/{file['id']}/pages/2").status_code == 404
        # Persisted successes survive a service instance, without rerunning OCR/model.
    def cannot_recognize(*args):
        pytest.fail('已保存结果不应重新识别')
    monkeypatch.setattr(translation_service, 'recognize_document', cannot_recognize)
    with TestClient(create_app(Store(tmp_path / 'state.db'))) as client:
        assert client.post(endpoint).json() == result


@pytest.mark.parametrize('rows', [
    [{'id': 'p1-b1', 'target': '发票 INV-2026-1'}],
    [{'id': 'p1-b1', 'target': '发票 INV-2026-1'}, {'id': 'p1-b1', 'target': '总计 USD 123.45'}],
    [{'id': 'p1-b1', 'target': '发票 INV-2026-1'}, {'id': 'p1-b2', 'target': '总计 USD 999.00'}],
    [{'id': 'p1-b1', 'target': '发票 INV-2026-1'}, {'id': 'p1-b2', 'target': ''}],
])
def test_model_results_must_cover_ids_and_preserve_numbers(rows):
    from translation_service import TranslationError, validate_translations
    with pytest.raises(TranslationError):
        validate_translations(sample_ocr()['pages'][0]['blocks'], rows)


@pytest.mark.parametrize(('source', 'target'), [
    ('Refund USD -128.00', '退款 USD 128.00'),
    ('Refund USD −128.00', '退款 USD 128.00'),
    ('Refund USD (128.00)', '退款 USD 128.00'),
    ('Refund (USD 128.00)', '退款 USD 128.00'),
    ('VAT 10%', '增值税 10'),
    ('VAT 10％', '增值税 10'),
    ('Refund USD -128.00; Charge USD 20.00', '退款 USD 128.00；收费 USD -20.00'),
])
def test_financial_signs_cannot_be_dropped_or_moved(source, target):
    from translation_service import TranslationError, validate_translations
    with pytest.raises(TranslationError):
        validate_translations([{'id': 'p1-b1', 'source': source}], [{'id': 'p1-b1', 'target': target}])


@pytest.mark.parametrize(('source', 'target'), [
    ('Refund USD -128.00', '退款 USD -128.00'),
    ('Refund USD −128.00', '退款 USD −128.00'),
    ('Refund USD (128.00)', '退款 USD (128.00)'),
    ('Refund (USD 128.00)', '退款 (USD 128.00)'),
    ('VAT 10%', '增值税 10%'),
    ('VAT 10％', '增值税 10％'),
    ('Invoice INV-2026-001; Date 2026-11-17', '发票 INV-2026-001；日期2026-11-17'),
])
def test_preserved_signs_dates_and_identifiers_remain_valid(source, target):
    from translation_service import validate_translations
    assert validate_translations([{'id': 'p1-b1', 'source': source}], [{'id': 'p1-b1', 'target': target}]) == {'p1-b1': target}


def test_invalid_coordinates_and_empty_recognition_are_rejected():
    from translation_service import TranslationError, validate_ocr
    for change in ('outside', 'empty', 'nan'):
        result = sample_ocr()
        if change == 'outside':
            result['pages'][0]['blocks'][0]['bbox']['width'] = 2
        elif change == 'nan':
            result['pages'][0]['blocks'][0]['bbox']['x'] = float('nan')
        else:
            result['pages'][0]['blocks'] = []
        with pytest.raises(TranslationError):
            validate_ocr(result)


def test_same_file_concurrency_reuses_one_persisted_result(tmp_path, monkeypatch):
    import config
    import translation_service
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'API_KEY', 'test-placeholder')
    store = Store(tmp_path / 'state.db')
    file = save_file(store, tmp_path / 'files', 'invoice.png', 'image/png', b'image')
    count = 0
    def recognize(source, output):
        nonlocal count
        count += 1
        return sample_ocr()
    async def translate(blocks):
        await asyncio.sleep(.02)
        return {'p1-b1': '发票 INV-2026-1', 'p1-b2': '总计 USD 123.45'}
    monkeypatch.setattr(translation_service, 'recognize_document', recognize)
    monkeypatch.setattr(translation_service, 'translate_blocks', translate)
    service = translation_service.TranslationService(store)
    async def execute():
        return await asyncio.gather(service.translate(file['id']), service.translate(file['id']))
    results = asyncio.run(execute())
    assert results[0] == results[1]
    assert count == 1


def test_failed_translation_does_not_create_completed_result(tmp_path, monkeypatch):
    import config
    import translation_service
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(config, 'API_KEY', 'test-placeholder')
    def recognize(source, output):
        raise translation_service.TranslationError('无法读取图片，请重新上传清晰票据。', 422)
    monkeypatch.setattr(translation_service, 'recognize_document', recognize)
    with TestClient(create_app(Store(tmp_path / 'state.db'))) as client:
        file = client.post('/api/local/files', files={'file': ('broken.png', b'broken', 'image/png')}).json()['file']
        endpoint = f"/api/local/files/{file['id']}/translation"
        response = client.post(endpoint)
        assert response.status_code == 422
        assert '无法读取图片' in response.json()['message']
        assert client.get(endpoint).status_code == 404


@pytest.fixture(scope='module')
def receipt_fixtures(tmp_path_factory):
    if platform.system() != 'Darwin' or not shutil.which('swift'):
        pytest.skip('原生票据 OCR 需要 macOS 与 Swift')
    directory = tmp_path_factory.mktemp('synthetic-receipts')
    subprocess.run(['swift', str(Path(__file__).with_name('receipt_fixture.swift')), str(directory)], check=True, capture_output=True, timeout=60)
    return directory


def test_native_ocr_png_pdf_and_image_orientation(tmp_path, monkeypatch, receipt_fixtures):
    import config
    from translation_service import recognize_document
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    png = recognize_document(receipt_fixtures / 'sample-hotel.png', tmp_path / 'png')
    assert len(png['pages']) == 1
    assert (png['pages'][0]['width'], png['pages'][0]['height']) == (1000, 1400)
    blocks = png['pages'][0]['blocks']
    hotel = next(block for block in blocks if 'Hotel' in block['source'])
    total = next(block for block in blocks if '128.00' in block['source'])
    assert hotel['bbox']['y'] < total['bbox']['y']
    assert hotel['bbox']['x'] < .2
    assert hotel['bbox']['y'] < .25
    assert png['sourceLanguage'] in {'en', 'und'}
    assert (tmp_path / 'png/page-1.png').read_bytes().startswith(b'\x89PNG')
    pdf = recognize_document(receipt_fixtures / 'sample-hotel-2-pages.pdf', tmp_path / 'pdf')
    assert [page['page'] for page in pdf['pages']] == [1, 2]
    assert any('INV-2026-002' in block['source'] for block in pdf['pages'][1]['blocks'])
    assert (tmp_path / 'pdf/page-2.png').is_file()
    oriented = recognize_document(receipt_fixtures / 'sample-oriented.jpg', tmp_path / 'oriented')
    assert (oriented['pages'][0]['width'], oriented['pages'][0]['height']) == (1400, 1000)
    assert any('128.00' in block['source'] for block in oriented['pages'][0]['blocks'])


def test_native_ocr_rejects_corrupt_images_and_more_than_ten_pages(tmp_path, monkeypatch, receipt_fixtures):
    import config
    from translation_service import TranslationError, recognize_document
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    corrupt = tmp_path / 'broken.png'
    corrupt.write_bytes(b'not an image')
    with pytest.raises(TranslationError, match='无法读取图片'):
        recognize_document(corrupt, tmp_path / 'broken')
    with pytest.raises(TranslationError, match='10 页'):
        recognize_document(receipt_fixtures / 'sample-hotel-11-pages.pdf', tmp_path / 'long-pdf')
