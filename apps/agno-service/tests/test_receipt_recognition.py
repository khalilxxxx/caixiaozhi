import asyncio
from contextlib import asynccontextmanager
from io import BytesIO
import json
from types import SimpleNamespace

from PIL import Image
import pytest

import config
from file_service import save_file
from material_service import ReceiptReading, extract_materials, verified_receipt
import material_vision
from store import Store
from translation_service import TranslationError


def receipt_result(role, facts, evidence, text):
    reading = ReceiptReading(role=role, facts=facts, evidence=evidence)
    return verified_receipt(reading, text, [])


def test_debit_and_receipt_details_are_grounded_separately():
    source = ('支付成功\n订单号：SHOP-88\n交易单号：TX-998\n实付：-88.50元\n'
              '消费日期：2026-11-20\n人数：12人\n商户：合成餐厅')
    result = receipt_result('payment', {
        'orderId': 'SHOP-88', 'transactionId': 'SHOP-88', 'amount': 8850,
        'date': '2026-11-20', 'checkIn': '2026-11-20', 'people': '2', 'merchant': '合成餐厅',
        'purpose': '客户招待',
    }, {
        'role': '支付成功', 'orderId': '订单号: SHOP-88', 'transactionId': '订单号：SHOP-88',
        'amount': '实付：-88.50元', 'date': '消费日期：2026-11-20', 'checkIn': '消费日期：2026-11-20',
        'people': '人数：12人', 'merchant': '商户：合成餐厅', 'purpose': '客户招待',
    }, source)
    assert result['role'] == 'payment'
    assert result['facts'] == {'orderId': 'SHOP-88', 'amount': 8850, 'date': '2026-11-20', 'merchant': '合成餐厅'}
    assert result['evidence']['orderId'] == '订单号：SHOP-88'


def test_invoice_date_refund_amount_and_unseen_currency_are_not_invented():
    source = '电子发票\n开票日期：2026-11-20\n金额：88.50美元'
    result = receipt_result('invoice', {'date': '2026-11-20', 'invoiceDate': '2026-11-20', 'currency': 'USD', 'amount': 8850}, {
        'role': '电子发票', 'date': '开票日期：2026-11-20', 'invoiceDate': '开票日期：2026-11-20',
        'currency': '88.50美元', 'amount': '88.50',
    }, source)
    assert result['facts'] == {'currency': 'USD', 'invoiceDate': '2026-11-20'}
    source = '支付成功 已退款\n实付：-88.50元'
    result = receipt_result('payment', {'amount': 8850}, {'role': '支付成功', 'amount': '-88.50元'}, source)
    assert result['role'] == 'unknown' and 'amount' not in result['facts']


def test_separate_invoices_in_single_upload_do_not_mix_facts():
    source = '电子发票\n发票号码：12345678\n发票号码：12345679\n含税合计：10.00元'
    result = receipt_result('invoice', {'amount': 1000}, {'role': '电子发票', 'amount': '10.00元'}, source)
    assert result['multipleDocuments'] and result['role'] == 'unknown' and not result['facts']


def test_deepseek_flash_uses_first_party_visual_input_without_using_credentials_for_other_hosts(monkeypatch):
    monkeypatch.setattr(config, 'MODEL', 'deepseek-flash')
    monkeypatch.setattr(config, 'API_KEY', 'local-test-key')
    for key in ('AGNO_VISION_MODEL', 'AGNO_VISION_BASE_URL', 'AGNO_VISION_API_KEY'):
        monkeypatch.delenv(key, raising=False)
    assert material_vision.vision_settings()['model'] == 'deepseek-flash'
    monkeypatch.setenv('AGNO_VISION_BASE_URL', 'https://example.invalid/v1')
    with pytest.raises(TranslationError, match='AGNO_VISION_API_KEY'):
        material_vision.vision_settings()


def configure_vision(monkeypatch):
    monkeypatch.setattr(config, 'MODEL', 'receipt-fixture')
    monkeypatch.setenv('AGNO_VISION_MODEL', 'vision-test')
    monkeypatch.setenv('AGNO_VISION_API_KEY', 'test')


def test_reimbursement_reads_real_pdf_pages_sends_images_and_uses_protected_cache(tmp_path, monkeypatch):
    from reportlab.pdfgen.canvas import Canvas
    from agno import agent
    import agent_runtime

    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    configure_vision(monkeypatch)
    store = Store(tmp_path / 'db')
    data = BytesIO()
    pdf = Canvas(data)
    for label in ['Invoice', 'Continuation']:
        pdf.drawString(20, 50, label)
        pdf.showPage()
    pdf.save()
    file = save_file(store, tmp_path / 'files', 'foreign-name.pdf', 'application/pdf', data.getvalue())
    file_id = file['id']
    manual = {'id': 'manual', 'confirmed': True, 'sourceFileId': file_id, 'amount': 12345}
    store.mutate(lambda state: state['data']['materials']['items'].append(manual))
    pages = []

    async def complete(**kwargs):
        message = kwargs['messages'][0]['content']
        assert 'foreign-name' not in str(message[0])
        assert message[1]['type'] == 'image_url' and message[1]['image_url']['url'].startswith('data:image/png;base64,')
        pages.append(message[1]['image_url']['url'])
        text = '电子发票\n销售方：合成商户' if len(pages) == 1 else '备注：客户接待'
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop', message=SimpleNamespace(content=json.dumps({'text': text})))])
    @asynccontextmanager
    async def fake_client(**kwargs):
        yield SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))
    monkeypatch.setattr(material_vision, 'AsyncOpenAI', fake_client)
    class FakeReader:
        def __init__(self, **kwargs):
            assert kwargs['output_schema'] is ReceiptReading
        async def arun(self, payload):
            assert '电子发票\n销售方：合成商户\n备注：客户接待' == json.loads(payload)['text']
            return SimpleNamespace(content={'role': 'invoice', 'facts': {'purpose': '客户接待'},
                                            'evidence': {'role': '电子发票', 'purpose': '备注：客户接待'}})
    monkeypatch.setattr(agent, 'Agent', FakeReader)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    read = lambda: asyncio.run(extract_materials(store, [file_id], reimbursement=True))
    result = read()
    assert len(pages) == 2 and pages[0] != pages[1]
    assert result['items'] == [manual]
    recognized = result['files'][0]
    assert recognized['extractionSource']['kind'] == 'llm_vision'
    assert recognized['recognition']['evidenceLocations']['purpose'][0]['page'] == 2
    def fake_cached(state):
        entry = next(row for row in state['data']['materials']['files'] if row['id'] == file_id)
        entry['recognition']['facts']['purpose'] = '人工覆盖'
    store.mutate(fake_cached)
    result = read()
    assert len(pages) == 2 and result['items'] == [manual]
    assert result['files'][0]['recognition']['facts']['purpose'] == '客户接待'


