import type {
  DocumentField,
  GenericDocument,
} from '../document-query/document-model';
import {
  amountCents,
  getExpenseCategory,
  getDraftType,
  type Attachment,
  type SubmissionDraft,
} from './submission-model';
import type { SubmissionRequest } from './submission-state';
import type {
  WorkDocument,
  WorkDocumentContent,
  WorkExpense,
  WorkFile,
} from './work-document-model';

export type ProgressDossierRecord = GenericDocument &
  Pick<
    WorkDocumentContent,
    | 'version'
    | 'synthetic'
    | 'expenses'
    | 'files'
    | 'legs'
    | 'activities'
    | 'amountCents'
  > & { workDocumentId?: string };

function snapshotDossier(
  request: SubmissionRequest,
  storedFileIds: Set<string>,
): Partial<WorkDocumentContent> {
  const draft: SubmissionDraft = request.snapshot;
  const files = new Map<string, WorkFile>();
  function addFile(file: Attachment, kind: 'invoice' | 'supporting') {
    const previous = files.get(file.id);
    if (previous?.kind === 'invoice') return;
    const url = '/api/local/files/' + encodeURIComponent(file.id);
    const stored = storedFileIds.has(file.id);
    const preview =
      stored &&
      kind === 'invoice' &&
      /\.(pdf|jpg|jpeg|png|webp)$/i.test(file.name);
    files.set(file.id, {
      ...file,
      kind,
      previewImageUrl: preview ? url + '/pages/1' : undefined,
      hasLocalOriginal: stored,
    });
  }
  for (const file of draft.files ?? []) addFile(file, 'supporting');
  const expenses: WorkExpense[] | undefined = draft.expenses?.flatMap(
    (expense) => {
      for (const file of expense.files ?? []) addFile(file, 'invoice');
      for (const file of expense.attachments ?? []) addFile(file, 'supporting');
      const cents = amountCents(String(expense.amount ?? ''));
      if (cents === null) return [];
      const categoryName =
        getExpenseCategory(expense.categoryId)?.label || expense.categoryId;
      return [
        {
          id: expense.id,
          name: expense.name || categoryName,
          categoryId: expense.categoryId,
          categoryName,
          reason: expense.reason,
          date: expense.date || expense.checkIn || expense.departureDate,
          amountCents: cents,
          currency: expense.currency,
          nights: Number(expense.nights) || undefined,
          people: Number(expense.people) || undefined,
          oaId: expense.oaId,
          sourceFileId: expense.sourceFileId,
          invoiceFileIds: expense.files?.map((file) => file.id),
        },
      ];
    },
  );
  return {
    documentType: getDraftType(draft),
    person: draft.applicant,
    department: draft.department,
    paymentCompany: draft.paymentCompany,
    purpose: draft.purpose,
    applicationId: draft.applicationId,
    travelType: draft.travelType,
    legs: draft.legs,
    activities: draft.activities,
    expenses,
    files: [...files.values()],
    version: draft.version,
  };
}

export function progressDossier(
  record: ProgressDossierRecord,
  data: {
    auditDocuments?: WorkDocument[];
    handledWorkDocuments?: Record<string, WorkDocument>;
    submissions?: { requests?: SubmissionRequest[] };
    materials?: { files?: { id: string; sha256?: string }[] };
  },
  view: 'progress' | 'source' = 'progress',
): WorkDocumentContent {
  if (
    record.workDocumentId === record.id &&
    record.key === `work/${record.typeId}/${record.id}`
  ) {
    const original =
      data.auditDocuments?.find((item) => item.id === record.id) ??
      data.handledWorkDocuments?.[record.id];
    if (original?.id === record.id && original.system === record.source.id) {
      return original;
    }
  }
  const field = (label: string) =>
    record.details.find((item) => item.label === label)?.value ||
    record.summary.find((item) => item.label === label)?.value;
  const expense = record.typeId === 'expense_claim';
  const travel = record.typeId === 'travel_application';
  const request =
    record.source.id === 'local' &&
    data.submissions?.requests?.find(
      (item) =>
        item.businessId === record.id &&
        item.snapshot &&
        (getDraftType(item.snapshot) === 'travel' ? travel : expense),
    );
  const snapshot = request
    ? snapshotDossier(
        request,
        new Set(
          (data.materials?.files ?? [])
            .filter((file) => file.sha256)
            .map((file) => file.id),
        ),
      )
    : undefined;
  const omitted = new Set([
    '申请人',
    '所属部门',
    '部门',
    '申请单号',
    '事由',
    '数据来源',
  ]);
  if (record.amount) omitted.add(record.amount.label);
  if (snapshot?.paymentCompany) omitted.add('所属公司');
  if (expense) omitted.add('费用明细');
  const itineraryFields: DocumentField[] = [];
  if (travel) {
    if (view === 'progress') {
      omitted.add('申请预算');
      omitted.add('出差时间');
    }
    ['去程', '返程'].forEach((label) => omitted.add(label));
    itineraryFields.push(
      ...record.details.filter((item) => ['去程', '返程'].includes(item.label)),
    );
  }
  // Workflow fields are presented with the approval history. Older sources may omit steps.
  const represented = (record.steps ?? []).some(
    (step) => step.status === 'returned',
  );
  if (view === 'progress') {
    omitted.add('退回原因');
    if (represented || !record.steps?.length) omitted.add('退回人');
  }
  if (view === 'progress' && record.current?.rule === 'all') {
    ['会签规则', '已通过', '待处理'].forEach((label) => omitted.add(label));
  }
  const fields = new Map(record.summary.map((item) => [item.label, item]));
  for (const item of record.details) fields.set(item.label, item);
  if (
    travel &&
    (record.legs?.length || snapshot?.legs?.length || itineraryFields.length)
  )
    fields.delete('行程');
  return {
    id: record.id,
    kind: record.typeLabel,
    system: expense ? 'expense' : record.source.id === 'oa' ? 'oa' : undefined,
    documentType: travel ? 'travel' : expense ? 'expense' : undefined,
    person: field('申请人'),
    department: field('所属部门') || field('部门'),
    purpose: field('事由'),
    specificFields: [...fields.values()].filter(
      (item) => !omitted.has(item.label),
    ),
    total: record.amount,
    amountCents: record.amountCents,
    itineraryFields,
    legs: record.legs,
    activities: record.activities,
    expenses: record.expenses,
    files: record.files,
    version: record.version,
    synthetic: record.synthetic,
    expenseSummary:
      expense && !record.expenses && !snapshot?.expenses
        ? field('费用明细')
        : undefined,
    ...snapshot,
  };
}
