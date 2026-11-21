import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from '../agent-workspace/ui';
import { WorkDocumentIcon } from '../agent-workspace/WorkDocumentIcon';
import { workDocumentTitle } from '../agent-workspace/work-document-model';
import {
  WorkDocumentDetails,
  workMeasure,
} from '../agent-workspace/WorkDocumentDetails';
import { PreviewRuleDetails } from './PreviewRuleDetails';
import { BriefCard } from './BriefCard';
import { ComparisonCard } from './ComparisonCard';
import { EvidenceCard } from './EvidenceCard';
import { cases, type ApprovalCase } from './preview-data';
import { hotelComparison } from './sample-types';
import { riskScoringDescription } from './risk-assessment';
import '../agent-workspace/work-inbox.css';
import './preview.css';

const variants = [
  {
    id: 'a',
    name: '审批简报',
    note: '适合连续审单。风险等级与整单判断在前，关键事由紧随其后。',
    component: BriefCard,
  },
  {
    id: 'b',
    name: '指标看板',
    note: '适合财务复核。对照风险分与规则分布，查看禁止和警告的构成。',
    component: ComparisonCard,
  },
  {
    id: 'c',
    name: '风险核对单',
    note: '适合核对多项风险。从要点、命中原因和关联费用逐条复核。',
    component: EvidenceCard,
  },
] as const;
type Variant = (typeof variants)[number];
type Page = 'summary' | 'rules' | 'evidence';
type Preview = { variant: Variant; page: Page; expenseId?: string };
const pick = (id: string | null) => cases.find((c) => c.id === id) ?? cases[0]!;
const params = new URLSearchParams(location.search);
const initialVariant = variants.find((v) => v.id === params.get('style'));

function DesignNotes() {
  return (
    <div className="lab-notes-body">
      <section>
        <h3>整单风险的判断依据</h3>
        <p>
          三款样板都先给出整单风险分和等级，再说明整体判断，列出最多五条重点及原因，最后汇总规则执行结果。命中禁止类规则的单据优先复核。
        </p>
        <p>样板采用可解释的计分口径。{riskScoringDescription}</p>
      </section>
      <section>
        <h3>竞品依据</h3>
        <p>
          Ramp
          在单据顶部汇总关键发现，审批人可以继续查看分项检查。审批简报沿用从整单结论到具体规则的阅读顺序。{' '}
          <a
            href="https://support.ramp.com/policy-agent-full-expense-checks/"
            target="_blank"
            rel="noreferrer"
          >
            Ramp Policy Agent ↗
          </a>
        </p>
        <p>
          合思支持标出异常费用并查看风险说明。风险核对单把命中原因和费用定位放在同一条要点中。{' '}
          <a
            href="https://www.hosecloud.com/solutionsr/control.html"
            target="_blank"
            rel="noreferrer"
          >
            合思企业内控 ↗
          </a>
        </p>
        <p>
          SAP Concur Verify
          将金额一致性与重复凭证等检查逐项列示。指标看板把执行结果汇总后保留逐项规则与证据。{' '}
          <a
            href="https://help.sap.com/docs/CONCUR_EXPENSE/13094e09188143b09cef21883ba5873e/9869980e71371014b1b8a2f66f04ca50.html?locale=en-US"
            target="_blank"
            rel="noreferrer"
          >
            SAP Concur 审核检查库 ↗
          </a>
        </p>
      </section>
    </div>
  );
}