def test_failed_visual_model_surfaces_failure_and_later_retries(tmp_path, monkeypatch):
    import agno.agent
    import agent_runtime
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    configure_vision(monkeypatch)
    store = Store(tmp_path / 'db')
    data = BytesIO()
    Image.new('RGB', (30, 30)).save(data, format='PNG')
    file = save_file(store, tmp_path / 'files', '支付成功.png', 'image/png', data.getvalue())
    reply = {'finish': 'length'}
    async def complete(**kwargs):
        return SimpleNamespace(choices=[SimpleNamespace(finish_reason=reply['finish'],
                       message=SimpleNamespace(content='{"text":"支付成功"}'))])
    @asynccontextmanager
    async def client(**kwargs):
        yield SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=complete)))
    monkeypatch.setattr(material_vision, 'AsyncOpenAI', client)
    class TextReader:
        def __init__(self, **kwargs):
            pass
        async def arun(self, payload):
            return SimpleNamespace(content=ReceiptReading(role='payment', evidence={'role': '支付成功'}))
    monkeypatch.setattr(agno.agent, 'Agent', TextReader)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    read = lambda: asyncio.run(extract_materials(store, [file['id']], reimbursement=True))['files'][0]
    failed = read()
    assert failed['status'] == 'failed' and failed.get('recognition') is None
    reply['finish'] = 'stop'
    assert read()['recognition']['role'] == 'payment'


@pytest.mark.parametrize(('title', 'label', 'number', 'native', 'valid'), [
    ('数电票', '发票号码', '66000000000001320022', '', True),
    ('电子发票（普通发票）', '发票号码', '6600000000001320022', '', False),
    ('电子发票（普通发票）', '发票号码', '12345678', '', False),
    ('增值税普通发票', '发票号码', '00112233', '', True),
    ('Tax Invoice', 'Invoice Number', 'INV-008877', '', True),
    ('统一发票 新台币', '发票号码', 'AB12345678', '', True),
    ('数电票', '发票号码', '66000000000001320022', '发票号码：66000000000001320023', False),
])
def test_invoice_identity_keeps_questionable_numbers_out_of_grouping(title, label, number, native, valid):
    quote = f'{label}：{number}'
    reading = ReceiptReading(role='invoice', facts={'invoiceNumber': number}, evidence={'role': title, 'invoiceNumber': quote})
    result = verified_receipt(reading, title + '\n' + quote, [], native)
    assert (result['facts'].get('invoiceNumber') == number) is valid
    assert bool(result['reviewIssues']) is (not valid)
    assert result['evidence']['invoiceNumber'] == quote


def test_single_labeled_fapiao_number_is_checked_even_if_structured_reader_omitted_it():
    reading = ReceiptReading(role='invoice', evidence={'role': '数电票'})
    result = verified_receipt(reading, '数电票\n发票号码：6600000000001320022', [])
    assert 'invoiceNumber' not in result['facts']
    assert result['evidence']['invoiceNumber'] == '发票号码：6600000000001320022'
    assert result['reviewIssues'][0]['field'] == 'invoiceNumber'


def test_list_price_cannot_be_used_as_actual_payment_amount():
    source = '支付成功\n商品原价：100.00元\n实付金额：人民币 88.50元'
    result = receipt_result('payment', {'amount': 10000}, {'role': '支付成功', 'amount': '商品原价：100.00元'}, source)
    assert 'amount' not in result['facts']


def test_failed_retry_keeps_partial_receipt_and_original_quotes(tmp_path, monkeypatch):
    import agno.agent
    import agent_runtime
    store = Store(tmp_path / 'db')
    source = '数电票\n发票号码：6600000000001320022\n服务项目：餐饮服务'
    file = save_file(store, tmp_path, '原件.txt', 'text/plain', source.encode())
    class Reader:
        failed = False
        def __init__(self, **kwargs):
            pass
        async def arun(self, payload):
            if self.failed:
                raise RuntimeError('fixture')
            return SimpleNamespace(content={'role': 'invoice', 'facts': {'service': '餐饮服务'},
                                            'evidence': {'role': '数电票', 'service': '服务项目：餐饮服务'}})
    monkeypatch.setattr(agno.agent, 'Agent', Reader)
    monkeypatch.setattr(agent_runtime, 'model', lambda: object())
    read = lambda: asyncio.run(extract_materials(store, [file['id']], reimbursement=True))['files'][0]
    first = read()
    assert first['extractionStatus'] == 'needs_review'
    Reader.failed = True
    second = read()
    assert second['extractionStatus'] == 'needs_review'
    assert second['recognition'] == first['recognition']
    assert '已保留上次结果' in second['extractionError']
