import { getExpenseCategory, materialCategoryId } from './submission-model';

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
  category: '交通' | '住宿' | '餐饮' | '办公' | '其他' | null;
  categoryId?: string | null;
  categoryHint?:
    'unclear' | 'mixed' | 'meal-purpose' | 'meal-oa' | 'travel-misc';
  amount: number | null;
  date: string;
  end?: string;
  purpose: string;
  oaId?: string;
  tripId?: string;
  matchedDraftId?: string;
  tripMode?: string;
  departureCity?: string;
  arrivalCity?: string;
  city?: string;
  transport?: string;
  group: 'travel' | 'daily' | null;
  sourceFileId: string;
  confirmed: boolean;
  issue?: string;
  issues?: string[];
  evidence?: Record<string, string>;
  excluded?: boolean;
}

export const materialBatchId = 'batch-20261111';

export function materialExpenseCategory(item: MaterialExpense) {
  return getExpenseCategory(
    materialCategoryId(item, item.group === 'daily' ? 'personal' : 'expense'),
  );
}

export function materialCategoryQuestion(item: MaterialExpense): string {
  if (materialExpenseCategory(item)) return '';
  if (item.categoryHint === 'meal-oa')
    return '请核对接待 OA 单号，再选择费用类型。';
  if (item.categoryHint === 'meal-purpose' || item.category === '餐饮')
    return '请确认用餐用途。属于客户招待时，选择对应的餐饮类型。';
  if (item.categoryHint === 'mixed')
    return '票面含多种服务。请核对本笔报销项目并选择费用类型。';
  if (item.categoryHint === 'travel-misc')
    return '请核对是否属于差旅产生的长途交通杂费。';
  return '请查看票面的商品或服务明细，再选择费用类型。';
}

export function draftMaterialFileIds(
  draft:
    | {
        materialIds: string[];
        expenses: { sourceFileId?: string; files: { id: string }[] }[];
      }
    | undefined,
  selected: string[],
): string[] {
  const ids = new Set(draft?.materialIds);
  for (const expense of draft?.expenses ?? []) {
    if (expense.sourceFileId) ids.add(expense.sourceFileId);
    for (const invoice of expense.files) ids.add(invoice.id);
  }
  for (const id of selected) ids.add(id);
  return [...ids];
}

export function materialExpenseError(item: MaterialExpense): string {
  if (!item.name.trim()) return '请填写费用名称。';
  if (
    !Number.isSafeInteger(item.amount) ||
    (item.amount ?? 0) <= 0 ||
    (item.amount ?? 0) > 10000000000
  )
    return '请填写大于零且最多两位小数的有效金额。';
  const category = materialExpenseCategory(item);
  if (!category) return materialCategoryQuestion(item);
  if (!['travel', 'daily'].includes(item.group ?? ''))
    return '请选择费用归属。';
  if ((item.date || category.template !== 'T01') && !isMaterialDate(item.date))
    return '请填写有效的费用日期。';
  if (!item.purpose.trim()) return '请填写实际用途。';
  if (
    ['T03', 'T09'].includes(category.template) &&
    (!item.end || !isMaterialDate(item.end) || item.end <= item.date)
  )
    return '离店日期应晚于入住日期。';
  if (category.id === 'reception-meal-oa' && !item.oaId?.trim())
    return '请填写对应的 OA 申请。';
  return '';
}

function isMaterialDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
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
        ['T03', 'T09'].includes(
          materialExpenseCategory(item)?.template ?? '',
        ) &&
        Number.isFinite(duration) &&
        duration > 0
          ? Math.round(duration / 86400000)
          : undefined;
      return {
        ...item,
        category: item.category ?? '',
        categoryId: materialExpenseCategory(item)?.id ?? null,
        start: item.date,
        nights,
      };
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
