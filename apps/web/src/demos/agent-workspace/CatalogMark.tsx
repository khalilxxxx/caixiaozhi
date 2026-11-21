import './catalog-mark.css';

const illustrations = {
  app: {
    reconcile: 'compare',
    convert: 'convert',
    report: 'report',
    'expense-summary': 'calculator',
  },
  team: {
    'finance-review-team': 'review',
    'finance-analysis-team': 'analysis',
  },
  skill: {
    'monthly-analysis': 'analysis',
    'invoice-check': 'review',
    'travel-guide': 'book',
    'english-report': 'report',
    'close-checklist': 'compare',
    'contract-audit': 'review',
  },
  connector: {
    'business-documents': 'report',
    'task-materials': 'compare',
    'policy-library': 'book',
    'expense-records': 'calculator',
    'expense-csv': 'convert',
    'public-financials': 'analysis',
  },
};

type MarkKind = keyof typeof illustrations;
const fallback: Record<MarkKind, string> = {
  app: 'app',
  team: 'review',
  skill: 'book',
  connector: 'connector',
};

export function CatalogMark({ kind, id }: { kind: MarkKind; id: string }) {
  const assets: Readonly<Record<string, string>> = illustrations[kind];
  const image = Object.hasOwn(assets, id) ? assets[id] : fallback[kind];
  return (
    <span className="catalog-mark" aria-hidden="true">
      <img
        src={`/agent-assets/catalog/${image}.webp`}
        alt=""
        width="52"
        height="52"
      />
    </span>
  );
}
