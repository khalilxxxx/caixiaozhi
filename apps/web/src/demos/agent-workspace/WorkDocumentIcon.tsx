import type { GenericDocument } from '../document-query/document-model';
import type { WorkDocument } from './work-document-model';
import './work-document-icon.css';

const symbols = {
  travel: (
    <path
      d="m12.3 26.1 1.4-1 4.9 1.1 5.7-5.5c1.1-1 2.6-1.7 3.1-1.2.5.6-.2 2-1.1 3.2l-4.2 5.4 1.1 4.4-1.3 1.3-2.6-3.7-2.6 2-2.2-.3 1-2.1 1.3-1.2Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  expense: (
    <path d="m15.4 20.8 5 5.3 5-5.3m-9.3 5.5h8.6m-8.6 3.6h8.6m-4.3-3.7v7" />
  ),
  leave: (
    <>
      <rect x="13.6" y="20.8" width="14.2" height="12.5" rx="2.3" />
      <path d="M14 24.9h13m-10.3-6v3.3m7.8-3.3v3.3m-6.6 6.4 1.8 1.8 3.4-3.5" />
    </>
  ),
  payment: (
    <>
      <rect x="12.8" y="21.6" width="15.4" height="10.8" rx="2.1" />
      <path d="M13.3 25.1h14.5m-5.5 4.1h3.2" />
    </>
  ),
  contract: (
    <path d="M13.8 21.9h9m-9 4.1h5m-5 6.7 4.3-.7 9.4-9.5-2.7-2.7-9.4 9.5-.7 3.4Zm9.2-10.9 2.7 2.7" />
  ),
  budget: (
    <path d="M13.9 24h13.3l-3.1-3.1m3.1 3.1-3.1 3.1m2.8 3.5H13.6l3 3m-3-3 3-3" />
  ),
  general: <path d="M14.5 22h11m-11 4.6h11m-11 4.6h7" />,
};

const progressTypes: Record<string, keyof typeof symbols> = {
  travel_application: 'travel',
  expense_claim: 'expense',
  oa_leave: 'leave',
  payment_request: 'payment',
  contract_approval: 'contract',
  budget_transfer: 'budget',
};

function documentSymbol(
  doc: WorkDocument | GenericDocument,
): keyof typeof symbols {
  if ('typeId' in doc)
    return Object.hasOwn(progressTypes, doc.typeId) ? progressTypes[doc.typeId]! : 'general';
  if (doc.documentType === 'travel') return 'travel';
  if (doc.documentType === 'expense' || doc.documentType === 'personal') return 'expense';
  const label = doc.kind ?? '';
  if (/差旅申请|出差申请/.test(label)) return 'travel';
  if (label.includes('请假')) return 'leave';
  if (label.includes('付款')) return 'payment';
  if (label.includes('合同审批')) return 'contract';
  if (label.includes('预算调拨')) return 'budget';
  return doc.system === 'expense' ? 'expense' : 'general';
}

const dimensions = {
  regular: [38, 40],
  compact: [33, 35],
  small: [25, 26],
} as const;

type DocumentIconProps = (
  | { doc: WorkDocument | GenericDocument }
  | { type: keyof typeof symbols | 'personal' }
) & { size?: keyof typeof dimensions };

export function WorkDocumentIcon(props: DocumentIconProps) {
  const kind = 'doc' in props ? documentSymbol(props.doc) : props.type;
  const type = kind === 'personal' ? 'expense' : kind;
  const [width, height] = dimensions[props.size ?? 'regular'];
  return (
    <svg
      className={`wi-document-icon wi-doc-${type}`}
      viewBox="0 0 40 42"
      width={width}
      height={height}
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M8.5 8.4h16.8l7.5 7.5v18.8a3.4 3.4 0 0 1-3.4 3.4H9.7a3.4 3.4 0 0 1-3.4-3.4V11a2.6 2.6 0 0 1 2.2-2.6Z"
        fill="var(--wi-paper)"
        stroke="var(--wi-edge)"
        strokeWidth="1.3"
      />
      <path
        d="M25 8.7v5.5c0 .9.7 1.6 1.6 1.6h5.7"
        stroke="var(--wi-edge)"
        strokeWidth="1.2"
        fill="var(--wi-fold)"
      />
      <path
        d="m9.1 8.5.8-5.1 3.4 2.5c1.4-.3 3.1-.3 4.6 0l3.3-2.5.9 5.3"
        fill="#8ab4d6"
        stroke="#75a3c8"
        strokeWidth=".85"
        strokeLinejoin="round"
      />
      <rect
        x="8.6"
        y="6.7"
        width="14.1"
        height="8.7"
        rx="4.2"
        fill="#355975"
        stroke="#eaf5ff"
        strokeWidth="1.3"
      />
      <path
        d="M13 10.1v1.5m5.2-1.5v1.5"
        stroke="#a9f6ee"
        strokeWidth="1.85"
        strokeLinecap="round"
      />
      <g
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {symbols[type]}
      </g>
    </svg>
  );
}
