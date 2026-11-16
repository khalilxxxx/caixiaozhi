export interface MaterialFile {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  addedAt: string;
  status: 'recognized' | 'duplicate' | 'failed' | 'pending';
  batchId: string;
}

export interface MaterialExpense {
  id: string;
  name: string;
  category: '交通' | '住宿' | '餐饮' | '办公';
  amount: number;
  date: string;
  end?: string;
  purpose: string;
  oaId?: string;
  group: 'travel' | 'daily';
  sourceFileId: string;
  confirmed: boolean;
  issue?: 'date' | 'oa' | 'purpose';
  excluded?: boolean;
}

export const materialBatchId = 'batch-20261111';

export function buildMaterialExpenseBatch(state: {
  items: MaterialExpense[];
  files: MaterialFile[];
  revision: number;
}) {
  const items = state.items
    .filter((item) => !item.excluded)
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
    id: materialBatchId,
    materialBatchId,
    title: '上海客户拜访与个人费用',
    amount: items.reduce((sum, item) => sum + item.amount, 0),
    items,
    materialIds,
    files: state.files
      .filter((file) => materialIds.includes(file.id))
      .map((file) => ({ ...file })),
    revision: state.revision,
  };
}
