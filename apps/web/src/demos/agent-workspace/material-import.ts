export interface MaterialFile {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  addedAt: string;
  status: 'recognized' | 'duplicate' | 'failed' | 'pending';
  batchId: string;
  extractionStatus?: string;
  extractionError?: string;
  error?: string;
}

export interface MaterialExpense {
  id: string;
  name: string;
  category: '交通' | '住宿' | '餐饮' | '办公' | null;
  amount: number | null;
  date: string;
  end?: string;
  purpose: string;
  oaId?: string;
  group: 'travel' | 'daily' | null;
  sourceFileId: string;
  confirmed: boolean;
  issue?: string;
  issues?: string[];
  evidence?: Record<string, string>;
  excluded?: boolean;
}

export const materialBatchId = 'batch-20261111';

export function materialExpenseError(item: MaterialExpense): string {
  if (!item.name.trim()) return '请填写费用名称。';
  if (
    !Number.isSafeInteger(item.amount) ||
    (item.amount ?? 0) <= 0 ||
    (item.amount ?? 0) > 10000000000
  )
    return '请填写大于零且最多两位小数的有效金额。';
  if (!['交通', '住宿', '餐饮', '办公'].includes(item.category ?? ''))
    return '请选择费用类别。';
  if (!['travel', 'daily'].includes(item.group ?? ''))
    return '请选择费用归属。';
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
    !Number.isFinite(Date.parse(item.date)) ||
    new Date(item.date).toISOString().slice(0, 10) !== item.date
  )
    return '请填写有效的费用日期。';
  if (!item.purpose.trim()) return '请填写实际用途。';
  if (
    item.category === '住宿' &&
    (!item.end ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.end) ||
      !Number.isFinite(Date.parse(item.end)) ||
      new Date(item.end).toISOString().slice(0, 10) !== item.end ||
      item.end <= item.date)
  )
    return '离店日期应晚于入住日期。';
  if (item.issue === 'oa' && !item.oaId) return '请填写对应的 OA 申请。';
  return '';
}

export function selectMaterialScope<
  T extends { files: MaterialFile[]; items: MaterialExpense[] },
>(
  state: T,
  selection: { fileIds?: string[]; fileId?: string; batchId?: string },
): T {
  const selected = new Set(
    selection.fileIds ?? (selection.fileId ? [selection.fileId] : []),
  );
  const explicitFiles =
    selection.fileIds !== undefined || selection.fileId !== undefined;
  const files = state.files.filter((file) =>
    explicitFiles
      ? selected.has(file.id)
      : !!selection.batchId && file.batchId === selection.batchId,
  );
  const ids = new Set(files.map((file) => file.id));
  return {
    ...state,
    files,
    items: state.items.filter((item) => ids.has(item.sourceFileId)),
  };
}

export function materialSelectionId(files: MaterialFile[]): string {
  let hash = 2166136261;
  for (const character of files
    .map((file) => file.id)
    .sort()
    .join('|'))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `batch-selection-${(hash >>> 0).toString(36)}`;
}

export function buildMaterialExpenseBatch(
  state: {
    items: MaterialExpense[];
    files: MaterialFile[];
    revision: number;
  },
  batchId = materialBatchId,
) {
  const items = state.items
    .filter(
      (
        item,
      ): item is MaterialExpense & {
        amount: number;
        category: NonNullable<MaterialExpense['category']>;
        group: NonNullable<MaterialExpense['group']>;
      } =>
        !item.excluded &&
        item.confirmed &&
        !materialExpenseError(item) &&
        state.files.some(
          (file) =>
            file.id === item.sourceFileId && file.status === 'recognized',
        ),
    )
    .map((item) => {
      const duration = Date.parse(item.end ?? '') - Date.parse(item.date);
      const nights =
        item.category === '住宿' && Number.isFinite(duration) && duration > 0
          ? Math.round(duration / 86400000)
          : undefined;
      return { ...item, start: item.date, nights };
    });
  const materialIds = [...new Set(items.map((item) => item.sourceFileId))];
  return {
    id: batchId,
    materialBatchId: batchId,
    title: '已核对费用',
    amount: items.reduce((sum, item) => sum + item.amount, 0),
    items,
    materialIds,
    files: state.files
      .filter((file) => materialIds.includes(file.id))
      .map((file) => ({ ...file })),
    revision: state.revision,
  };
}
