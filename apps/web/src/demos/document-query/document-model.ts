/**
 * Read-only presentation model for the document-query prototype.
 * This is intentionally separate from production resource and workflow contracts.
 */
export type DocumentStatus =
  'draft' | 'processing' | 'needs_action' | 'completed' | 'closed' | 'unknown';

export type DocumentPhase = 'approval' | 'execution' | 'closed' | 'unknown';

export interface DocumentField {
  label: string;
  value: string;
}

export interface DocumentStep {
  id: string;
  label: string;
  status: 'done' | 'current' | 'future' | 'conditional' | 'returned';
  actors?: string[];
  time?: string;
  note?: string;
}

export interface GenericDocument {
  key: string;
  source: { id: string; label: string };
  sourceUrl?: string;
  typeId: string;
  typeLabel: string;
  id: string;
  title: string;
  /** The source's user-facing business status. Never replace it with a color. */
  sourceStatus: string;
  /** A filtering group, not a replacement for the original lifecycle. */
  status: DocumentStatus;
  phase: DocumentPhase;
  phaseLabel: string;
  current?: {
    label: string;
    /** Only the people/groups currently responsible, not past approvers. */
    actors: string[];
    rule?: string;
    since?: string;
  };
  summary: DocumentField[];
  /** value is already formatted for display; currency remains explicit metadata. */
  amount?: { label: string; value: string; currency: string };
  estimate?: {
    label: string;
    compactLabel?: string;
    basis: string;
    target: string;
  };
  updatedAt: string;
  details: DocumentField[];
  steps: DocumentStep[];
  paymentStatus?: string;
}

export interface DocumentTypeDefinition {
  label: string;
  /** Ordered field labels selected from summary plus the optional amount slot. */
  summaryOrder: readonly string[];
}

/**
 * New document types register their compact summary here, rather than adding
 * type-specific branches to the shared card component.
 */
export const documentTypeRegistry: Readonly<
  Record<string, DocumentTypeDefinition>
> = {
  travel_application: { label: '差旅申请', summaryOrder: ['行程', '出差时间'] },
  expense_claim: { label: '费用报销', summaryOrder: ['报销金额', '费用期间'] },
  oa_leave: { label: '请假申请', summaryOrder: ['请假时间', '请假时长'] },
  payment_request: { label: '采购付款', summaryOrder: ['付款金额', '收款方'] },
  contract_approval: {
    label: '合同审批',
    summaryOrder: ['相对方', '合同金额'],
  },
  budget_transfer: {
    label: '预算调拨',
    summaryOrder: ['调拨金额', '调拨方向'],
  },
};

export function documentKey(
  document: Pick<GenericDocument, 'source' | 'typeId' | 'id'>,
): string {
  return [document.source.id, document.typeId, document.id]
    .map(encodeURIComponent)
    .join('/');
}

export interface DocumentPresentation {
  cardSummary: DocumentField[];
  currentLabel: string;
  estimateLabel?: string;
  displayStatus: string;
}

const statusLabels: Record<DocumentStatus, string> = {
  draft: '草稿',
  processing: '处理中',
  needs_action: '待你补充',
  completed: '已完成',
  closed: '已结束',
  unknown: '状态待核实',
};

export function presentDocument(
  document: GenericDocument,
): DocumentPresentation {
  const fields = document.summary.filter(
    (field) => field.value.trim().length > 0,
  );
  const byLabel = new Map(fields.map((field) => [field.label, field]));
  if (document.amount?.value.trim()) {
    byLabel.set(document.amount.label, {
      label: document.amount.label,
      value: document.amount.value,
    });
  }

  const order = documentTypeRegistry[document.typeId]?.summaryOrder ?? [];
  const orderedLabels = [...new Set([...order, ...byLabel.keys()])];
  const cardSummary = orderedLabels
    .map((label) => byLabel.get(label))
    .filter((field): field is DocumentField => field !== undefined)
    .slice(0, 2);

  const sourceStatus = document.sourceStatus.trim();
  const displayStatus =
    sourceStatus || document.phaseLabel || statusLabels[document.status];
  let currentLabel = document.phaseLabel || displayStatus;
  if (document.current) {
    const actors = document.current.actors.filter(
      (actor) => actor.trim().length > 0,
    );
    const actorLabel =
      actors.length > 2
        ? `${actors[0]}等 ${actors.length} 人`
        : actors.join('、');
    currentLabel = [actorLabel, document.current.label]
      .filter(Boolean)
      .join(' · ');
  } else if (document.status === 'needs_action') {
    currentLabel = '待你补充并重新提交';
  }

  // A past approval estimate must not survive a transition to payment/execution.
  const applicableEstimate =
    document.status === 'processing' &&
    document.estimate &&
    ((document.phase === 'approval' &&
      document.estimate.target === 'approval_complete') ||
      (document.phase === 'execution' &&
        document.estimate.target === 'execution_complete'));
  const estimateLabel = applicableEstimate
    ? document.estimate?.label
    : undefined;

  return { cardSummary, currentLabel, estimateLabel, displayStatus };
}
