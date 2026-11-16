import type { ResultCard, Task } from './workspace';
import { materialsInitial, materialBatchId } from './Documents';
import { getAuditSummary } from './RulesSubmission';
import { getSubmissionSummary } from './SubmissionWorkspace';

export function materialSummary(data: Record<string, any>): ResultCard {
  const s = (data.materials ?? materialsInitial) as typeof materialsInitial;
  const items = s.items.filter((i) => !i.excluded),
    pending = items.filter((i) => !i.confirmed).length;
  const total = items.reduce((sum, i) => sum + i.amount, 0);
  const status = pending
    ? `${pending}项待核对`
    : s.importedRevision === s.revision
      ? '已生成草稿'
      : s.savedRevision === s.revision
        ? '费用已保存'
        : '待确认用途';
  return {
    kind: 'materials',
    id: materialBatchId,
    title: '材料与费用',
    subtitle: `${items.length} 笔有效费用 · ¥${(total / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`,
    status,
    tone: pending ? 'amber' : 'green',
    data: { revision: s.revision, pending },
  };
}
export function currentCard(
  card: ResultCard,
  data: Record<string, any>,
): ResultCard {
  if (card.kind === 'materials') return { ...card, ...materialSummary(data) };
  if (card.kind === 'submission') {
    if (card.data?.requestId) return card;
    const latest = getSubmissionSummary(
      data,
      card.id === 'travel' || card.id === 'personal' ? card.id : 'expense',
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
  return card;
}
export function syncTaskStates(
  tasks: Task[],
  data: Record<string, any>,
  changed: string,
): Task[] {
  if (!['materials', 'rulesSubmission', 'submissions'].includes(changed))
    return tasks;
  return tasks.map((t) => {
    if (t.status === '处理中' || t.status === '已暂停') return t;
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
        ref?.id === 'travel' || ref?.id === 'personal' ? ref.id : 'expense',
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
