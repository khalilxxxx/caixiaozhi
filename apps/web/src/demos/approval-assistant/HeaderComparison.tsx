import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { WorkDocumentIcon } from '../agent-workspace/WorkDocumentIcon';
import { workDocumentTitle } from '../agent-workspace/work-document-model';
import { Icon } from '../agent-workspace/ui';
import { cases, type ApprovalCase } from './preview-data';
import { ReviewLayoutBody } from './ReviewLayoutBody';
import { XiaozhiReviewMark } from './XiaozhiReviewMark';
import { assessRisk } from './risk-assessment';
import './header-comparison.css';

const samples = cases.map((sample) => ({
  ...sample,
  assessment: assessRisk(sample),
}));
const riskExamples = (['high', 'medium', 'low'] as const).flatMap((tone) => {
  const example = samples.find((sample) => sample.assessment.tone === tone);
  return example ? [example] : [];
});

function DocumentPreview({
  sample,
  expanded,
  onExpand,
}: {
  sample: ApprovalCase;
  expanded: boolean;
  onExpand: (value: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (expanded && element) {
      element.showModal();
      return () => element.close();
    }
    if (restoreFocus.current) {
      expandButton.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [expanded]);

  const content = (
    <>
      <header className="hc-document-heading">
        <WorkDocumentIcon doc={sample.doc} />
        <div>
          <h2 id={titleId}>{workDocumentTitle(sample.doc)}</h2>
          <span>{sample.doc.id}</span>
        </div>
        {expanded ? (
          <button
            type="button"
            aria-label="关闭抽屉预览"
            onClick={() => onExpand(false)}
          >
            <Icon name="close" size={18} />
          </button>
        ) : (
          <button
            ref={expandButton}
            type="button"
            onClick={() => {
              restoreFocus.current = true;
              onExpand(true);
            }}
          >
            <Icon name="layout" size={15} />
            <span>抽屉预览</span>
          </button>
        )}
      </header>
      <div className="wi-dossier" data-review-layout="split">
        <ReviewLayoutBody sample={sample} />
      </div>
    </>
  );

  return expanded ? (
    <dialog
      ref={dialog}
      className="hc-surface hc-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onExpand(false);
      }}
      onClick={(event) => {
        if (
          event.target === dialog.current &&
          event.clientX < dialog.current.getBoundingClientRect().left
        )
          onExpand(false);
      }}
    >
      {content}
    </dialog>
  ) : (
    <section className="hc-surface hc-stage" aria-labelledby={titleId}>
      {content}
    </section>
  );
}

export function HeaderComparison() {
  const params = new URLSearchParams(location.search);
  const [sample, setSample] = useState(
    () => samples.find((item) => item.id === params.get('case')) ?? samples[0]!,
  );
  const [expanded, setExpanded] = useState(
    () =>
      params.get('preview') === 'drawer' ||
      ['signature', 'gauge', 'briefing'].includes(params.get('variant') ?? ''),
  );
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('case', sample.id);
    url.searchParams.delete('mark');
    url.searchParams.delete('variant');
    if (expanded) url.searchParams.set('preview', 'drawer');
    else url.searchParams.delete('preview');
    history.replaceState(history.state, '', url);
  }, [sample.id, expanded]);
  return (
    <main className="hc-page">
      <header className="hc-masthead">
        <div className="hc-brand">
          <img src="/agent-assets/caixiaozhi-wordmark.svg" alt="财小智" />
          <span>设计预览</span>
        </div>
        <a href="/agent.html#todos">
          我的工作 <Icon name="external" size={14} />
        </a>
      </header>
      <div className="hc-content">
        <header className="hc-toolbar">
          <h1>核单小智风险图标</h1>
          <label>
            对照单据
            <select
              value={sample.id}
              onChange={(event) => {
                const next = samples.find(
                  (item) => item.id === event.target.value,
                );
                if (next) {
                  setSample(next);
                }
              }}
            >
              {samples.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </header>
        <div className="hc-workbench">
          <div className="hc-switches" role="group" aria-label="按风险等级预览">
            {riskExamples.map((example) => (
              <button
                type="button"
                key={example.id}
                className="hc-choice"
                aria-pressed={
                  sample.assessment.tone === example.assessment.tone
                }
                onClick={() => setSample(example)}
              >
                <XiaozhiReviewMark tone={example.assessment.tone} />
                <span>{example.assessment.level}</span>
              </button>
            ))}
          </div>
          <DocumentPreview
            key={sample.id}
            sample={sample}
            expanded={expanded}
            onExpand={setExpanded}
          />
        </div>
      </div>
    </main>
  );
}
