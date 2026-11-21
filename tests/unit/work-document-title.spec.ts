import { expect, it } from 'vitest';
import {
  workDocumentTitle,
  withWorkDocumentTitle,
  type WorkDocument,
} from '../../apps/web/src/demos/agent-workspace/work-document-model';

it('单据标题优先使用业务类型，兼容旧类别，并保留其他 OA 单据的名称', () => {
  expect(
    workDocumentTitle({
      person: '林晓',
      kind: '费用报销',
      documentType: 'expense',
    }),
  ).toBe('林晓提交的差旅报销');
  expect(workDocumentTitle({ person: '陈澄', kind: '费用报销' })).toBe(
    '陈澄提交的个人费用报销',
  );
  expect(workDocumentTitle({ person: '许言', kind: '出差申请' })).toBe(
    '许言提交的差旅申请',
  );
  expect(workDocumentTitle({ person: ' 唐嘉 ', kind: '采购付款' })).toBe(
    '唐嘉提交的采购付款',
  );
  expect(workDocumentTitle({ person: '', kind: '请假申请' })).toBe('请假申请');
});

it('按原单 ID 更新旧对话引用的展示名，保留历史标题原值', () => {
  const doc = {
    id: 'BX-01',
    title: '上海客户拜访',
    person: '林晓',
    kind: '差旅报销',
  } as WorkDocument;
  const ref = { id: doc.id, kind: 'audit', title: doc.title, version: 'v3' };
  const result = { ...ref, title: '林晓提交的差旅报销' };
  expect(withWorkDocumentTitle(ref, { auditDocuments: [doc] })).toEqual(result);
  expect(
    withWorkDocumentTitle(ref, { handledWorkDocuments: { 'BX-01': doc } }),
  ).toEqual(result);
  expect(withWorkDocumentTitle(ref, {})).toBe(ref);
  expect(ref.title).toBe('上海客户拜访');
});
