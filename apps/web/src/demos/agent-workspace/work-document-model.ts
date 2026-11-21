import type { readAuditReview, ReviewDoc } from './RulesSubmission.js';
import { submissionLabels, type TravelLeg } from './submission-model.js';

export interface WorkExpense {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  reason: string;
  date: string;
  amountCents: number;
  currency: string;
  oaId?: string;
  people?: number;
  city?: string;
  nights?: number;
  rooms?: number;
  checkIn?: string;
  checkOut?: string;
  transport?: string;
  tripId?: string;
  sourceFileId?: string;
  invoiceFileIds?: string[];
}

export interface WorkFile {
  id: string;
  name: string;
  type: string;
  size: number;
  kind?: 'invoice' | 'supporting';
  previewImageUrl?: string;
  hasLocalOriginal?: boolean;
}

export interface WorkDocument extends ReviewDoc {
  decisionReview?: ReturnType<typeof readAuditReview>;
  decision?: {
    id: string;
    decision: 'approve' | 'return';
    reason: string;
    actor: string;
    decidedAt: string;
    fromVersion: number;
  };
  submittedAt?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  synthetic?: boolean;
  purpose?: string;
  paymentCompany?: string;
  travelType?: string;
  applicationId?: string;
  legs?: TravelLeg[];
  activities?: {
    id: string;
    oaNumber: string;
    description: string;
    effectiveDate: string;
    expiryDate: string;
    allocation: string;
  }[];
  expenses?: WorkExpense[];
  files?: WorkFile[];
  steps?: {
    label: string;
    actor: string;
    status: 'done' | 'current';
    time: string;
  }[];
  specificFields?: { label: string; value: string }[];
}

export function workDocumentTitle(
  doc: Pick<WorkDocument, 'person' | 'kind' | 'documentType'>,
) {
  const kind = doc.kind?.trim();
  const legacyLabel =
    kind === '出差申请'
      ? submissionLabels.travel
      : kind === '费用报销'
        ? submissionLabels.personal
        : kind;
  const label =
    (doc.documentType && submissionLabels[doc.documentType]) ||
    legacyLabel ||
    '单据';
  const person = doc.person?.trim();
  return person ? `${person}提交的${label}` : label;
}

interface WorkDocumentIndex {
  auditDocuments?: WorkDocument[];
  handledWorkDocuments?: Record<string, WorkDocument>;
}

export function findWorkDocument(data: WorkDocumentIndex, id: string) {
  return (
    data.auditDocuments?.find((doc) => doc.id === id) ??
    data.handledWorkDocuments?.[id]
  );
}

export function withWorkDocumentTitle<
  T extends { kind: string; id?: string; title: string },
>(reference: T, data: WorkDocumentIndex): T {
  if (reference.kind !== 'audit' || !reference.id) return reference;
  const doc = findWorkDocument(data, reference.id);
  return doc ? { ...reference, title: workDocumentTitle(doc) } : reference;
}

/** Read-only dossier fields shared by work review and progress queries. */
export type WorkDocumentContent = Pick<WorkDocument, 'id' | 'kind'> &
  Partial<
    Pick<
      WorkDocument,
      | 'system'
      | 'documentType'
      | 'person'
      | 'department'
      | 'amountCents'
      | 'days'
      | 'period'
      | 'attachment'
      | 'version'
      | 'stage'
      | 'submittedAt'
      | 'sourceLabel'
      | 'synthetic'
      | 'purpose'
      | 'paymentCompany'
      | 'travelType'
      | 'applicationId'
      | 'legs'
      | 'activities'
      | 'expenses'
      | 'files'
      | 'steps'
      | 'specificFields'
      | 'decision'
    >
  > & {
    total?: { label: string; value: string };
    expenseSummary?: string;
    itineraryFields?: { label: string; value: string }[];
  };
