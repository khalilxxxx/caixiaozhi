import { describe, expect, it } from 'vitest';
import {
  readSubmissionState,
  applyMaterialBatch,
  submissionDraftForText,
} from '../../apps/web/src/demos/agent-workspace/submission-state.js';
import { createBlankExpense } from '../../apps/web/src/demos/agent-workspace/submission-model.js';

describe('submission workspace state', () => {
  it.each(['我要申请差旅报销', '我要申请出差费用报销'])(
    'routes reimbursement intent before application wording for %s',
    (text) => {
      expect(submissionDraftForText(text)).toBe('expense');
    },
  );

  it('routes personal reimbursement and travel applications to their matching forms', () => {
    expect(submissionDraftForText('我要个人费用报销')).toBe('personal');
    expect(submissionDraftForText('帮我申请去上海出差')).toBe('travel');
  });
  it('uses the current employee and organization when starting a new application', () => {
    const state = readSubmissionState({});
    expect(state.drafts.travel).toMatchObject({
      applicant: '林悦',
      department: '财务部',
      paymentCompany: '华川科技',
      travelType: '普通差旅',
    });
    expect(state.drafts.personal.expenses).toEqual([]);
  });

  it('keeps the personal reimbursement identity in conversation cards', () => {
    const state = readSubmissionState({});
    expect(state.drafts.personal.id).toBe('personal');
    expect(state.drafts.personal.title).toContain('个人费用报销');
  });

  it('preserves a historical request snapshot and unsaved legacy purpose', () => {
    const snapshot = {
      id: 'expense',
      title: '旧报销',
      purpose: '旧用途',
      transportCents: 12300,
      hotelCents: 0,
      mealCents: 0,
      nights: 0,
      version: 2,
      status: 'awaiting_receipt',
    };
    const state = readSubmissionState({
      rulesSubmission: {
        drafts: { expense: { ...snapshot, status: 'draft' } },
        edits: { expense: { purpose: '尚未保存的用途', transport: '200.00' } },
        requests: [
          {
            id: 'old-request',
            draftId: 'expense',
            title: '旧报销',
            amountCents: 12300,
            createdAt: '11月15日',
            snapshot,
          },
        ],
      },
    });
    expect(state.edits.expense?.purpose).toBe('尚未保存的用途');
    expect(state.requests[0]?.legacySnapshot).toEqual(snapshot);
    expect(state.requests[0]?.amountCents).toBe(12300);
  });

  it('restores invoice metadata from a legacy material source', () => {
    const state = readSubmissionState({
      rulesSubmission: {
        drafts: {
          expense: {
            title: '旧报销',
            materialIds: ['old-file'],
            expenseLines: [
              {
                id: 'old-line',
                name: '旧交通',
                category: '交通',
                date: '2026-11-12',
                amountCents: 10000,
                sourceFileId: 'old-file',
              },
            ],
          },
        },
      },
      materials: {
        files: [
          {
            id: 'old-file',
            name: '历史交通发票.pdf',
            size: 1234,
            type: 'application/pdf',
          },
        ],
      },
    });
    expect(state.drafts.expense.expenses[0]?.files[0]?.name).toBe(
      '历史交通发票.pdf',
    );
  });

  it('protects a pending personal reimbursement when its material changes group', () => {
    const state = readSubmissionState({});
    state.drafts.personal.status = 'awaiting_receipt';
    state.drafts.personal.expenses = [
      {
        ...createBlankExpense('other-office'),
        id: 'office',
        sourceBatchId: 'batch-1',
        sourceFileId: 'file-1',
        group: 'daily',
        amount: '100.00',
      },
    ];
    const updated = applyMaterialBatch(state, {
      id: 'batch-1',
      materialBatchId: 'batch-1',
      revision: 2,
      items: [
        {
          id: 'office',
          name: '办公',
          category: '办公',
          amount: 10000,
          date: '2026-11-12',
          group: 'travel',
          sourceFileId: 'file-1',
        },
      ],
    });
    expect(updated).toBe(state);
    expect(updated.drafts.personal.status).toBe('awaiting_receipt');
  });

  it('keeps unsaved user changes while loading a revised material batch', () => {
    const state = readSubmissionState({});
    state.drafts.personal.expenses = [
      {
        ...createBlankExpense('other-office'),
        id: 'office',
        sourceBatchId: 'batch-1',
        sourceFileId: 'file-1',
        group: 'daily',
        amount: '100.00',
        reason: '原用途',
      },
    ];
    state.edits.personal = {
      ...structuredClone(state.drafts.personal),
      purpose: '尚未保存的单据用途',
    };
    state.edits.personal.expenses[0]!.reason = '人工填写的新用途';
    const updated = applyMaterialBatch(state, {
      id: 'batch-1',
      materialBatchId: 'batch-1',
      revision: 2,
      items: [
        {
          id: 'office',
          name: '办公',
          category: '办公',
          amount: 10000,
          date: '2026-11-12',
          group: 'daily',
          sourceFileId: 'file-1',
          purpose: '来源用途',
        },
      ],
    });
    expect(updated.edits.personal?.purpose).toBe('尚未保存的单据用途');
    expect(updated.edits.personal?.expenses[0]?.reason).toBe(
      '人工填写的新用途',
    );
    expect(updated.drafts.personal.purpose).not.toBe('尚未保存的单据用途');
  });
});
