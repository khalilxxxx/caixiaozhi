import { useRef, useState } from 'react';
import {
  WorkDocumentDetails,
  type WorkDocumentDetailsHandle,
} from '../agent-workspace/WorkDocumentDetails';
import { WideReviewPanel } from './WideReviewPanel';
import { XiaozhiReviewMark } from './XiaozhiReviewMark';
import type { ReviewSubject } from './sample-types';
import { assessRisk, type RiskPoint } from './risk-assessment';
import './review-layout.css';

export function ReviewLayoutBody({
  sample,
  note,
}: {
  sample: ReviewSubject;
  note?: string;
}) {
  const documentPane = useRef<HTMLElement>(null);
  const assistantPane = useRef<HTMLElement>(null);
  const details = useRef<WorkDocumentDetailsHandle>(null);
  const [highlighted, setHighlighted] = useState<readonly string[]>([]);
  const assessment = assessRisk(sample);

  function showTarget(element: HTMLElement) {
    const stacked =
      assistantPane.current?.parentElement &&
      getComputedStyle(assistantPane.current.parentElement).display !== 'grid';
    if (stacked) {
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    }
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function locateExpense(id: string, relatedIds?: string[]) {
    const row = details.current?.revealExpense(id);
    if (!row) return;
    documentPane.current
      ?.querySelector('[data-current-evidence]')
      ?.removeAttribute('data-current-evidence');
    setHighlighted(relatedIds?.length ? relatedIds : [id]);
    showTarget(row);
  }

  function locateSection(target: NonNullable<RiskPoint['documentTarget']>) {
    const pane = documentPane.current;
    const element =
      target === 'invoices'
        ? details.current?.revealInvoices()
        : pane?.querySelector<HTMLElement>(
            `[data-evidence-section="${target}"]`,
          );
    if (!element) return;
    pane
      ?.querySelector('[data-current-evidence]')
      ?.removeAttribute('data-current-evidence');
    setHighlighted([]);
    element.dataset.currentEvidence = 'true';
    showTarget(element);
  }

  function jumpTo(pane: HTMLElement | null) {
    pane?.focus({ preventScroll: true });
    pane?.scrollIntoView({ block: 'start' });
  }

  return (
    <>
      <nav className="rl-jumps" aria-label="本单内容">
        <button onClick={() => jumpTo(assistantPane.current)}>审批助手</button>
        <button onClick={() => jumpTo(documentPane.current)}>单据详情</button>
      </nav>
      <div className="rl-body rl-split">
        <section
          className="rl-assistant"
          ref={assistantPane}
          tabIndex={-1}
          aria-label="审批助手"
        >
          <header className="wd-head">
            <h3>
              <XiaozhiReviewMark tone={assessment.tone} />
              审批助手
            </h3>
          </header>
          <WideReviewPanel
            sample={sample}
            assessment={assessment}
            onEvidence={locateExpense}
            onDocumentEvidence={locateSection}
            selectedExpenseId={highlighted[0]}
          />
        </section>
        <section
          className="rl-doc"
          ref={documentPane}
          tabIndex={-1}
          aria-label="单据内容"
        >
          <WorkDocumentDetails
            ref={details}
            document={sample.doc}
            highlightedExpenseIds={highlighted}
          />
          {note && (
            <section className="wd-section">
              <h4>审核备注</h4>
              <p>{note}</p>
            </section>
          )}
        </section>
      </div>
    </>
  );
}
