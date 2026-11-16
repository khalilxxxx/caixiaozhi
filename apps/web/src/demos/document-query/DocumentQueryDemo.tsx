import { useEffect, useRef, useState, type ReactNode } from 'react';
import { documents } from './fixtures.js';
import { presentDocument, type GenericDocument } from './document-model.js';

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
};
const processingRules: Record<string, string> = {
  all: '会签：所有参与人通过后继续',
  any: '或签：任一参与人通过后继续',
  pool: '共享任务池：等待经办人认领',
};

type IconName =
  | 'logo'
  | 'document'
  | 'arrow'
  | 'close'
  | 'send'
  | 'clock'
  | 'check'
  | 'layers'
  | 'search';
function Icon({
  name,
  className = '',
}: {
  name: IconName;
  className?: string;
}) {
  const paths: Record<IconName, ReactNode> = {
    logo: (
      <>
        <path d="M5 8h14v11H5zM8 5h8M8 12h8M8 15h5" />
        <path d="m16 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
      </>
    ),
    document: (
      <>
        <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h4" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    send: (
      <>
        <path d="m5 12 7-7 7 7M12 5v15" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
    layers: (
      <>
        <path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
  };
  return (
    <svg
      className={`dq-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function DocumentCard({
  document: doc,
  onOpen,
}: {
  document: GenericDocument;
  onOpen: (doc: GenericDocument) => void;
}) {
  const view = presentDocument(doc);
  return (
    <button
      className="dq-card"
      onClick={() => onOpen(doc)}
      aria-label={`查看${doc.title}详情，${doc.typeLabel}，${view.displayStatus}，${doc.source.label}`}
      data-document-key={doc.key}
    >
      <span className={`dq-document-icon tone-${doc.status}`}>
        <Icon name="document" />
      </span>
      <span className="dq-card-content">
        <span className="dq-card-heading">
          <strong title={doc.title}>{doc.title}</strong>
          <span className={`dq-status status-${doc.status}`}>
            {view.displayStatus}
          </span>
        </span>
        <span
          className="dq-card-summary"
          title={view.cardSummary
            .map((x) => `${x.label}：${x.value}`)
            .join(' · ')}
        >
          <span className="dq-type">{doc.typeLabel}</span>
          {view.cardSummary.map((field, i) => (
            <span className="dq-summary-value" key={`${field.label}-${i}`}>
              <span className="sr-only">{field.label}：</span>
              {field.value}
            </span>
          ))}
        </span>
        <span className="dq-card-progress">
          <span
            className="dq-current"
            title={`${doc.source.label} · ${view.currentLabel}`}
          >
            <span className="dq-source">{doc.source.label}</span>
            <span className="dq-current-text">{view.currentLabel}</span>
          </span>
          {view.estimateLabel && (
            <span
              className="dq-estimate"
              title={doc.estimate?.compactLabel || view.estimateLabel}
            >
              <Icon name="clock" />
              {doc.estimate?.compactLabel || view.estimateLabel}
            </span>
          )}
        </span>
      </span>
      <Icon name="arrow" className="dq-card-chevron" />
    </button>
  );
}

function Sheet({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = ref.current;
    const trigger = document.activeElement as HTMLElement | null;
    element?.showModal();
    closeRef.current?.focus();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dq-sheet ${wide ? 'wide' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (
          event.target === event.currentTarget &&
          event.clientX < event.currentTarget.getBoundingClientRect().left
        )
          onClose();
      }}
    >
      <header className="dq-sheet-head">
        <h2>{title}</h2>
        <button
          ref={closeRef}
          className="dq-icon-button"
          onClick={onClose}
          aria-label="关闭详情"
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function DocumentDetails({
  document: doc,
  onClose,
}: {
  document: GenericDocument;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'progress' | 'information'>('progress');
  const view = presentDocument(doc);
  const isExecution = doc.phase === 'execution';
  return (
    <Sheet title="单据详情" onClose={onClose}>
      <div className="dq-detail-identity">
        <div className="dq-detail-source">
          {doc.source.label} / {doc.typeLabel}
        </div>
        <div className="dq-detail-title">
          <h3>{doc.title}</h3>
          <span className={`dq-status status-${doc.status}`}>
            {view.displayStatus}
          </span>
        </div>
        <span className="dq-document-number">{doc.id}</span>
      </div>
      <div className="dq-tabs" role="tablist" aria-label="单据详情内容">
        {(['progress', 'information'] as const).map((value, index) => (
          <button
            id={`dq-tab-${value}`}
            key={value}
            role="tab"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            aria-controls="dq-detail-panel"
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault();
                const other = index === 0 ? 'information' : 'progress';
                setTab(other);
                document.getElementById(`dq-tab-${other}`)?.focus();
              }
            }}
          >
            {value === 'progress' ? '办理进展' : '单据信息'}
          </button>
        ))}
      </div>
      <div
        className="dq-sheet-body"
        id="dq-detail-panel"
        role="tabpanel"
        aria-labelledby={`dq-tab-${tab}`}
      >
        {tab === 'progress' ? (
          <>
            <div className="dq-current-summary">
              <span>当前进展</span>
              <strong>{view.currentLabel}</strong>
              {doc.current?.since && (
                <p>进入节点：{formatTime(doc.current.since)}</p>
              )}
              {doc.current?.rule && processingRules[doc.current.rule] && (
                <p>{processingRules[doc.current.rule]}</p>
              )}
            </div>
            {doc.status === 'needs_action' && (
              <p className="dq-context-note warning">
                请查看下方退回说明，在原系统补充后重新提交。本演示只查询进展。
              </p>
            )}
            {isExecution && (
              <p className="dq-context-note">
                审批已通过，单据仍在后续办理中。
                {doc.paymentStatus || '当前执行结果以来源系统为准。'}
              </p>
            )}
            <ol className="dq-timeline">
              {doc.steps.map((step) => (
                <li className={`step-${step.status}`} key={step.id}>
                  <span className="dq-step-dot">
                    {step.status === 'done' && <Icon name="check" />}
                  </span>
                  <div className="dq-step-heading">
                    <strong>{step.label}</strong>
                    <span>
                      {
                        (
                          {
                            done: '已完成',
                            current: '当前',
                            future: '后续',
                            conditional: '可能追加',
                            returned: '已退回',
                          } as const
                        )[step.status]
                      }
                    </span>
                  </div>
                  {step.actors?.length ? <p>{step.actors.join('、')}</p> : null}
                  {step.note && <p>{step.note}</p>}
                  {step.time && <small>{step.time}</small>}
                </li>
              ))}
            </ol>
            {doc.estimate && view.estimateLabel ? (
              <details className="dq-estimate-detail">
                <summary>
                  <Icon name="clock" />
                  <span>{view.estimateLabel}</span>
                  <span className="dq-muted">预估依据</span>
                </summary>
                <p>
                  目标：
                  {doc.estimate.target === 'approval_complete'
                    ? '审批完成'
                    : '办理完成'}
                  。{doc.estimate.basis}
                </p>
                <p>历史统计预估，不是完成承诺。</p>
              </details>
            ) : (
              doc.status === 'processing' && (
                <p className="dq-detail-footnote">
                  暂无可靠的{isExecution ? '办理' : '审批'}完成时间预估。
                </p>
              )
            )}
          </>
        ) : (
          <>
            <dl className="dq-information">
              <div>
                <dt>来源系统</dt>
                <dd>{doc.source.label}</dd>
              </div>
              <div>
                <dt>单据类型</dt>
                <dd>{doc.typeLabel}</dd>
              </div>
              <div>
                <dt>源系统状态</dt>
                <dd>{doc.sourceStatus}</dd>
              </div>
              <div>
                <dt>当前阶段</dt>
                <dd>{doc.phaseLabel}</dd>
              </div>
              {doc.amount &&
                !doc.details.some(
                  (field) => field.label === doc.amount?.label,
                ) && (
                  <div>
                    <dt>{doc.amount.label}</dt>
                    <dd>
                      {doc.amount.value} {doc.amount.currency}
                    </dd>
                  </div>
                )}
              {doc.details.map((field, i) => (
                <div key={`${field.label}-${i}`}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
            {doc.paymentStatus && (
              <p className="dq-context-note">付款状态：{doc.paymentStatus}</p>
            )}
          </>
        )}
        <p className="dq-detail-footnote">
          {doc.source.label} · 数据更新于 {formatTime(doc.updatedAt)}
          （北京时间）
          <br />
          人物、单据、审批记录及预估均为虚构示例。
        </p>
      </div>
    </Sheet>
  );
}

const examples = [
  {
    label: '上海差旅',
    query: '我去上海的差旅现在到哪一步了？',
    type: 'travel_application',
  },
  {
    label: '北京报销',
    query: '看看我北京出差的报销单。',
    type: 'expense_claim',
  },
  { label: 'OA 请假', query: '我的年假申请批了吗？', type: 'oa_leave' },
  { label: '采购付款', query: '采购设备的款付了吗？', type: 'payment_request' },
  {
    label: '合同审批',
    query: '我的合同还在谁那里？',
    type: 'contract_approval',
  },
  { label: '预算调拨', query: '预算调拨办理完了吗？', type: 'budget_transfer' },
];
type Scenario = 'normal' | 'empty' | 'partial';

export function DocumentQueryDemo() {
  const [type, setType] = useState<string | null>('travel_application');
  const [exactKeys, setExactKeys] = useState<string[] | null>(null);
  const [query, setQuery] = useState(examples[0]!.query);
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [expanded, setExpanded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lastOpenedKey, setLastOpenedKey] = useState<string | null>(null);
  const [designOpen, setDesignOpen] = useState(false);
  const selected = documents.find((doc) => doc.key === selectedKey);
  const collection =
    scenario === 'empty'
      ? []
      : documents.filter(
          (doc) =>
            (!exactKeys || exactKeys.includes(doc.key)) &&
            (!type || doc.typeId === type) &&
            (sourceFilter === 'all' || doc.source.id === sourceFilter) &&
            (scenario !== 'partial' || doc.source.id !== 'oa'),
        );
  const matching =
    scenario === 'empty'
      ? []
      : collection.filter(
          (doc) => statusFilter === 'all' || doc.status === statusFilter,
        );
  const sourceUnavailable = scenario === 'partial' && sourceFilter === 'oa';
  const incomplete =
    scenario === 'partial' && (sourceFilter === 'all' || sourceFilter === 'oa');
  const shown = expanded ? matching : matching.slice(0, 3);
  const sources = [
    ...new Map(documents.map((doc) => [doc.source.id, doc.source])).values(),
  ];

  function openDocument(key: string) {
    setSelectedKey(key);
    setLastOpenedKey(key);
  }
  function choose(nextType: string | null, text: string) {
    setType(nextType);
    setExactKeys(null);
    setLastOpenedKey(null);
    setQuery(text);
    setNotice('');
    setStatusFilter('all');
    setSourceFilter('all');
    setExpanded(false);
    setScenario('normal');
  }
  function submit(text: string) {
    const question = text.trim();
    if (!question) return;
    if (/别人|他人|同事|全公司|所有员工|张伟的|刘敏的|李婷的/.test(question)) {
      setNotice('这里只演示查询本人的单据，当前结果未改变。');
      return;
    }
    if (/催办|撤回|帮我批准|替我审批|转账|取消申请|提交申请/.test(question)) {
      setNotice('这个 Demo 仅查询单据，不执行催办、审批或提交。');
      return;
    }
    const exact = documents.filter((doc) =>
      question.toUpperCase().includes(doc.id.toUpperCase()),
    );
    if (exact.length) {
      choose(null, question);
      setExactKeys(exact.map((doc) => doc.key));
      if (exact.length > 1)
        setNotice('不同系统存在相同单号，请根据来源系统选择。');
      setInput('');
      return;
    }
    // Explicit business types take precedence over city names or purchase context.
    const example = /合同|用印/.test(question)
      ? examples[4]
      : /预算|调拨/.test(question)
        ? examples[5]
        : /请假|年假/.test(question)
          ? examples[2]
          : /报销/.test(question)
            ? examples[1]
            : /付款|设备|采购|付了吗/.test(question)
              ? examples[3]
              : /差旅|出差申请/.test(question)
                ? examples[0]
                : /上海/.test(question)
                  ? examples[0]
                  : /北京/.test(question)
                    ? examples[1]
                    : undefined;
    if (example) {
      choose(example.type, question);
      const city = ['上海', '北京'].find((value) => question.includes(value));
      if (
        city &&
        !documents.some(
          (doc) =>
            doc.typeId === example.type &&
            [doc.title, ...doc.summary.map((field) => field.value)].some(
              (value) => value.includes(city),
            ),
        )
      ) {
        setScenario('empty');
        setNotice('当前本地样例没有符合该城市与单据类型的记录。');
      }
      setInput('');
      return;
    }
    if (/全部|所有|最近|我的单据/.test(question)) {
      choose(null, question);
      if (/全部|所有|历史/.test(question))
        setNotice('本地样例只有最近 30 天的 6 张单据，不代表真实的全部历史。');
      setInput('');
      return;
    }
    if (/流程|步骤|多久|谁|这张|还没/.test(question)) {
      const lastOpened = matching.find((doc) => doc.key === lastOpenedKey);
      if (lastOpened || matching.length === 1) {
        openDocument(lastOpened?.key ?? matching[0]!.key);
        setInput('');
      } else setNotice('匹配了多张单据，请先点开你想追问的那一张。');
      return;
    }
    setNotice(
      '试试上方的单据示例，或输入“我的全部单据”。本地演示尚未连接模型。',
    );
  }
  return (
    <div className="dq-app">
      <aside className="dq-rail" aria-label="财小智">
        <div className="dq-logo">
          <Icon name="logo" />
        </div>
        <span>财小智</span>
        <div className="dq-rail-line" />
        <Icon name="layers" />
        <span className="dq-rail-caption">我的工作</span>
      </aside>
      <div className="dq-workspace">
        <header className="dq-header">
          <div>
            <span className="dq-breadcrumb">财小智</span>
            <span className="dq-slash">/</span>
            <h1>我的单据</h1>
          </div>
          <div className="dq-header-actions">
            <span className="dq-demo-badge">本地 Demo</span>
            <button
              className="dq-text-button"
              onClick={() => setDesignOpen(true)}
            >
              设计说明
            </button>
            <span className="dq-user-avatar" aria-label="本人示例账户">
              我
            </span>
          </div>
        </header>
        <div className="dq-review-controls">
          <span>体验不同单据</span>
          <div>
            {examples.map((example) => (
              <button
                key={example.type}
                aria-pressed={type === example.type}
                onClick={() => choose(example.type, example.query)}
              >
                {example.label}
              </button>
            ))}
            <button
              aria-pressed={type === null}
              onClick={() => choose(null, '看看我最近所有单据的进展。')}
            >
              全部单据
            </button>
          </div>
        </div>
        <main className="dq-conversation">
          <div className="dq-user-message">
            <p>{query}</p>
          </div>
          <section className="dq-response" aria-label="单据查询结果">
            <div className="dq-assistant-name">
              <Icon name="logo" />
              <span>财小智</span>
            </div>
            <p className="dq-answer" aria-live="polite">
              {sourceUnavailable
                ? 'OA 暂时无法读取，请恢复后确认单据情况。'
                : scenario === 'empty'
                  ? '当前查询范围内没有匹配的单据。'
                  : matching.length === 1
                    ? `找到这张${matching[0]!.typeLabel}，进展如下。`
                    : `${incomplete ? '当前已读取到' : '找到'} ${matching.length} 张单据${matching.some((doc) => doc.status === 'needs_action') ? '，其中有单据需要你补充' : ''}。`}
            </p>
            {!type && (
              <div className="dq-result-tools">
                <div className="dq-filter-tabs" aria-label="按单据进展筛选">
                  {[
                    { value: 'all', label: '全部' },
                    { value: 'processing', label: '进行中' },
                    { value: 'needs_action', label: '待我处理' },
                    { value: 'completed', label: '已完成' },
                  ].map((filter) => (
                    <button
                      key={filter.value}
                      aria-pressed={statusFilter === filter.value}
                      onClick={() => {
                        setStatusFilter(filter.value);
                        setExpanded(false);
                      }}
                    >
                      {filter.label}
                      <span>
                        {sourceUnavailable
                          ? '—'
                          : collection.filter(
                              (doc) =>
                                filter.value === 'all' ||
                                doc.status === filter.value,
                            ).length}
                      </span>
                    </button>
                  ))}
                </div>
                <select
                  aria-label="按来源系统筛选"
                  value={sourceFilter}
                  onChange={(event) => {
                    setSourceFilter(event.target.value);
                    setExpanded(false);
                  }}
                >
                  <option value="all">所有系统</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {incomplete && (
              <div className="dq-warning" role="status">
                <span>OA 暂时无法读取，当前结果不完整。</span>
                <button onClick={() => setScenario('normal')}>重新读取</button>
              </div>
            )}
            <div className={`dq-results ${shown.length > 1 ? 'multiple' : ''}`}>
              {shown.map((doc) => (
                <DocumentCard
                  key={doc.key}
                  document={doc}
                  onOpen={(item) => openDocument(item.key)}
                />
              ))}
            </div>
            {!matching.length && (
              <div className="dq-empty">
                <Icon name="search" />
                <strong>
                  {sourceUnavailable ? 'OA 暂时不可用' : '没有匹配结果'}
                </strong>
                <p>
                  {sourceUnavailable
                    ? '恢复读取后再确认状态，不能判断为没有单据。'
                    : '可以切换单据类型，或查看所有示例单据。'}
                </p>
                <button
                  onClick={() => choose(null, '看看我最近所有单据的进展。')}
                >
                  查看所有示例
                </button>
              </div>
            )}
            {matching.length > 3 && (
              <button
                className="dq-show-more"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? '收起清单'
                  : `还有 ${matching.length - 3} 张，展开查看`}
                <Icon name="arrow" />
              </button>
            )}
            <div className="dq-query-meta">
              <span>仅本人 · 最近 30 天 · 示例结果</span>
              <span>查询于 10:30</span>
            </div>
            <div className="dq-followups">
              <button
                onClick={() => {
                  if (matching.length === 1) setSelectedKey(matching[0]!.key);
                  else setNotice('点击一张单据，即可查看完整办理进展。');
                }}
              >
                查看完整进展
                <Icon name="arrow" />
              </button>
              <button
                onClick={() => choose(null, '看看我最近所有单据的进展。')}
              >
                看看其他单据
                <Icon name="arrow" />
              </button>
            </div>
          </section>
          {notice && (
            <div className="dq-notice" role="status">
              {notice}
              <button aria-label="关闭提示" onClick={() => setNotice('')}>
                <Icon name="close" />
              </button>
            </div>
          )}
        </main>
        <footer className="dq-composer-area">
          <form
            className="dq-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit(input);
            }}
          >
            <input
              aria-label="询问我的单据"
              placeholder="问问我的单据，也可以直接点开卡片…"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing && event.key === 'Enter')
                  event.preventDefault();
              }}
              maxLength={300}
            />
            <button
              className="dq-send"
              type="submit"
              aria-label="发送查询"
              disabled={!input.trim()}
            >
              <Icon name="send" />
            </button>
          </form>
          <div className="dq-demo-footer">
            <span>示例数据 · 未连接业务系统</span>
            <label>
              评审场景
              <select
                aria-label="评审场景"
                value={scenario}
                onChange={(event) => {
                  const value = event.target.value as Scenario;
                  setScenario(value);
                  setExpanded(false);
                  setNotice('');
                  if (value === 'partial') {
                    setExactKeys(null);
                    setType(null);
                    setStatusFilter('all');
                    setSourceFilter('all');
                    setQuery('看看我最近所有单据的进展。');
                  }
                }}
              >
                <option value="normal">正常结果</option>
                <option value="empty">没有匹配</option>
                <option value="partial">OA 暂不可用</option>
              </select>
            </label>
          </div>
        </footer>
      </div>
      {selected && (
        <DocumentDetails
          key={selected.key}
          document={selected}
          onClose={() => setSelectedKey(null)}
        />
      )}
      {designOpen && (
        <Sheet
          title="精简卡片，统一表达"
          wide
          onClose={() => setDesignOpen(false)}
        >
          <div className="dq-sheet-body dq-design-notes">
            <p className="dq-design-intro">
              卡片回答“是哪一张、现在怎么样”。完整业务内容和流程，在需要时展开。
            </p>
            <h3>常显只留三行</h3>
            <ol>
              <li>
                <b>标题＋准确状态</b>：待审批、待你补充、待付款各有明确含义。
              </li>
              <li>
                <b>类型＋两项摘要</b>：由单据类型决定，缺少金额的 OA
                不保留空位。
              </li>
              <li>
                <b>来源＋当前处理</b>：有可靠预估时顺带显示，不另起区域。
              </li>
            </ol>
            <h3>不同系统共用一个卡片组件</h3>
            <table>
              <thead>
                <tr>
                  <th>单据</th>
                  <th>摘要重点</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>差旅申请</td>
                  <td>路线、日期</td>
                </tr>
                <tr>
                  <td>费用报销</td>
                  <td>报销金额、费用期间</td>
                </tr>
                <tr>
                  <td>OA 请假</td>
                  <td>日期、天数</td>
                </tr>
                <tr>
                  <td>采购付款</td>
                  <td>付款金额、收款方</td>
                </tr>
                <tr>
                  <td>合同审批</td>
                  <td>相对方、合同金额</td>
                </tr>
                <tr>
                  <td>预算调拨</td>
                  <td>调拨金额、预算方向</td>
                </tr>
              </tbody>
            </table>
            <h3>通用结构不覆盖业务含义</h3>
            <p>
              来源系统、对象类型和对象 ID
              共同识别一张单据。分组用于筛选；卡片保留源系统的具体状态，审批通过后的付款、用印、归档等仍可继续显示为“办理中”。
            </p>
            <h3>详情承载完整信息</h3>
            <p>
              单号、来源状态、业务字段、全部节点、会签人员、退回说明、更新时间及预估依据都保留在详情中。未知预估在卡片省略，详情明确说明。
            </p>
            <p className="dq-detail-footnote">
              这是独立前端评审入口，使用本地模拟数据。后续可由不同系统的适配器生成相同的展示结构，替换样例数据。
            </p>
          </div>
        </Sheet>
      )}
    </div>
  );
}