function Drawer({
  preview,
  sample,
  change,
  close,
}: {
  preview: Preview;
  sample: ApprovalCase;
  change: (value: Preview) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const lastControl = useRef<number | null>(null);
  const { page, variant } = preview;
  const Card = variant.component;
  const expenseId = preview.expenseId ?? hotelComparison(sample)?.expenseId;
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useLayoutEffect(() => {
    const body = area.current;
    if (!body) return;
    body.querySelector('[data-located]')?.removeAttribute('data-located');
    if (page === 'evidence' && expenseId) {
      const el = body.querySelector<HTMLElement>(
        `[data-expense-id="${CSS.escape(expenseId)}"]`,
      );
      if (el) {
        el.dataset.located = 'true';
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
        body.scrollTop +=
          el.getBoundingClientRect().top -
          body.getBoundingClientRect().top -
          54;
      }
    } else {
      body.scrollTop = 0;
      if (page === 'summary' && lastControl.current !== null) {
        const controls =
          body.querySelectorAll<HTMLButtonElement>('.lab-card button');
        controls[lastControl.current]?.focus({ preventScroll: true });
        lastControl.current = null;
      }
    }
  }, [page, variant, expenseId]);
  function go(next: Page, expenseId?: string) {
    const active = document.activeElement;
    if (
      page === 'summary' &&
      active instanceof HTMLButtonElement &&
      area.current
    ) {
      const controls =
        area.current.querySelectorAll<HTMLButtonElement>('.lab-card button');
      const index = [...controls].indexOf(active);
      lastControl.current = index >= 0 ? index : null;
    }
    change({ variant, page: next, expenseId });
  }
  return (
    <dialog
      ref={dialog}
      className="lab-drawer"
      aria-labelledby="lab-drawer-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (
          e.target === dialog.current &&
          e.clientX < dialog.current.getBoundingClientRect().left
        )
          close();
      }}
    >
      <div className="lab-switch">
        <span>抽屉预览</span>
        <div role="group" aria-label="切换样板">
          {variants.map((v) => (
            <button
              key={v.id}
              aria-pressed={v.id === variant.id}
              onClick={() => {
                lastControl.current = null;
                change({ variant: v, page: 'summary' });
              }}
            >
              {v.id.toUpperCase()} {v.name}
            </button>
          ))}
        </div>
      </div>
      <header className="lab-drawer-head">
        <h2 id="lab-drawer-title">{workDocumentTitle(sample.doc)}</h2>
        <button aria-label="关闭抽屉预览" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      {page === 'evidence' && (
        <div className="lab-located-head">
          <span>
            <Icon name="file" size={14} />
            已定位到费用明细
          </span>
          <button onClick={() => go('summary')}>
            返回审批助手
            <Icon name="up" size={14} />
          </button>
        </div>
      )}
      <div className="lab-drawer-body wi-dossier" ref={area}>
        {page === 'rules' ? (
          <PreviewRuleDetails sample={sample} goBack={() => go('summary')} />
        ) : (
          <>
            <div className="lab-card">
              <Card
                sample={sample}
                onRules={() => go('rules')}
                onEvidence={(id?: string) => go('evidence', id)}
              />
            </div>
            <WorkDocumentDetails document={sample.doc} />
          </>
        )}
      </div>
    </dialog>
  );
}

