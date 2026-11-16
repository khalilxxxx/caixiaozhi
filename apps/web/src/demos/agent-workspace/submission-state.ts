import {
  affectedMaterialDrafts,
  amountCents,
  draftTotal,
  importMaterialExpenses,
  migrateLegacyDrafts,
  type Attachment,
  type DraftId,
  type MaterialExpenseImport,
  type SubmissionDraft,
} from './submission-model.js';

export const SUBMISSIONS_KEY = 'submissions';
export const draftIds: DraftId[] = ['travel', 'expense', 'personal'];

export interface SubmissionRequest<TCheck = unknown> {
  id: string;
  draftId: DraftId;
  title: string;
  applicant: string;
  amountCents: number;
  createdAt: string;
  status: 'awaiting_receipt';
  snapshot: SubmissionDraft;
  check?: TCheck;
  receiptCheckedAt?: string;
  receiptId?: string;
  businessId?: string;
  localStatus?: 'accepted' | 'submitted';
  legacySnapshot?: unknown;
}

export interface SubmissionState<TCheck = unknown> {
  drafts: Record<DraftId, SubmissionDraft>;
  edits: Partial<Record<DraftId, SubmissionDraft>>;
  checks: Partial<Record<DraftId, TCheck>>;
  requests: SubmissionRequest<TCheck>[];
}

export function resolveDraftId(id?: string): DraftId {
  return id === 'travel' || id === 'personal' ? id : 'expense';
}

export function submissionDraftForText(text: string): DraftId {
  if (/报销/.test(text))
    return /个人|日常|非差旅/.test(text) ? 'personal' : 'expense';
  return /差旅申请|出差申请|申请.*出差|申请差旅/.test(text)
    ? 'travel'
    : 'expense';
}

function withIdentityDefaults(drafts: Record<DraftId, SubmissionDraft>) {
  const next = { ...drafts };
  for (const id of draftIds) {
    const draft = drafts[id];
    next[id] = {
      ...draft,
      applicant: draft.applicant || '林悦',
      department: draft.department || '财务部',
      paymentCompany: draft.paymentCompany || '华川科技',
      travelType: draft.travelType || '普通差旅',
    };
  }
  return next;
}

function restoreFileMetadata(
  drafts: Record<DraftId, SubmissionDraft>,
  files: Attachment[],
) {
  for (const draft of Object.values(drafts)) {
    draft.expenses = draft.expenses.map((expense) => {
      if (expense.files.length || !expense.sourceFileId) return expense;
      const file = files.find((item) => item.id === expense.sourceFileId) ?? {
        id: expense.sourceFileId,
        name: '历史关联发票',
        size: 0,
        type: 'application/octet-stream',
      };
      return { ...expense, files: [file] };
    });
  }
  return drafts;
}

export function readSubmissionState<TCheck = unknown>(
  data: Record<string, any>,
  fallbackFiles: Attachment[] = [],
): SubmissionState<TCheck> {
  if (data[SUBMISSIONS_KEY])
    return data[SUBMISSIONS_KEY] as SubmissionState<TCheck>;
  const legacy = data.rulesSubmission;
  const knownFiles = [
    ...fallbackFiles,
    ...(data.materials?.files ?? []),
    ...(data.expenseDraft?.files ?? []),
  ];
  const migrate = (input: unknown) =>
    restoreFileMetadata(
      withIdentityDefaults(migrateLegacyDrafts(input)),
      knownFiles,
    );
  const drafts = migrate(legacy);
  const requests: SubmissionRequest<TCheck>[] = (legacy?.requests ?? []).map(
    (request: any) => {
      const draftId = resolveDraftId(request.draftId);
      const migrated = migrate({ drafts: { [draftId]: request.snapshot } });
      return {
        id: request.id,
        draftId,
        title: request.title,
        applicant: migrated[draftId].applicant,
        amountCents: request.amountCents ?? draftTotal(migrated[draftId]),
        createdAt: request.createdAt,
        status: 'awaiting_receipt',
        snapshot: migrated[draftId],
        legacySnapshot: request.snapshot,
        receiptCheckedAt: request.receiptCheckedAt,
      };
    },
  );
  const edits: SubmissionState<TCheck>['edits'] = {};
  for (const id of draftIds) {
    const edit = legacy?.edits?.[id];
    if (!edit || !legacy?.drafts?.[id]) continue;
    const saved = legacy.drafts[id];
    const merged = {
      ...saved,
      ...edit,
      transportCents: amountCents(edit.transport ?? '') ?? saved.transportCents,
      hotelCents: amountCents(edit.hotel ?? '') ?? saved.hotelCents,
      mealCents: amountCents(edit.meal ?? '') ?? saved.mealCents,
      nights: Number(edit.nights ?? saved.nights),
      expenseLines: saved.expenseLines?.map((line: any) => ({
        ...line,
        amountCents:
          amountCents(edit.lineAmounts?.[line.id] ?? '') ?? line.amountCents,
        nights: Number(edit.lineNights?.[line.id] ?? line.nights),
      })),
    };
    edits[id] = migrate({ drafts: { [id]: merged } })[id];
  }
  return { drafts, edits, checks: {}, requests };
}

export function applyMaterialBatch<TCheck>(
  state: SubmissionState<TCheck>,
  incoming: MaterialExpenseImport,
): SubmissionState<TCheck> {
  const affected = affectedMaterialDrafts(state.drafts, incoming);
  if (affected.some((id) => state.drafts[id].status === 'awaiting_receipt'))
    return state;
  const drafts = importMaterialExpenses(state.drafts, incoming);
  if (drafts === state.drafts) return state;
  const effectiveDrafts = { ...state.drafts, ...state.edits };
  const mergedEdits = importMaterialExpenses(effectiveDrafts, incoming);
  const edits = { ...state.edits };
  for (const id of affected) {
    if (edits[id])
      edits[id] = {
        ...mergedEdits[id],
        version: drafts[id].version,
        savedAt: drafts[id].savedAt,
      };
  }
  return { ...state, drafts, edits };
}
