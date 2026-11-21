import { expect, it } from 'vitest';
import {
  assignBatchFile,
  editableGroups,
  groupAssignments,
  isReimbursementPanel,
  type ReimbursementBatch,
} from '../../apps/web/src/demos/agent-workspace/reimbursement-batch.js';
import {
  createBlankExpense,
  migrateLegacyDrafts,
  switchExpenseCategory,
} from '../../apps/web/src/demos/agent-workspace/submission-model.js';
import { currentCard } from '../../apps/web/src/demos/agent-workspace/card-model.js';

it('移动原件时逐份唯一归属，保留手选费用类型，只对自动匹配的类别重新计算', () => {
  const initial = editableGroups({
    groups: [
      {
        id: 'one',
        invoiceFileIds: ['i1'],
        attachmentFileIds: ['a1'],
        expense: { categoryId: 'taxi' },
      },
      {
        id: 'two',
        invoiceFileIds: ['i2'],
        attachmentFileIds: [],
        categoryId: 'other-office',
        expense: { categoryId: 'other-office' },
      },
    ],
  } as ReimbursementBatch);
  const moved = assignBatchFile(initial, 'a1', 'two', 'attachmentFileIds');
  expect(groupAssignments(moved)).toEqual([
    { invoiceFileIds: ['i1'], attachmentFileIds: [] },
    {
      invoiceFileIds: ['i2'],
      attachmentFileIds: ['a1'],
      categoryId: 'other-office',
    },
  ]);
  expect(
    assignBatchFile(moved, 'i1', '', 'invoiceFileIds').map((group) => group.id),
  ).toEqual(['two']);
  expect(
    assignBatchFile(moved, 'i1', 'separate', 'invoiceFileIds').at(-1)
      ?.invoiceFileIds,
  ).toEqual(['i1']);
  expect(initial[0]?.attachmentFileIds).toEqual(['a1']);
});

it('新批次卡片打开指定草稿，与旧的材料库摘要互不覆盖', () => {
  const card = {
    kind: 'materials',
    title: '发票转费用',
    id: 'rb-id',
    subtitle: '2 笔费用',
    data: { draftId: 'personal', reimbursementBatchId: 'rb-id' },
  };
  expect(isReimbursementPanel(card)).toBe(true);
  expect(
    isReimbursementPanel({
      ...card,
      data: { draftId: 'personal', fileIds: ['file-x'] },
    }),
  ).toBe(false);
  expect(currentCard(card, {})).toEqual(card);
});

it('生成后补选类型仍保留识别金额、原件和引用', () => {
  const item = {
    ...createBlankExpense(),
    generated: true,
    amount: '288.00',
    currency: 'CNY',
    receiptEvidence: {
      amount: [{ fileId: 'receipt', quote: '实付人民币288.00元' }],
    },
    files: [
      { id: 'invoice', name: '发票.pdf', size: 10, type: 'application/pdf' },
    ],
    attachments: [
      { id: 'receipt', name: '支付凭证.jpg', size: 12, type: 'image/jpeg' },
    ],
  };
  expect(switchExpenseCategory(item, 'reception-meal')).toMatchObject({
    amount: item.amount,
    currency: item.currency,
    receiptEvidence: item.receiptEvidence,
    files: item.files,
    attachments: item.attachments,
  });
});

it('恢复草稿时保留单号和票据识别的活动来源', () => {
  const draft = migrateLegacyDrafts({
    personal: {
      documentNumber: 'LOCAL-BX-TEST',
      activities: [
        { id: 'activity-1', activityNumber: 'GZ100', source: 'receipt' },
      ],
    },
  }).personal;
  expect(draft.documentNumber).toBe('LOCAL-BX-TEST');
  expect(draft.activities[0]).toMatchObject({
    activityNumber: 'GZ100',
    source: 'receipt',
  });
});
