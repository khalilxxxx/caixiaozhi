import { describe, expect, it } from 'vitest';
import {
  documentKey,
  presentDocument,
} from '../../apps/web/src/demos/document-query/document-model.js';
import { documents } from '../../apps/web/src/demos/document-query/fixtures.js';
import { getDocumentProgress } from '../../apps/web/src/demos/agent-workspace/document-progress.js';

describe('generic document presentation', () => {
  it('keeps identities distinct across systems and document types', () => {
    const base = documents[0]!;
    const variants = [
      base,
      { ...base, source: { id: 'oa', label: 'OA' } },
      { ...base, typeId: 'other' },
    ];
    expect(new Set(variants.map(documentKey)).size).toBe(3);
    expect(documentKey({ ...base, id: 'a/b' })).not.toBe(
      documentKey({ ...base, typeId: `${base.typeId}/a`, id: 'b' }),
    );
  });
  it('shows at most two meaningful summary fields and does not require money', () => {
    const leave = documents.find((doc) => doc.typeId === 'oa_leave')!;
    expect(leave.amount).toBeUndefined();
    expect(
      presentDocument(leave).cardSummary.map((field) => field.label),
    ).toEqual(['请假时间', '请假时长']);
    expect(
      documents.every((doc) => presentDocument(doc).cardSummary.length <= 2),
    ).toBe(true);
  });
  it('allows an unregistered document type to use nonempty supplied fields', () => {
    const view = presentDocument({
      ...documents[0]!,
      typeId: 'oa_seal',
      amount: undefined,
      summary: [
        { label: '空字段', value: '  ' },
        { label: '用印事由', value: '项目备案' },
        { label: '份数', value: '2份' },
        { label: '印章', value: '公章' },
      ],
    });
    expect(view.cardSummary.map((field) => field.label)).toEqual([
      '用印事由',
      '份数',
    ]);
  });
  it('does not carry approval estimates into execution or returned documents', () => {
    const travel = documents[0]!;
    expect(presentDocument(travel).estimateLabel).toBeTruthy();
    expect(
      presentDocument({ ...travel, phase: 'execution' }).estimateLabel,
    ).toBeUndefined();
    expect(
      presentDocument({ ...travel, status: 'needs_action' }).estimateLabel,
    ).toBeUndefined();
    expect(
      presentDocument({ ...travel, status: 'completed' }).estimateLabel,
    ).toBeUndefined();
  });
  it('retains pending payment after approval and names the shared task pool', () => {
    const payment = documents.find((doc) => doc.typeId === 'payment_request')!;
    expect(payment.status).toBe('processing');
    expect(payment.phase).toBe('execution');
    expect(presentDocument(payment).displayStatus).toBe('待付款');
    expect(presentDocument(payment).currentLabel).toContain('资金共享中心');
    expect(presentDocument(payment).estimateLabel).toBeUndefined();
  });
});

describe('approval tracking for the workspace', () => {
  it('shows only the pending countersigner, separates payment handlers and uses a receipt without inventing its approver', () => {
    const contract = documents.find(
      (doc) => doc.typeId === 'contract_approval',
    )!;
    expect(getDocumentProgress(contract)).toMatchObject({
      role: '当前审批人',
      actors: ['张伟'],
    });
    const payment = documents.find((doc) => doc.phase === 'execution')!;
    expect(getDocumentProgress(payment)).toMatchObject({
      role: '办理方',
      actors: ['资金共享中心'],
      status: '待付款',
    });
    const local = {
      ...documents[0]!,
      current: undefined,
      steps: [
        { id: 'review', label: '待本地审批', status: 'current' as const },
      ],
    };
    expect(getDocumentProgress(local)).toMatchObject({
      node: '待本地审批',
      actors: [],
    });
    const parallel = {
      ...local,
      steps: [
        {
          id: 'manager',
          label: '部门审核',
          actors: ['李婷'],
          status: 'current' as const,
        },
        {
          id: 'legal',
          label: '法务审核',
          actors: ['张伟'],
          status: 'current' as const,
        },
      ],
    };
    expect(getDocumentProgress(parallel)).toMatchObject({
      node: '部门审核、法务审核',
      actors: ['李婷', '张伟'],
    });
    const finished = {
      ...contract,
      status: 'completed' as const,
      phase: 'closed' as const,
      phaseLabel: '审批完成',
    };
    expect(getDocumentProgress(finished)).toMatchObject({
      node: '审批完成',
      actors: [],
    });
  });
});
