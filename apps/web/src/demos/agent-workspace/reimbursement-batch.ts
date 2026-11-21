import { materialBatchId, type MaterialFile } from './material-import.js';
import type { ActivityAssignment, ExpenseItem } from './submission-model.js';

export interface BatchFile extends MaterialFile {
  recognition?: {
    role?: 'invoice' | 'payment' | 'supporting' | 'unknown';
    multipleDocuments?: boolean;
    facts?: {
      merchant?: string;
      date?: string;
      amount?: number;
      currency?: string;
    };
    reviewIssues?: { field: string; message: string }[];
  };
}

export interface ExpenseAssignment {
  invoiceFileIds: string[];
  attachmentFileIds: string[];
  categoryId?: string;
}

export interface BatchExpense extends ExpenseAssignment {
  id: string;
  expense: ExpenseItem;
  issues: string[];
  evidence: Record<string, { fileId: string; quote: string }[]>;
}

export interface ReimbursementBatch {
  id: string;
  draftId: string;
  revision: number;
  status: 'review' | 'applied';
  files: BatchFile[];
  groups: BatchExpense[];
  unassignedFileIds: string[];
  unavailableFileIds?: string[];
  unassignedReasons: Record<string, string>;
  header: { purpose: string; activities: ActivityAssignment[] };
}

export interface EditableGroup extends ExpenseAssignment {
  id: string;
}
export type FileRole = 'invoiceFileIds' | 'attachmentFileIds';

export function isUnreadable(file: BatchFile) {
  return (
    file.status === 'failed' ||
    ['failed', 'unreadable'].includes(file.extractionStatus ?? '')
  );
}

export function editableGroups(batch: ReimbursementBatch): EditableGroup[] {
  return batch.groups.map(
    ({ id, invoiceFileIds, attachmentFileIds, categoryId }) => ({
      id,
      invoiceFileIds,
      attachmentFileIds,
      categoryId: categoryId || undefined,
    }),
  );
}

// Empty groups disappear when their last file moves. Other groups retain a stable identity.
export function assignBatchFile(
  groups: EditableGroup[],
  fileId: string,
  targetId: string,
  role: FileRole,
) {
  const next = groups.map((group) => ({
    ...group,
    invoiceFileIds: group.invoiceFileIds.filter((id) => id !== fileId),
    attachmentFileIds: group.attachmentFileIds.filter((id) => id !== fileId),
  }));
  if (targetId) {
    let target = next.find((group) => group.id === targetId);
    if (!target) {
      target = { id: targetId, invoiceFileIds: [], attachmentFileIds: [] };
      next.push(target);
    }
    target[role].push(fileId);
  }
  return next.filter(
    (group) => group.invoiceFileIds.length || group.attachmentFileIds.length,
  );
}

export function groupAssignments(groups: EditableGroup[]): ExpenseAssignment[] {
  return groups.map(({ invoiceFileIds, attachmentFileIds, categoryId }) => ({
    invoiceFileIds,
    attachmentFileIds,
    ...(categoryId ? { categoryId } : {}),
  }));
}

export function isReimbursementPanel(
  panel:
    | { kind: string; id?: string; data?: Record<string, unknown> }
    | null
    | undefined,
) {
  return (
    panel?.kind === 'materials' &&
    typeof panel.data?.draftId === 'string' &&
    !!(
      panel.data.reimbursementBatchId ||
      panel.data.reimbursementFileIds ||
      (!panel.data.fileId &&
        !panel.data.fileIds &&
        (!panel.id || panel.id === materialBatchId))
    )
  );
}
