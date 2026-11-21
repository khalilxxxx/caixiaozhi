import type { ResultCard, Task } from './workspace';
import { readSubmissionState, resolveDraftId } from './submission-state';
import { materialsInitial, materialBatchId } from './Documents';
import {
  materialExpenseError,
  materialSelectionId,
  selectMaterialScope,
} from './material-import';
import { getAuditSummary } from './RulesSubmission';
import { getSubmissionSummary } from './SubmissionWorkspace';
import { withWorkDocumentTitle } from './work-document-model';

export function materialSummary(
  data: Record<string, any>,
  selection?: { fileIds?: string[]; batchId?: string },
): ResultCard {
  const all = (data.materials ?? materialsInitial) as typeof materialsInitial;
  const s = selection ? selectMaterialScope(all, selection) : all;
  const items = s.items.filter((i) => !i.excluded),
    pending = items.filter(
      (i) => !i.confirmed || !!materialExpenseError(i),
    ).length;
  const total = items.reduce((sum, i) => sum + (i.amount ?? 0), 0);
  const batchId = selection?.fileIds
    ? materialSelectionId(s.files)
    : selection?.batchId;
  const status = pending
    ? `${pending}项待核对`
    : !items.length
      ? s.files.some((file) => file.status === 'failed')
        ? '无法提取费用'
        : s.files.length
          ? '待提取费用'
          : '暂无费用'
      : s.importedRevision === s.revision &&
          (!batchId || s.importedSelectionId === batchId)
        ? '已生成草稿'
        : s.savedRevision === s.revision &&
            (!batchId || s.savedSelectionId === batchId)
          ? '费用已保存'
          : '待确认费用';
  return {
    kind: 'materials',
    id: materialBatchId,
    title: '材料与费用',
    subtitle: `${items.length} 笔费用 · ¥${(total / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`,
    status,
    tone: pending || !items.length ? 'amber' : 'green',
    data: { revision: s.revision, pending },
  };
}
export function currentCard(
  card: ResultCard,
  data: Record<string, any>,
): ResultCard {
  if (card.kind === 'materials') {
    if (card.data?.reimbursementBatchId || card.data?.reimbursementFileIds) {
      const state = readSubmissionState(data);
      const draftId = card.data.draftId;
      const draft = state.edits[draftId] ?? state.drafts[draftId];
      return card.data.reimbursementBatchId && draft?.expenses.some((item) => item.sourceBatchId === card.data?.reimbursementBatchId)
        ? { ...card, status: '费用已生成', tone: 'green' } : card;
    }
    const summary = materialSummary(data, {
      fileIds: card.data?.fileIds,
      batchId: card.id,
    });
    return {
      ...card,
      ...summary,
      id: card.id,
      data: { ...card.data, ...summary.data },
    };
  }
  if (card.kind === 'submission') {
    if (card.data?.requestId) return card;
    const latest = getSubmissionSummary(
      data,
      resolveDraftId(card.id),
    );
    return {
      ...card,
      ...latest,
      status:
        card.data?.version && latest.data?.version !== card.data.version
          ? `已更新 · v${latest.data?.version}`
          : latest.status,
    };
  }
  if (card.kind === 'audit' && (!card.id || card.id === 'batch')) {
    const latest = getAuditSummary(data),
      old = card.data ?? { attention: 3, unknown: 1, clear: 4 };
    return {
      ...card,
      subtitle: latest.subtitle,
      status: latest.data?.stale
        ? '需重新审查'
        : old.attention !== latest.data?.attention ||
            old.unknown !== latest.data?.unknown
          ? '结果已更新'
          : card.status,
      tone: latest.data?.stale ? 'amber' : card.tone,
    };
  }
  return withWorkDocumentTitle(card, data);
}
export function syncTaskStates(
  tasks: Task[],
  data: Record<string, any>,
  changed: string,
): Task[] {
  if (!['materials', 'rulesSubmission', 'submissions'].includes(changed))
    return tasks;
  return tasks.map((t) => {
    if (t.status === '处理中' || t.status === '已暂停' ||
        t.messages.some((message) => message.question?.status === 'pending')) return t;
    let status = t.status;
    if (t.type === 'materials') {
      const material = materialSummary(data),
        s = (data.materials ?? materialsInitial) as typeof materialsInitial;
      status = material.data?.pending
        ? '待我核对'
        : s.importedRevision === s.revision
          ? ['expense', 'personal'].some(
              (id) =>
                getSubmissionSummary(data, id as 'expense' | 'personal')
                  .status === '待回执',
            )
            ? '待回执'
            : '待我补充'
          : s.savedRevision === s.revision
            ? '已完成'
            : '待我确认';
    } else if (t.type === 'submission') {
      const ref = t.messages
        .flatMap((m) => m.cards ?? [])
        .filter((c) => c.kind === 'submission')
        .at(-1);
      const summary = getSubmissionSummary(
        data,
        resolveDraftId(ref?.id),
      );
      status =
        summary.status === '本地已受理'
          ? '本地已受理'
          : summary.status === '待回执'
            ? '待回执'
            : summary.status === '待确认提交'
              ? '待我确认'
              : '待我补充';
    }
    return status === t.status ? t : { ...t, status };
  });
}
