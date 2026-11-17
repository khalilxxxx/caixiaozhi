import csv
import io
from concurrent.futures import ThreadPoolExecutor

import pytest

import config
from file_service import save_file
from store import Store


@pytest.fixture
def uploaded(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DATA_DIR', tmp_path)
    store = Store(tmp_path / 'workspace.sqlite', {'data': {}, 'tasks': [], 'activeTask': None})

    def add(text, name='费用.csv', encoding='utf-8-sig'):
        return store, save_file(store, tmp_path / 'files', name, 'text/csv', text.encode(encoding))['id']

    return add


def test_summary_calculates_integer_minor_units_and_reuses_result(uploaded):
    from expense_summary import summarize_csv
    store, file_id = uploaded('费用类型,金额\n交通,12.10\n餐饮,0.20\n交通,-2.10\n其他,0\n')
    outcome = summarize_csv(store, file_id)
    result = outcome['result']
    assert result['totalMinor'] == '1020'
    assert result['rowCount'] == 4
    assert result['total'] == '10.20'
    assert result['currency'] == 'CNY'
    assert result['amountUnit'] == '分'
    assert result['groups'] == [
        {'name': '交通', 'amountMinor': '1000', 'amount': '10.00', 'count': 2},
        {'name': '餐饮', 'amountMinor': '20', 'amount': '0.20', 'count': 1},
        {'name': '其他', 'amountMinor': '0', 'amount': '0.00', 'count': 1},
    ]
    assert outcome['cards'] == [{'kind': 'tool', 'id': result['id'], 'title': '费用汇总', 'status': '已完成'}]
    assert summarize_csv(store, file_id) == outcome
    assert len(store.get_state()['data']['toolResults']) == 1


@pytest.mark.parametrize('amount', ['', 'NaN', 'Infinity', '1.001', '1.000', '1e3', '1,000', '￥2', '12.'])
def test_invalid_amount_has_source_line_and_does_not_persist(uploaded, amount):
    from expense_summary import summarize_csv
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerows([['category', 'amount'], ['交通', '1.00'], ['餐饮', amount]])
    store, file_id = uploaded(stream.getvalue())
    with pytest.raises(ValueError, match='第 3 行.*金额'):
        summarize_csv(store, file_id)
    assert not store.get_state()['data'].get('toolResults')


def test_multiline_csv_is_a_single_record_and_reports_physical_line(uploaded):
    from expense_summary import summarize_csv
    store, file_id = uploaded('category,amount,note\n"城市\n交通",10.01,"车票,往返"\n餐饮,2,\n')
    result = summarize_csv(store, file_id)['result']
    assert result['totalMinor'] == '1201'
    assert result['rowCount'] == 2
    assert result['rows'] == [
        {'lineNumber': 2, 'category': '城市\n交通', 'amountMinor': '1001', 'amount': '10.01'},
        {'lineNumber': 4, 'category': '餐饮', 'amountMinor': '200', 'amount': '2.00'},
    ]


def test_history_persists_across_store_reopen_and_export_is_safe(uploaded):
    from expense_summary import export_result_csv, get_result, list_results, summarize_csv
    store, file_id = uploaded('费用类型,金额\n=HYPERLINK("a"),5.25\n')
    result = summarize_csv(store, file_id)['result']
    reopened = Store(store.path)
    assert get_result(reopened, result['id']) == result
    assert list_results(reopened) == [result]
    content = export_result_csv(reopened, result['id'])
    assert content.startswith(b'\xef\xbb\xbf')
    rows = list(csv.reader(io.StringIO(content.decode('utf-8-sig'))))
    assert rows[1] == ['\'=HYPERLINK("a")', '5.25', '1']
    assert rows[-1] == ['合计', '5.25', '1']


def test_reads_complete_original_beyond_metadata_text_limit(uploaded):
    from expense_summary import summarize_csv
    text = '费用类型,金额,备注\n' + ''.join(f'交通,0.01,{"备注" * 40}\n' for _ in range(900))
    store, file_id = uploaded(text)
    assert len(store.get_file(file_id)['metadata']['text']) == 60000
    assert summarize_csv(store, file_id)['result']['totalMinor'] == '900'


def test_rejects_truncated_fallback_and_unsupported_file(uploaded):
    from expense_summary import summarize_csv
    original = '费用类型,金额\n' + '交通费用,1\n' * 10000
    store, file_id = uploaded(original)
    assert len(original) > 60000
    assert len(store.get_file(file_id)['metadata']['text']) == 60000
    (config.DATA_DIR / 'files' / store.get_file(file_id)['storage_name']).unlink()
    with pytest.raises(ValueError, match='完整'):
        summarize_csv(store, file_id)
    store, file_id = uploaded('category,amount\nA,1\n', name='费用.txt')
    with pytest.raises(ValueError, match='CSV'):
        summarize_csv(store, file_id)


@pytest.mark.parametrize('encoding', ['utf-8', 'utf-8-sig', 'gb18030'])
def test_accepts_complete_fallback_when_size_and_digest_match(uploaded, encoding):
    from expense_summary import summarize_csv
    store, file_id = uploaded('费用类型,金额\n交通,12.01\n餐饮,0.20\n', encoding=encoding)
    (config.DATA_DIR / 'files' / store.get_file(file_id)['storage_name']).unlink()
    result = summarize_csv(store, file_id)['result']
    assert result['rowCount'] == 2
    assert result['totalMinor'] == '1221'


@pytest.mark.parametrize('text', [
    '类型,数量\n交通,1\n',
    'category,amount,金额\nA,1,2\n',
    'category,amount\nA,1,extra\n',
    'category,amount,note\nA,1\n',
    'category,amount\n,1\n',
    'category,amount\n',
    'category,amount\n"unfinished,1\n',
])
def test_rejects_invalid_csv_structure(uploaded, text):
    from expense_summary import summarize_csv
    store, file_id = uploaded(text)
    with pytest.raises(ValueError):
        summarize_csv(store, file_id)


def test_limits_rows_and_bytes(uploaded, monkeypatch):
    import expense_summary
    store, file_id = uploaded('category,amount\nA,1\nA,2\n')
    monkeypatch.setattr(expense_summary, 'MAX_ROWS', 1)
    with pytest.raises(ValueError, match='最多'):
        expense_summary.summarize_csv(store, file_id)
    monkeypatch.setattr(expense_summary, 'MAX_FILE_BYTES', 10)
    with pytest.raises(ValueError, match='大小'):
        expense_summary.summarize_csv(store, file_id)


def test_concurrent_retry_creates_one_result(uploaded):
    from expense_summary import summarize_csv
    store, file_id = uploaded('category,amount\nA,0.01\n')
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: summarize_csv(store, file_id)['result'], range(4)))
    assert all(result == results[0] for result in results)
    assert len(store.get_state()['data']['toolResults']) == 1


def test_missing_file_and_result_are_actionable(uploaded):
    from expense_summary import get_result, summarize_csv
    store, _ = uploaded('category,amount\nA,1\n')
    with pytest.raises(ValueError, match='文件不存在'):
        summarize_csv(store, 'missing')
    with pytest.raises(ValueError, match='结果不存在'):
        get_result(store, 'missing')


def test_legacy_history_adds_display_amounts_without_changing_stored_record(uploaded):
    from expense_summary import get_result, list_results, summarize_csv
    store, file_id = uploaded('category,amount\n交通,10\n办公,20\n')
    result = summarize_csv(store, file_id)['result']

    def remove_display_amounts(state):
        legacy = state['data']['toolResults'][result['id']]
        for key in ('currency', 'amountUnit', 'total', 'displayHint'):
            legacy.pop(key, None)
        for item in legacy['rows'] + legacy['groups']:
            item.pop('amount', None)

    store.mutate(remove_display_amounts)
    restored = get_result(store, result['id'])
    assert restored['total'] == '30.00'
    assert restored['groups'][0]['amount'] == '10.00'
    assert restored['rows'][1]['amount'] == '20.00'
    assert list_results(store)[0] == restored
    assert 'total' not in store.get_state()['data']['toolResults'][result['id']]
