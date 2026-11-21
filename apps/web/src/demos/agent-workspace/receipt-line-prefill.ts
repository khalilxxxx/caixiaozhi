import {
  fieldLabels,
  type ExpenseField,
  type ExpenseItem,
  type ReceiptEvidence,
  type ReceiptField,
} from './submission-model.js';

const fields: ReceiptField[] = [
  'categoryId',
  'name',
  'reasonOption',
  ...(Object.keys(fieldLabels) as ExpenseField[]),
];

export function receiptCategoryOverride(item: ExpenseItem) {
  return item.categoryId &&
    (item.receiptManualFields?.includes('categoryId') ||
      item.receiptPrefill?.categoryId !== item.categoryId)
    ? item.categoryId
    : '';
}

export function receiptLineKey(item: ExpenseItem) {
  return JSON.stringify([
    item.files.map((file) => file.id),
    item.attachments.map((file) => file.id),
    receiptCategoryOverride(item),
  ]);
}

export function markReceiptFields(item: ExpenseItem, ...keys: ReceiptField[]) {
  return {
    ...item,
    receiptManualFields: [
      ...new Set([...(item.receiptManualFields ?? []), ...keys]),
    ],
  };
}

export function applyReceiptLine(
  current: ExpenseItem,
  projection: Partial<ExpenseItem>,
  evidence: ReceiptEvidence,
  isNew: boolean,
): ExpenseItem {
  const manual = new Set([
    ...(current.manualFields ?? []),
    ...(current.receiptManualFields ?? []),
  ]);
  const previous = current.receiptPrefill ?? {};
  const applied: Partial<Record<ReceiptField, string>> = {};
  const next = { ...current };
  for (const field of fields) {
    const value = projection[field] ?? '';
    // 手工清空的字段和原来已有的业务值均须保留。新行的系统默认可由票面更正。
    const initialDefault =
      isNew &&
      previous[field] === undefined &&
      ((field === 'currency' && current.currency === 'CNY') ||
        (field === 'rental' && current.rental === '否'));
    const owned = current[field] === (previous[field] ?? '') || initialDefault;
    if (!owned || manual.has(field)) continue;
    next[field] = value;
    if (value) applied[field] = value;
  }
  next.generated = Object.keys(applied).length > 0;
  next.sourceFileId = current.files[0]?.id;
  next.receiptPrefill = applied;
  next.receiptEvidence = evidence;
  next.receiptInvoiceNumbers = projection.receiptInvoiceNumbers ?? [];
  if (next.checkOut === applied.checkOut)
    next.aiCheckOut = projection.aiCheckOut ?? null;
  next.receiptReadKey = receiptLineKey(next);
  return next;
}