function ReviewLab() {
  const [sample, setSample] = useState(() => pick(params.get('case')));
  const [preview, setPreview] = useState<Preview | null>(() =>
    initialVariant ? { variant: initialVariant, page: 'summary' } : null,
  );
  const origin = useRef<HTMLElement | null>(null);
  const guide = useRef<HTMLDialogElement>(null);
  const guideButton = useRef<HTMLButtonElement>(null);
  function updateUrl(doc: ApprovalCase, v?: Variant) {
    const url = new URL(location.href);
    url.searchParams.set('case', doc.id);
    if (v) url.searchParams.set('style', v.id);
    else url.searchParams.delete('style');
    history.replaceState(null, '', url);
  }
  function enter(next: Preview) {
    if (!preview) origin.current = document.activeElement as HTMLElement;
    setPreview(next);
    updateUrl(sample, next.variant);
  }
  function close() {
    setPreview(null);
    updateUrl(sample);
    requestAnimationFrame(() => origin.current?.focus({ preventScroll: true }));
  }
  return (
    <main className="lab-page">
      <header className="lab-top">
        <div className="lab-brand">
          <img
            src="/agent-assets/caixiaozhi.png"
            alt=""
            width="32"
            height="32"
          />
          <b>财小智</b>
          <i />
          <span>设计预览</span>
        </div>
        <nav className="lab-preview-links" aria-label="工作台入口">
          <a href="/approval-assistant.html?view=headers">
            核单小智风险图标 <Icon name="layout" size={14} />
          </a>
          <a href="/agent.html#todos">
            我的工作 <Icon name="external" size={14} />
          </a>
        </nav>
      </header>
      <div className="lab-content">
        <header className="lab-heading">
          <h1>审批助手样板</h1>
        </header>
        <section className="lab-case" aria-label="对照单据">
          <WorkDocumentIcon doc={sample.doc} />
          <div className="lab-case-name">
            <h2>{workDocumentTitle(sample.doc)}</h2>
            <p>
              {sample.doc.title} · {sample.doc.department}
              <i /> {workMeasure(sample.doc)}
              <i /> {sample.doc.id}
            </p>
          </div>
          <label>
            <span>对照场景</span>
            <select
              value={sample.id}
              onChange={(e) => {
                const s = pick(e.target.value);
                setSample(s);
                updateUrl(s);
              }}
            >
              {cases.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </section>
        <div className="lab-gallery">
          {variants.map((v) => {
            const Card = v.component;
            return (
              <section
                className={`lab-variant lab-${v.id}`}
                key={v.id}
                aria-labelledby={`variant-${v.id}`}
              >
                <div className="lab-variant-head">
                  <span className="lab-letter">{v.id.toUpperCase()}</span>
                  <h2 id={`variant-${v.id}`}>{v.name}</h2>
                  <button
                    type="button"
                    onClick={() => enter({ variant: v, page: 'summary' })}
                    aria-label={`在抽屉中预览${v.name}`}
                  >
                    抽屉预览
                    <Icon name="layout" size={14} />
                  </button>
                </div>
                <div className="lab-card">
                  <Card
                    sample={sample}
                    onRules={() => enter({ variant: v, page: 'rules' })}
                    onEvidence={(id?: string) =>
                      enter({ variant: v, page: 'evidence', expenseId: id })
                    }
                  />
                </div>
                <p className="lab-fit">{v.note}</p>
              </section>
            );
          })}
        </div>
        <details className="lab-notes">
          <summary>
            <Icon name="book" size={17} />
            设计依据与竞品参考
            <Icon name="down" size={16} />
          </summary>
          <DesignNotes />
        </details>
      </div>
      <button
        className="lab-help"
        ref={guideButton}
        onClick={() => guide.current?.showModal()}
      >
        <Icon name="help" size={15} />
        使用指引
      </button>
      <dialog
        className="lab-guide"
        ref={guide}
        aria-label="使用指引"
        onClose={() => guideButton.current?.focus()}
      >
        <header>
          <h2>使用指引</h2>
          <button
            aria-label="关闭使用指引"
            onClick={() => guide.current?.close()}
          >
            <Icon name="close" />
          </button>
        </header>
        <p>
          切换对照场景，三款卡片会同步使用同一张单据。打开「抽屉预览」可以核对重点风险、定位关联费用，或展开规则查看原因和证据。
        </p>
        <p>
          住宿、餐费、差旅和请假样例采用本地审查快照。多项风险场景采用合成单据执行确定性检查。风险分按样板口径换算，业务审批状态见单据详情。
        </p>
      </dialog>
      {preview && (
        <Drawer
          preview={preview}
          sample={sample}
          change={enter}
          close={close}
        />
      )}
    </main>
  );
}
const root = createRoot(document.getElementById('root')!);
if (params.get('view') === 'headers') {
  document.title = '核单小智风险图标 · 财小智';
  void import('./HeaderComparison').then(({ HeaderComparison }) => root.render(<HeaderComparison />));
} else {
  root.render(<ReviewLab />);
}
