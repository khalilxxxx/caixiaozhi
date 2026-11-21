import { describe, expect, it } from 'vitest';
import {
  applyReceiptLine,
  markReceiptFields,
  receiptCategoryOverride,
  receiptLineKey,
} from '../../apps/web/src/demos/agent-workspace/receipt-line-prefill.js';
import { createBlankExpense } from '../../apps/web/src/demos/agent-workspace/submission-model.js';

const invoice = {
  id: 'file-1',
  name: '发票.pdf',
  type: 'application/pdf',
  size: 1,
};
const payment = { id: 'file-2', name: '凭证.png', type: 'image/png', size: 1 };

describe('单行原件自动填写', () => {
  it('保留人工填写及主动清空，随新票重算以前的机器值', () => {
    const old = applyReceiptLine(
      { ...createBlankExpense(), files: [invoice], amount: '58.00' },
      {
        categoryId: 'taxi',
        reason: '打车',
        amount: '28.00',
        date: '2026-11-01',
        currency: 'CNY',
      },
      {},
      true,
    );
    expect(old.amount).toBe('58.00');
    expect(receiptCategoryOverride(old)).toBe('');
    const manual = markReceiptFields(
      { ...old, reason: '', attachments: [payment] },
      'reason',
    );
    const next = applyReceiptLine(
      manual,
      {
        categoryId: 'taxi',
        reason: '客户拜访',
        amount: '88.00',
        date: '2026-11-02',
      },
      {},
      false,
    );
    expect(next.reason).toBe('');
    expect(next.amount).toBe('58.00');
    expect(next.date).toBe('2026-11-02');
    expect(next.receiptReadKey).toBe(receiptLineKey(next));
    expect(next.attachments).toEqual([payment]);
  });
  it('撤去旧发票后清理票号、自动金额及依据，保留手工金额', () => {
    const first = applyReceiptLine(
      { ...createBlankExpense(), files: [invoice] },
      { amount: '35.00', receiptInvoiceNumbers: ['IV-007'] },
      { amount: [{ fileId: invoice.id, quote: '35元' }] },
      true,
    );
    const empty = applyReceiptLine({ ...first, files: [] }, {}, {}, false);
    expect(empty.amount).toBe('');
    expect(empty.generated).toBe(false);
    expect(empty.receiptInvoiceNumbers).toEqual([]);
    expect(empty.sourceFileId).toBeUndefined();
    expect(empty.receiptEvidence).toEqual({});
    const manual = markReceiptFields(
      { ...first, files: [], amount: '27.00' },
      'amount',
    );
    expect(applyReceiptLine(manual, {}, {}, false).amount).toBe('27.00');
  });
  it('请求明确的类型，保护识别期间人工选类与原有表单数据', () => {
    const current = markReceiptFields(
      { ...createBlankExpense('hotel'), currency: 'HKD', files: [invoice] },
      'categoryId',
    );
    expect(receiptCategoryOverride(current)).toBe('hotel');
    const next = applyReceiptLine(
      current,
      { categoryId: 'other-office', currency: 'CNY', amount: '77.50' },
      {},
      false,
    );
    expect(next.categoryId).toBe('hotel');
    expect(next.currency).toBe('HKD');
    expect(next.amount).toBe('77.50');
    expect(receiptLineKey(next)).not.toBe(
      receiptLineKey({ ...next, attachments: [payment] }),
    );
  });
});
