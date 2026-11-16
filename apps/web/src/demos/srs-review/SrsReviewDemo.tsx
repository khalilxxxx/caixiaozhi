import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RulesApp } from './RulesApp.js';
import { Button, Drawer, Icon } from './ui.js';
import {
  evaluate,
  initialDocs,
  initialDraft,
  initialRules,
  money,
  rulesSignature,
  statusNames,
  summary,
  systemNames,
  type BusinessDoc,
  type Review,
  type Rule,
} from './model.js';

type Conversation = 'daily' | 'submit' | 'rules' | 'new';
type Sheet =
  | { type: 'batch' }
  | { type: 'document'; id: string; fromBatch?: boolean }
  | { type: 'draft' }
  | { type: 'schedule' }
  | null;
type Reply = {
  id: number;
  prompt: string;
  text: string;
  card: 'batch' | 'doc' | 'oa' | 'rules' | 'draft' | 'newrule' | null;
};
interface Stored {
  rules: Rule[];
  reviewedRules: Rule[];
  draft: BusinessDoc;
  notes: Record<string, string>;
  schedule: { enabled: boolean; time: string };
  reviewedAt: string;
  submittedCheck?: { version: number; rules: Rule[] };
}
const storageKey = 'caixiaozhi.srs.local.v3';
function initial(): Stored {
  return {
    rules: structuredClone(initialRules),
    reviewedRules: structuredClone(initialRules),
    draft: structuredClone(initialDraft),
    notes: {},
    schedule: { enabled: true, time: '08:30' },
    reviewedAt: '11月16日 08:30',
  };
}
function read(): Stored {
  try {
    const data = JSON.parse(
      localStorage.getItem(storageKey) || 'null',
    ) as Stored | null;
    if (
      data &&
      Array.isArray(data.rules) &&
      Array.isArray(data.reviewedRules) &&
      data.rules.every((r) => r.id && Number.isFinite(r.version)) &&
      data.draft?.id === initialDraft.id &&
      data.notes &&
      data.schedule &&
      /^\d{2}:\d{2}$/.test(data.schedule.time)
    )
      return data;
  } catch {
    /* Unavailable or outdated local storage falls back to the demo fixtures. */
  }
  return initial();
}
function Badge({
  status,
  label,
}: {
  status: Review['status'] | 'neutral';
  label?: string;
}) {
  return (
    <span className={`srs-badge ${status}`}>
      <i />
      {label || (status === 'neutral' ? '' : statusNames[status])}
    </span>
  );
}
function DocCard({
  doc,
  rules,
  onClick,
}: {
  doc: BusinessDoc;
  rules: Rule[];
  onClick: () => void;
}) {
  return (
    <button type="button" className="srs-object-card" onClick={onClick}>
      <span className={`srs-object-icon ${doc.system}`}>
        <Icon name={doc.system === 'oa' ? 'calendar' : 'file'} size={22} />
      </span>
      <span className="srs-card-copy">
        <span className="srs-card-title">{doc.title}</span>
        <span className="srs-card-meta">
          {systemNames[doc.system]}
          <b>·</b>
          {doc.person}
          <b>·</b>
          {doc.amount === undefined ? `${doc.days}天` : money(doc.amount)}
        </span>
      </span>
      <Badge status={evaluate(doc, rules).status} />
      <Icon name="chevron" size={16} />
    </button>
  );
}
export function SrsReviewDemo() {
  const [data, setData] = useState(read);
  const [page, setPage] = useState<'assistant' | 'rules'>('assistant');
  const [conversation, setConversation] = useState<Conversation>('daily');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [focusRuleId, setFocusRuleId] = useState<string>();
  const [createRule, setCreateRule] = useState(false);
  const [input, setInput] = useState('');
  const [replies, setReplies] = useState<Reply[]>([]);
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState<'all' | Review['status']>('all');
  const [detailTab, setDetailTab] = useState<'review' | 'fields'>('review');
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftCheck, setDraftCheck] = useState<{
    version: number;
    rules: Rule[];
  } | null>(data.submittedCheck || null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftInputError, setDraftInputError] = useState('');
  const [hotelText, setHotelText] = useState(String(data.draft.hotelNight));
  const [scheduleDraft, setScheduleDraft] = useState(data.schedule);
  const bottom = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const notify = (text: string) => setToast(text);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch {
      setToast('当前浏览器无法保存设置，刷新后将恢复演示数据。');
    }
  }, [data]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3600);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(
    () => () => {
      sequence.current++;
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  useEffect(() => {
    if (replies.length) bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [replies.length]);
  const counts = summary(initialDocs, data.reviewedRules);
  const stale =
    rulesSignature(data.rules, 'review') !==
    rulesSignature(data.reviewedRules, 'review');
  const reviewedDraft = draftCheck
    ? evaluate(data.draft, draftCheck.rules, 'submit')
    : null;
  const draftStale =
    data.draft.stage === '草稿' &&
    (!draftCheck ||
      draftCheck.version !== data.draft.version ||
      rulesSignature(draftCheck.rules, 'submit', 'expense') !==
        rulesSignature(data.rules, 'submit', 'expense'));
  const canSubmit =
    !!reviewedDraft &&
    !draftStale &&
    !draftBusy &&
    !reviewedDraft.findings.some(
      (f) => f.state === 'unknown' || f.rule.effect === 'block',
    ) &&
    data.draft.stage === '草稿';
  const currentDoc =
    sheet?.type === 'document'
      ? initialDocs.find((d) => d.id === sheet.id)
      : null;
  const currentReview = currentDoc
    ? evaluate(currentDoc, data.reviewedRules)
    : null;
  const docStale =
    currentDoc &&
    rulesSignature(data.rules, 'review', currentDoc.system) !==
      rulesSignature(data.reviewedRules, 'review', currentDoc.system);
  function navigateConversation(next: Conversation) {
    setPage('assistant');
    setConversation(next);
    setReplies([]);
    setSheet(null);
  }
  function openDoc(id: string, fromBatch = false) {
    setSheet({ type: 'document', id, fromBatch });
    setDetailTab('review');
    setEditingNote(false);
    setNote(data.notes[id] || '');
  }
  function openRules(id?: string, create = false) {
    setSheet(null);
    setPage('rules');
    setFocusRuleId(id);
    setCreateRule(create);
  }
  function recheck() {
    if (busy) return;
    setBusy(true);
    const at = sequence.current;
    const rules = structuredClone(data.rules);
    timers.current.push(
      setTimeout(() => {
        if (at !== sequence.current) return;
        setData((prev) => ({
          ...prev,
          reviewedRules: rules,
          reviewedAt: new Date().toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'Asia/Shanghai',
          }),
        }));
        setBusy(false);
        notify('预审已更新，1张单据的发票查验结果仍待核实。');
      }, 650),
    );
  }
  function checkDraft() {
    if (draftBusy || data.draft.stage !== '草稿') return;
    setDraftBusy(true);
    const at = sequence.current,
      version = data.draft.version,
      rules = structuredClone(data.rules);
    timers.current.push(
      setTimeout(() => {
        if (at !== sequence.current) return;
        setDraftCheck({ version, rules });
        setDraftBusy(false);
      }, 650),
    );
  }
  function submitPrompt(event?: FormEvent, value = input) {
    event?.preventDefault();
    const prompt = value.trim();
    if (!prompt) return;
    let card: Reply['card'] = null,
      text = '';
    if (/新增|新建|增加.*规则/.test(prompt)) {
      text = '可以在规则中心新建，确认适用范围和条件后启用。';
      card = 'newrule';
    } else if (/OA|请假|年休假/i.test(prompt)) {
      text = '找到2张OA待审单据，以下是年休假申请。';
      card = 'oa';
    } else if (/住宿|林晓|超标/.test(prompt)) {
      text = '这张单据的住宿费用超出标准¥360.00。';
      card = 'doc';
    } else if (/提交|提单|我的报销/.test(prompt)) {
      text = '报销草稿已准备好，提交前需要完成规则检查。';
      card = 'draft';
    } else if (/规则/.test(prompt)) {
      text = '通用规则默认执行。你的个人规则在规则中心单独管理。';
      card = 'rules';
    } else if (/待审|预审|待办|审查/.test(prompt)) {
      text = `已整理${initialDocs.length}张待审单据，${counts.attention}张需关注，${counts.unknown}张待核实。`;
      card = 'batch';
    } else
      text =
        '当前本地演示支持查看待审汇总、住宿超标单据、OA申请、报销草稿和规则中心。';
    setReplies((prev) => [...prev, { id: Date.now(), prompt, text, card }]);
    setInput('');
  }
  function batchCard() {
    return (
      <button
        className="srs-batch-card"
        type="button"
        onClick={() => {
          setFilter('all');
          setSheet({ type: 'batch' });
        }}
      >
        <span className="srs-batch-top">
          <span className="srs-object-icon">
            <Icon name="shield" size={22} />
          </span>
          <span className="srs-card-copy">
            <span className="srs-card-title">
              待办预审<span className="srs-count">{initialDocs.length}张</span>
            </span>
            <span className="srs-card-meta">费用报销 6 · OA办公 2</span>
          </span>
          <Icon name="chevron" size={16} />
        </span>
        <span className="srs-batch-bottom">
          <span>
            <i className="attention-dot" />
            需关注 <strong>{counts.attention}</strong>
          </span>
          <span>
            <i className="unknown-dot" />
            待核实 <strong>{counts.unknown}</strong>
          </span>
          <span>
            未发现异常 <strong>{counts.clear}</strong>
          </span>
          {stale && <em>结果待更新</em>}
        </span>
      </button>
    );
  }
  function ruleCard(create = false) {
    return (
      <button
        className="srs-object-card"
        type="button"
        onClick={() => openRules(undefined, create)}
      >
        <span className="srs-object-icon">
          <Icon name={create ? 'plus' : 'shield'} size={22} />
        </span>
        <span className="srs-card-copy">
          <span className="srs-card-title">
            {create ? '新增规则' : '我的规则中心'}
          </span>
          <span className="srs-card-meta">
            {create
              ? '费用报销、OA办公'
              : `通用规则 ${data.rules.filter((r) => r.origin === 'builtin').length}项 · 个人规则 ${data.rules.filter((r) => r.origin === 'personal' && r.enabled).length}项已启用`}
          </span>
        </span>
        <span className="srs-card-link">打开</span>
        <Icon name="chevron" size={16} />
      </button>
    );
  }
  function draftCard() {
    return (
      <button
        type="button"
        className="srs-object-card"
        onClick={() => setSheet({ type: 'draft' })}
      >
        <span className="srs-object-icon">
          <Icon name="file" size={22} />
        </span>
        <span className="srs-card-copy">
          <span className="srs-card-title">{data.draft.title}</span>
          <span className="srs-card-meta">
            费用报销<b>·</b>我的报销<b>·</b>
            {money(data.draft.amount || 0)}
          </span>
        </span>
        <Badge
          status={data.draft.stage === '审批中' ? 'clear' : 'neutral'}
          label={data.draft.stage === '审批中' ? '已提交' : '草稿'}
        />
        <Icon name="chevron" size={16} />
      </button>
    );
  }
  function renderReplyCard(card: Reply['card']) {
    return card === 'batch' ? (
      batchCard()
    ) : card === 'doc' ? (
      <DocCard
        doc={initialDocs[0]!}
        rules={data.reviewedRules}
        onClick={() => openDoc(initialDocs[0]!.id)}
      />
    ) : card === 'oa' ? (
      <DocCard
        doc={initialDocs[6]!}
        rules={data.reviewedRules}
        onClick={() => openDoc(initialDocs[6]!.id)}
      />
    ) : card === 'rules' || card === 'newrule' ? (
      ruleCard(card === 'newrule')
    ) : card === 'draft' ? (
      draftCard()
    ) : null;
  }
  const findings = (review: Review, doc: BusinessDoc) => (
    <>
      {review.findings.map((f) => (
        <section className="srs-finding" key={f.rule.id}>
          <div className="srs-finding-title">
            <span
              className={`srs-finding-mark ${f.state === 'unknown' ? 'unknown' : ''}`}
            >
              <Icon
                name={f.state === 'unknown' ? 'clock' : 'alert'}
                size={16}
              />
            </span>
            <h3>{f.rule.name}</h3>
            <span className="srs-muted small">
              {f.rule.origin === 'personal'
                ? '个人提醒'
                : f.state === 'unknown'
                  ? '待核实'
                  : '通用规则'}
            </span>
          </div>
          <p>{f.detail}</p>
          <dl className="srs-comparison">
            <div>
              <dt>单据实际</dt>
              <dd>{f.actual}</dd>
            </div>
            <div>
              <dt>{f.rule.origin === 'personal' ? '提醒条件' : '规则要求'}</dt>
              <dd>{f.expected}</dd>
            </div>
          </dl>
          <details className="srs-source">
            <summary>
              规则依据{' '}
              <span>
                {f.rule.id} · v{f.rule.version}
              </span>
            </summary>
            <p>{f.rule.description}</p>
            <Button
              className="subtle text"
              onClick={() => openRules(f.rule.id)}
            >
              在规则中心查看
              <Icon name="out" size={14} />
            </Button>
          </details>
        </section>
      ))}
      {!review.findings.length && (
        <div className="srs-clear-state">
          <Icon name="check" size={20} />
          <div>
            <strong>适用规则检查完成，未发现异常</strong>
            <p>
              {doc.stage === '草稿'
                ? '可以继续提交单据。'
                : '规则预审结果供审批时参考。'}
            </p>
          </div>
        </div>
      )}
      <details className="srs-passed">
        <summary>
          已通过 {review.passed.length} 项检查
          <Icon name="chevron" size={14} />
        </summary>
        {review.passed.map((r) => (
          <div key={r.id}>
            <Icon name="check" size={14} />
            <span>{r.name}</span>
            <small>v{r.version}</small>
          </div>
        ))}
      </details>
    </>
  );
  return (
    <div className="srs-app">
      <aside className="srs-sidebar">
        <a
          href="#"
          className="srs-brand"
          onClick={(e) => {
            e.preventDefault();
            navigateConversation('daily');
          }}
        >
          <span className="srs-brandmark">
            <Icon name="spark" size={24} />
          </span>
          <strong>财小智</strong>
        </a>
        <Button
          className="srs-new-chat"
          onClick={() => navigateConversation('new')}
        >
          <Icon name="plus" />
          新对话
        </Button>
        <nav className="srs-main-nav" aria-label="主导航">
          <button
            className={page === 'assistant' ? 'active' : ''}
            onClick={() => setPage('assistant')}
          >
            <Icon name="chat" />
            对话
          </button>
          <button
            className={page === 'rules' ? 'active' : ''}
            onClick={() => openRules()}
          >
            <Icon name="shield" />
            规则平台
          </button>
        </nav>
        <div className="srs-history">
          <p>最近对话</p>
          {(
            [
              ['daily', '今日待办预审'],
              ['submit', '上海差旅报销'],
              ['rules', '我的规则设置'],
            ] as [Conversation, string][]
          ).map(([key, title]) => (
            <button
              key={key}
              onClick={() => navigateConversation(key)}
              className={
                page === 'assistant' && conversation === key ? 'selected' : ''
              }
            >
              {title}
            </button>
          ))}
        </div>
        <div className="srs-sidebar-bottom">
          <button
            className="srs-schedule-link"
            onClick={() => {
              setScheduleDraft(data.schedule);
              setSheet({ type: 'schedule' });
            }}
          >
            <Icon name="clock" size={16} />
            <span>
              定时预审{' '}
              <small>
                {data.schedule.enabled
                  ? `每天 ${data.schedule.time}`
                  : '已停用'}
              </small>
            </span>
            <Icon name="settings" size={14} />
          </button>
          <div className="srs-profile">
            <span>懿</span>
            <div>
              <strong>王懿</strong>
              <small>财务部</small>
            </div>
            <span className="srs-demo-badge">本地演示</span>
          </div>
        </div>
      </aside>
      <main className="srs-main">
        {page === 'assistant' ? (
          <>
            <header className="srs-topbar">
              <div>
                <span>对话</span>
                <Icon name="chevron" size={13} />
                <strong>
                  {conversation === 'daily'
                    ? '今日待办预审'
                    : conversation === 'submit'
                      ? '上海差旅报销'
                      : conversation === 'new'
                        ? '新对话'
                        : '我的规则设置'}
                </strong>
              </div>
              <span className="srs-top-status">SRS 规则审查</span>
            </header>
            <div className="srs-conversation-scroll">
              <div className="srs-conversation">
                <div className="srs-day-label">11月16日</div>
                {conversation === 'new' && !replies.length && (
                  <div className="srs-new-empty">
                    <span className="srs-brandmark">
                      <Icon name="spark" size={24} />
                    </span>
                    <h2>有什么可以帮你？</h2>
                    <p>查待办、检查报销，或管理你的规则。</p>
                  </div>
                )}
                {conversation !== 'new' && (
                  <>
                    <div className="srs-user-message">
                      {conversation === 'daily'
                        ? '帮我看看今天的待审单据'
                        : conversation === 'submit'
                          ? '准备提交上海客户拜访的报销单'
                          : '查看我的规则设置'}
                    </div>
                    <div className="srs-assistant-message">
                      <div className="srs-message-avatar">
                        <Icon name="spark" size={18} />
                      </div>
                      <div className="srs-message-content">
                        <span className="srs-message-author">财小智</span>
                        {conversation === 'daily' ? (
                          <>
                            <p>
                              已完成 {initialDocs.length} 张单据预审，
                              <strong>{counts.attention}张需关注</strong>，
                              {counts.unknown}张待核实。
                            </p>
                            {batchCard()}
                            <span className="srs-message-time">
                              {data.reviewedAt} ·{' '}
                              {stale
                                ? '规则已更新，结果待重新审查'
                                : '按当前待办生成'}
                            </span>
                          </>
                        ) : conversation === 'submit' ? (
                          <>
                            <p>
                              报销草稿已准备好。提交前，我会先检查适用规则。
                            </p>
                            {draftCard()}
                          </>
                        ) : (
                          <>
                            <p>
                              通用规则默认执行；个人规则仅用于你的提单或审单。
                            </p>
                            {ruleCard()}
                          </>
                        )}
                      </div>
                    </div>
                  </>
                )}
                {conversation === 'daily' && (
                  <>
                    <div className="srs-user-message">
                      先看一下住宿超标的那张
                    </div>
                    <div className="srs-assistant-message">
                      <div className="srs-message-avatar">
                        <Icon name="spark" size={18} />
                      </div>
                      <div className="srs-message-content">
                        <span className="srs-message-author">财小智</span>
                        <p>
                          林晓的住宿费用超出标准 <strong>¥360.00</strong>。
                        </p>
                        <DocCard
                          doc={initialDocs[0]!}
                          rules={data.reviewedRules}
                          onClick={() => openDoc(initialDocs[0]!.id)}
                        />
                      </div>
                    </div>
                  </>
                )}
                {replies.map((reply) => (
                  <div key={reply.id}>
                    <div className="srs-user-message">{reply.prompt}</div>
                    <div className="srs-assistant-message">
                      <div className="srs-message-avatar">
                        <Icon name="spark" size={18} />
                      </div>
                      <div className="srs-message-content">
                        <span className="srs-message-author">财小智</span>
                        <p>{reply.text}</p>
                        {renderReplyCard(reply.card)}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottom} />
              </div>
            </div>
            <div className="srs-composer-area">
              <div className="srs-prompt-chips">
                <button
                  onClick={() => submitPrompt(undefined, '查看OA待审单据')}
                >
                  查看OA待审
                </button>
                <button
                  onClick={() => {
                    navigateConversation('submit');
                  }}
                >
                  提交报销
                </button>
                <button onClick={() => openRules(undefined, true)}>
                  新增规则
                </button>
              </div>
              <form className="srs-composer" onSubmit={submitPrompt}>
                <label className="srs-sr-only" htmlFor="srs-input">
                  发送给财小智
                </label>
                <input
                  id="srs-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="询问待审单据，或描述你想设置的规则…"
                  autoComplete="off"
                />
                <button
                  aria-label="发送消息"
                  type="submit"
                  disabled={!input.trim()}
                >
                  <Icon name="send" size={19} />
                </button>
              </form>
              <p className="srs-composer-footnote">
                本地演示数据 · 审查结果供审批参考
              </p>
            </div>
          </>
        ) : (
          <RulesApp
            rules={data.rules}
            onChange={(rules) => setData((prev) => ({ ...prev, rules }))}
            onToast={notify}
            focusRuleId={focusRuleId}
            onFocusConsumed={() => setFocusRuleId(undefined)}
            createOnOpen={createRule}
            onCreateConsumed={() => setCreateRule(false)}
          />
        )}
      </main>
      {sheet?.type === 'batch' && (
        <Drawer
          title="待办预审"
          eyebrow={`${data.reviewedAt} · 共${initialDocs.length}张`}
          onClose={() => setSheet(null)}
          footer={
            <>
              <span className="srs-footer-note">
                {stale ? '规则已更新，请重新审查' : '范围：我的财务待办'}
              </span>
              <Button onClick={recheck} disabled={busy} className="primary">
                <Icon name="refresh" size={15} />
                {busy ? '正在审查…' : '重新审查'}
              </Button>
            </>
          }
        >
          <div
            className="srs-filter-tabs"
            role="group"
            aria-label="按预审结果筛选"
          >
            {(['all', 'attention', 'unknown', 'clear'] as const).map((key) => (
              <button
                key={key}
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >
                {key === 'all' ? '全部' : statusNames[key]}
                <span>{key === 'all' ? initialDocs.length : counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="srs-doc-list">
            {initialDocs
              .filter(
                (doc) =>
                  filter === 'all' ||
                  evaluate(doc, data.reviewedRules).status === filter,
              )
              .map((doc) => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  rules={data.reviewedRules}
                  onClick={() => openDoc(doc.id, true)}
                />
              ))}
          </div>
          {initialDocs.every(
            (doc) =>
              filter !== 'all' &&
              evaluate(doc, data.reviewedRules).status !== filter,
          ) && <p className="srs-empty">暂无此类单据</p>}
        </Drawer>
      )}
      {currentDoc && currentReview && sheet?.type === 'document' && (
        <Drawer
          title={currentDoc.title}
          eyebrow={systemNames[currentDoc.system] + ' / ' + currentDoc.id}
          onClose={() => setSheet(null)}
          footer={
            <>
              <Button
                className="subtle"
                onClick={() => setEditingNote(!editingNote)}
              >
                <Icon name="edit" size={15} />
                审核备注
              </Button>
              <span className="srs-spacer" />
              <Button onClick={recheck} disabled={busy}>
                {busy ? '正在审查…' : '重新审查'}
              </Button>
              <Button
                className="primary"
                onClick={() =>
                  setDetailTab(detailTab === 'fields' ? 'review' : 'fields')
                }
              >
                {detailTab === 'fields' ? '查看审查结果' : '查看单据'}
              </Button>
            </>
          }
        >
          {sheet.fromBatch && (
            <Button
              className="subtle text srs-back-link"
              onClick={() => setSheet({ type: 'batch' })}
            >
              <Icon name="back" size={14} />
              返回预审列表
            </Button>
          )}
          <div className="srs-doc-overview">
            <div>
              <span>
                {currentDoc.person} · {currentDoc.department}
              </span>
              <strong>
                {currentDoc.amount === undefined
                  ? `${currentDoc.days}天`
                  : money(currentDoc.amount)}
              </strong>
            </div>
            <Badge status="neutral" label={currentDoc.stage} />
          </div>
          <div className="srs-detail-tabs">
            <button
              className={detailTab === 'review' ? 'active' : ''}
              onClick={() => setDetailTab('review')}
            >
              审查结果
            </button>
            <button
              className={detailTab === 'fields' ? 'active' : ''}
              onClick={() => setDetailTab('fields')}
            >
              单据信息
            </button>
          </div>
          {docStale && (
            <div className="srs-inline-notice">
              规则已更新，以下为上次审查结果。
              <button onClick={recheck} disabled={busy}>
                重新审查
              </button>
            </div>
          )}
          {detailTab === 'review' ? (
            <>
              <div className="srs-result-line">
                <Badge status={currentReview.status} />
                <span>已执行 {currentReview.applicable.length} 项规则</span>
              </div>
              {findings(currentReview, currentDoc)}
            </>
          ) : (
            <dl className="srs-field-list">
              {Object.entries({
                单据编号: currentDoc.id,
                所属系统: systemNames[currentDoc.system],
                单据类型: currentDoc.kind,
                申请人: `${currentDoc.person} / ${currentDoc.department}`,
                业务日期: currentDoc.period,
                ...(currentDoc.amount !== undefined
                  ? { 申请金额: money(currentDoc.amount) }
                  : { 申请时长: `${currentDoc.days}天` }),
                ...(currentDoc.hotelNight !== undefined
                  ? {
                      住宿费用: `${money(currentDoc.hotelNight)} × ${currentDoc.nights}间夜`,
                    }
                  : {}),
                业务状态: currentDoc.stage,
                附件: '已上传证明材料',
              }).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {editingNote ? (
            <form
              className="srs-note-form"
              onSubmit={(e) => {
                e.preventDefault();
                setData((prev) => ({
                  ...prev,
                  notes: { ...prev.notes, [currentDoc.id]: note.trim() },
                }));
                setEditingNote(false);
                notify('审核备注已保存');
              }}
            >
              <label htmlFor="srs-note">审核备注</label>
              <textarea
                id="srs-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder="填写核实情况或处理说明"
              />
              <div>
                <Button
                  onClick={() => {
                    setEditingNote(false);
                    setNote(data.notes[currentDoc.id] || '');
                  }}
                >
                  取消
                </Button>
                <Button type="submit" className="primary">
                  保存备注
                </Button>
              </div>
            </form>
          ) : (
            data.notes[currentDoc.id] && (
              <div className="srs-saved-note">
                <strong>审核备注</strong>
                <p>{data.notes[currentDoc.id]}</p>
                <small>王懿 · 仅保存在当前单据</small>
              </div>
            )
          )}
        </Drawer>
      )}
      {sheet?.type === 'draft' && (
        <Drawer
          title="上海客户拜访差旅报销"
          eyebrow="我的报销 / BX-DRAFT-001"
          onClose={() => setSheet(null)}
          footer={
            <>
              <span className="srs-footer-note">
                {data.draft.stage === '审批中'
                  ? '单据已进入审批流程（演示）'
                  : '提交前执行通用规则及个人提单规则'}
              </span>
              {data.draft.stage === '草稿' && (
                <>
                  <Button
                    onClick={checkDraft}
                    disabled={draftBusy || !!draftInputError}
                  >
                    {draftBusy
                      ? '正在检查…'
                      : draftCheck
                        ? '重新检查'
                        : '检查单据'}
                  </Button>
                  <Button
                    className="primary"
                    disabled={!canSubmit || !!draftInputError}
                    onClick={() => {
                      if (!canSubmit || !draftCheck) return;
                      setData((prev) => ({
                        ...prev,
                        draft: { ...prev.draft, stage: '审批中' },
                        submittedCheck: structuredClone(draftCheck),
                      }));
                      notify('报销单已提交（本地演示）');
                    }}
                  >
                    提交
                  </Button>
                </>
              )}
            </>
          }
        >
          <div className="srs-doc-overview">
            <div>
              <span>王懿 · 财务部</span>
              <strong>{money(data.draft.amount || 0)}</strong>
            </div>
            <Badge
              status={data.draft.stage === '审批中' ? 'clear' : 'neutral'}
              label={data.draft.stage === '审批中' ? '已提交' : '草稿'}
            />
          </div>
          <h3 className="srs-section-title">费用明细</h3>
          <div className="srs-expense-row">
            <span>
              住宿费<small>上海 · 2间夜</small>
            </span>
            <label>
              <span className="srs-muted">¥</span>
              <input
                aria-label="每间夜住宿金额"
                inputMode="decimal"
                value={hotelText}
                aria-invalid={!!draftInputError}
                disabled={data.draft.stage !== '草稿'}
                onChange={(e) => {
                  const raw = e.target.value;
                  setHotelText(raw);
                  const value = Number(raw);
                  if (
                    !/^\d+(?:\.\d{0,2})?$/.test(raw) ||
                    !Number.isFinite(value) ||
                    value <= 0 ||
                    value > 100000
                  ) {
                    setDraftInputError(
                      '请输入大于0、不超过100000且最多两位小数的金额',
                    );
                    return;
                  }
                  setDraftInputError('');
                  setData((prev) => ({
                    ...prev,
                    draft: {
                      ...prev.draft,
                      hotelNight: value,
                      amount: Math.round((value * 2 + 1700) * 100) / 100,
                      version: prev.draft.version + 1,
                    },
                  }));
                }}
              />
              <span className="srs-muted">/ 间夜</span>
            </label>
          </div>
          {draftInputError && (
            <p role="alert" className="srs-error">
              {draftInputError}
            </p>
          )}
          <div className="srs-expense-row">
            <span>交通费</span>
            <strong>¥1,420.00</strong>
          </div>
          <div className="srs-expense-row">
            <span>餐饮费</span>
            <strong>¥280.00</strong>
          </div>
          <h3 className="srs-section-title">
            {data.draft.stage === '审批中' ? '提交时检查记录' : '提交检查'}
          </h3>
          {data.draft.stage === '审批中' && !draftCheck ? (
            <div className="srs-clear-state">
              <Icon name="check" />
              <div>
                <strong>单据已提交</strong>
                <p>当前演示数据没有保留历史检查明细。</p>
              </div>
            </div>
          ) : draftBusy ? (
            <div className="srs-inline-notice" role="status">
              正在检查适用规则…
            </div>
          ) : !draftCheck ? (
            <div className="srs-neutral-state">
              <Icon name="shield" />
              <p>提交前需完成规则检查</p>
              <Button
                onClick={checkDraft}
                disabled={!!draftInputError}
                className="primary"
              >
                检查单据
              </Button>
            </div>
          ) : draftStale ? (
            <div className="srs-inline-notice">
              单据或规则已变更，请重新检查后提交。
            </div>
          ) : (
            reviewedDraft && (
              <>
                <div className="srs-result-line">
                  <Badge
                    status={reviewedDraft.status}
                    label={
                      canSubmit
                        ? '可提交'
                        : data.draft.stage === '审批中'
                          ? '检查通过'
                          : '需修改'
                    }
                  />
                  <span>已执行 {reviewedDraft.applicable.length} 项规则</span>
                </div>
                {findings(reviewedDraft, data.draft)}
                {data.draft.stage === '草稿' &&
                  reviewedDraft.findings.some((f) => f.rule.id === 'R002') && (
                    <Button
                      onClick={() => {
                        setDraftInputError('');
                        setHotelText('600');
                        setData((prev) => ({
                          ...prev,
                          draft: {
                            ...prev.draft,
                            hotelNight: 600,
                            amount: 2900,
                            version: prev.draft.version + 1,
                          },
                        }));
                      }}
                    >
                      <Icon name="edit" size={15} />
                      按标准调整住宿费
                    </Button>
                  )}
              </>
            )
          )}
        </Drawer>
      )}
      {sheet?.type === 'schedule' && (
        <Drawer
          title="定时预审"
          eyebrow="我的设置"
          onClose={() => setSheet(null)}
          footer={
            <>
              <Button onClick={() => setSheet(null)}>取消</Button>
              <Button
                className="primary"
                onClick={() => {
                  if (!scheduleDraft.time) return;
                  setData((prev) => ({ ...prev, schedule: scheduleDraft }));
                  setSheet(null);
                  notify('定时预审设置已保存');
                }}
              >
                保存
              </Button>
            </>
          }
        >
          <div className="srs-setting-row">
            <div>
              <strong>每天预审待办</strong>
              <p>检查我的财务待办，生成一条汇总消息</p>
            </div>
            <button
              className={`srs-switch ${scheduleDraft.enabled ? 'on' : ''}`}
              role="switch"
              aria-checked={scheduleDraft.enabled}
              aria-label="每天预审待办"
              onClick={() =>
                setScheduleDraft((prev) => ({
                  ...prev,
                  enabled: !prev.enabled,
                }))
              }
            >
              <span />
            </button>
          </div>
          <label className="srs-time-field">
            执行时间
            <input
              type="time"
              value={scheduleDraft.time}
              onChange={(e) =>
                setScheduleDraft((prev) => ({ ...prev, time: e.target.value }))
              }
              required
            />
            <small>北京时间（UTC+8）</small>
          </label>
          <p className="srs-muted">本地演示仅保存设置，不执行后台定时任务。</p>
        </Drawer>
      )}
      {toast && (
        <div className="srs-toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
