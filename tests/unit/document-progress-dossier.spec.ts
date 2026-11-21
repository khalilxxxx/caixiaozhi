import { describe, expect, it } from 'vitest';
import { documents } from '../../apps/web/src/demos/document-query/fixtures';
import {
  progressDossier,
  type ProgressDossierRecord,
} from '../../apps/web/src/demos/agent-workspace/progress-dossier';
import { progressDocumentHref } from '../../apps/web/src/demos/agent-workspace/work-document-link';
import {
  createBlankExpense,
  createInitialDrafts,
} from '../../apps/web/src/demos/agent-workspace/submission-model';
import type { SubmissionRequest } from '../../apps/web/src/demos/agent-workspace/submission-state';
import type { WorkDocument } from '../../apps/web/src/demos/agent-workspace/work-document-model';

const expense = documents.find((doc) => doc.typeId === 'expense_claim')!;

describe('进展详情与原单关联', () => {
  it('仅使用同一来源和工作引用指向的待办或已办理记录', () => {
    const original: WorkDocument = {
      id: 'BX-123',
      title: expense.title,
      system: 'expense',
      kind: '差旅报销',
      person: '李娜',
      department: '研发部',
      period: '',
      attachment: true,
      stage: '待审批',
      categories: [],
      version: 1,
    };
    const projection: ProgressDossierRecord = {
      ...expense,
      key: 'work/expense_claim/BX-123',
      id: 'BX-123',
      workDocumentId: 'BX-123',
    };
    expect(progressDossier(projection, { auditDocuments: [original] })).toBe(
      original,
    );
    expect(
      progressDossier(projection, {
        handledWorkDocuments: { 'BX-123': original },
      }),
    ).toBe(original);
    for (const record of [
      { ...projection, key: 'expense/expense_claim/BX-123' },
      { ...projection, source: { id: 'oa', label: 'OA' } },
      { ...projection, workDocumentId: undefined },
    ])
      expect(
        progressDossier(record, { auditDocuments: [original] }).person,
      ).not.toBe(original.person);
  });

  it('本地受理单只读取同业务单号的提交快照，保留每笔费用的多张发票和附件', () => {
    const photo = {
      id: 'file-a',
      name: '出租车.png',
      type: 'image/png',
      size: 3200,
    };
    const pdf = {
      id: 'invoice-fixture',
      name: '电子票.pdf',
      type: 'application/pdf',
      size: 2400,
    };
    const evidence = {
      id: 'file-other',
      name: '行程单.pdf',
      type: 'application/pdf',
      size: 500,
    };
    const snapshot = {
      ...createInitialDrafts().expense,
      purpose: '上海项目差旅',
      expenses: [
        {
          ...createBlankExpense('other-traffic'),
          amount: '36.24',
          name: '出租车',
          currency: 'CNY',
          files: [photo, pdf],
          attachments: [evidence],
        },
      ],
    };
    const item: SubmissionRequest = {
      id: 'req',
      businessId: 'LOCAL-123',
      draftId: snapshot.id,
      status: 'awaiting_receipt',
      createdAt: '2026-11-10',
      amountCents: 3624,
      applicant: '张伟',
      title: '差旅报销',
      snapshot,
    };
    const local = {
      ...expense,
      source: { id: 'local', label: '本地业务服务' },
      id: 'LOCAL-123',
      key: 'local/expense_claim/LOCAL-123',
    };
    const data = {
      submissions: { requests: [item] },
      materials: { files: [{ id: 'file-a', sha256: 'abc' }] },
    };
    const model = progressDossier(local, data);
    expect(model.expenses?.[0]).toMatchObject({
      amountCents: 3624,
      invoiceFileIds: ['file-a', 'invoice-fixture'],
    });
    expect(
      model.files?.map((file) => [file.id, file.kind, !!file.previewImageUrl]),
    ).toEqual([
      ['file-a', 'invoice', true],
      ['invoice-fixture', 'invoice', false],
      ['file-other', 'supporting', false],
    ]);
    expect(
      progressDossier({ ...local, id: 'another' }, data).expenses,
    ).toBeUndefined();
    expect(
      progressDossier({ ...local, source: expense.source }, data).expenses,
    ).toBeUndefined();
  });

  it('源单地址使用可信协议或完整编码的来源标识，工作单深链携带来源与引用键', () => {
    expect(
      progressDocumentHref({
        ...expense,
        sourceUrl: 'https://finance.example.com/forms/234',
      }),
    ).toBe('https://finance.example.com/forms/234');
    const generic = progressDocumentHref({
      ...expense,
      sourceUrl: 'javascript:alert(1)',
    });
    expect(
      new URL(generic, 'https://app.test').searchParams.get('progress-source'),
    ).toBe(expense.key);
    const key = 'work/expense_claim/' + expense.id;
    const work = new URL(
      progressDocumentHref({ ...expense, key, workDocumentId: expense.id }),
      'https://app.test',
    );
    expect(work.searchParams.get('progress-key')).toBe(key);
    expect(work.searchParams.get('source-system')).toBe(expense.source.id);
  });
});
