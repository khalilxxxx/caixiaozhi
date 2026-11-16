import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import type { AgentCard, ResourceRef, SseEvent } from '@caixiaozhi/contracts';
import type { Run } from '@caixiaozhi/contracts/runs';
import type { InteractiveConfirmationReview } from '@caixiaozhi/contracts/actions';
import type { Thread, Message } from '@caixiaozhi/contracts/assistant';
import {
  createRunEventState,
  mergeRunEvent,
  type RunEventState,
} from '@caixiaozhi/assistant/events';
import { api, ApiFailure, formatMoney } from '../../api.js';
import { Drawer, Empty, ErrorNotice, Status } from '../../ui.js';
import { BusinessDocumentDrawer } from '../business/BusinessDocumentDrawer.js';
import { ConfirmationPanel } from '../business/ConfirmationPanel.js';
import './assistant.css';
type Card =
  AgentCard | { id: string; unavailable: true; title: string; actions: [] };
type Snapshot = {
  thread: Thread;
  messages: Message[];
  cards: Card[];
  active_run: Run | null;
  last_run?: Run | null;
  through_seq: number;
  snapshot_at: string;
};
type Home = {
  entries: Array<{ key: string; title: string }>;
  business: Record<string, any> | null;
  unread_count: number;
};
const terminal = (run: Run | null) =>
  !run || ['succeeded', 'failed', 'cancelled'].includes(run.status);
const resourceLabels: Record<string, string> = {
  travel: '差旅申请',
  expense_claim: '报销单',
  oa_request: '前置申请',
  rule: '规则',
  policy: '制度',
  analysis: '分析快照',
  report: '报告',
  skill: 'Skill',
};
const drawerFromUrl = (): ResourceRef | null => {
  const query = new URLSearchParams(location.search);
  const type = query.get('drawer'),
    id = query.get('resource');
  return type && id && Object.hasOwn(resourceLabels, type)
    ? { type: type as ResourceRef['type'], id, version: 1 }
    : null;
};
const eventTypes = [
  'run.status',
  'assistant.delta',
  'assistant.message',
  'tool.started',
  'tool.completed',
  'card.upsert',
  'confirmation.required',
  'usage.updated',
  'run.error',
];
export function AssistantPage({ me }: { me: Me }) {
  const [confirmationId, setConfirmationId] = useState<string | null>(null),
    [confirmationReview, setConfirmationReview] =
      useState<InteractiveConfirmationReview | null>(null);
  const [home, setHome] = useState<Home | null>(null),
    [threads, setThreads] = useState<Thread[]>([]),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [run, setRun] = useState<Run | null>(null);
  const [content, setContent] = useState(''),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [connection, setConnection] = useState(''),
    [streamText, setStreamText] = useState('');
  const [selectedRefs, setSelectedRefs] = useState<ResourceRef[]>([]),
    [document, setDocument] = useState<ResourceRef | null>(drawerFromUrl),
    [cardDrawer, setCardDrawer] = useState<AgentCard | null>(null),
    [citation, setCitation] = useState<Record<string, any> | null>(null);
  const [skills, setSkills] = useState<
      Array<{
        id: string;
        name?: string;
        title?: string;
        current_version_id?: string;
        published_version_id?: string;
      }>
    >([]),
    [selectedSkill, setSelectedSkill] = useState(
      new URLSearchParams(location.search).get('skill_version') ?? '',
    );
  const [newMessages, setNewMessages] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const streamState = useRef<RunEventState | null>(null);
  const currentThread = useRef<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const refreshList = useCallback(async () => {
    const result = await api<{ items: Thread[] }>('/threads');
    setThreads(result.items);
  }, []);
  const loadThread = useCallback(async (id: string) => {
    const value = await api<Snapshot>(
      `/threads/${encodeURIComponent(id)}/snapshot`,
    );
    if (currentThread.current !== id) return;
    setSnapshot(value);
    setRun(value.active_run ?? value.last_run ?? null);
    setStreamText('');
    streamState.current = value.active_run
      ? createRunEventState(value.active_run.id, value.through_seq)
      : null;
    if (value.active_run?.status === 'waiting_confirmation')
      void api<{ events: SseEvent[] }>(`/runs/${value.active_run.id}/snapshot`)
        .then((replay) => {
          if (currentThread.current !== id) return;
          const payload = replay.events.find(
            (event) => event.type === 'confirmation.required',
          )?.payload as Record<string, unknown> | undefined;
          if (typeof payload?.confirmation_id === 'string')
            setConfirmationId(payload.confirmation_id);
        })
        .catch(setError);
    return value;
  }, []);
  const selectThread = useCallback(
    (id: string | null, push = true) => {
      currentThread.current = id;
      setSnapshot(null);
      setRun(null);
      setStreamText('');
      setSelectedRefs([]);
      setError(null);
      setNewMessages(false);
      setConfirmationId(null);
      setConfirmationReview(null);
      setDocument(push ? null : drawerFromUrl());
      setCardDrawer(null);
      setCitation(null);
      if (push) {
        const url = new URL(location.href);
        if (id) url.searchParams.set('thread', id);
        else url.searchParams.delete('thread');
        url.searchParams.delete('drawer');
        url.searchParams.delete('resource');
        history.pushState(null, '', url);
      }
      if (id) void loadThread(id).catch(setError);
    },
    [loadThread],
  );
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      api<Home>('/home'),
      api<{ items: Thread[] }>('/threads'),
      api<any>('/skills'),
    ]).then((results) => {
      if (!active) return;
      const [h, t, s] = results;
      if (h.status === 'fulfilled') setHome(h.value);
      else setError(h.reason);
      if (t.status === 'fulfilled') setThreads(t.value.items);
      else setError(t.reason);
      if (s.status === 'fulfilled')
        setSkills(Array.isArray(s.value) ? s.value : (s.value.items ?? []));
      setLoading(false);
    });
    const id = new URLSearchParams(location.search).get('thread');
    if (id) selectThread(id, false);
    const pop = () =>
      selectThread(new URLSearchParams(location.search).get('thread'), false);
    const fresh = () => selectThread(null);
    const skillSelected = (event: Event) => {
      const value = (event as CustomEvent).detail?.skill_version_id;
      if (typeof value === 'string') setSelectedSkill(value);
    };
    window.addEventListener('select-finance-skill', skillSelected);
    window.addEventListener('popstate', pop);
    window.addEventListener('new-finance-conversation', fresh);
    return () => {
      active = false;
      window.removeEventListener('select-finance-skill', skillSelected);
      window.removeEventListener('popstate', pop);
      window.removeEventListener('new-finance-conversation', fresh);
    };
  }, [selectThread]);
  useEffect(() => {
    if (!run || terminal(run) || !snapshot) return;
    let closed = false,
      source: EventSource | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      attempt = 0;
    const runId = run.id,
      threadId = snapshot.thread.id;
    const reconnect = () => {
      if (closed) return;
      const state =
        streamState.current?.run_id === runId
          ? streamState.current
          : createRunEventState(runId, snapshot.through_seq);
      streamState.current = state;
      setConnection(attempt ? 'reconnecting' : 'connecting');
      source = new EventSource(
        `/api/v1/runs/${encodeURIComponent(runId)}/events?after=${state.through_seq}`,
        { withCredentials: true },
      );
      source.onopen = () => {
        attempt = 0;
        setConnection('live');
      };
      for (const type of eventTypes)
        source.addEventListener(type, ((raw: MessageEvent) => {
          if (closed || currentThread.current !== threadId) return;
          try {
            const event = JSON.parse(raw.data) as SseEvent;
            if (!streamState.current) return;
            const next = mergeRunEvent(streamState.current, event);
            streamState.current = next;
            if (next.recovery_required) {
              source?.close();
              void loadThread(threadId).catch(setError);
              return;
            }
            if (event.type === 'assistant.delta') {
              setStreamText(next.text);
              const node = transcript.current;
              if (
                node &&
                node.scrollHeight - node.scrollTop - node.clientHeight < 100
              )
                requestAnimationFrame(() =>
                  node.scrollTo({ top: node.scrollHeight }),
                );
              else setNewMessages(true);
            }
            if (event.type === 'card.upsert')
              setSnapshot((old) =>
                old
                  ? {
                      ...old,
                      cards: [
                        ...old.cards.filter(
                          (card) => card.id !== (event.payload as AgentCard).id,
                        ),
                        event.payload as AgentCard,
                      ],
                    }
                  : old,
              );
            if (event.type === 'confirmation.required') {
              const payload = event.payload as Record<string, unknown>;
              if (typeof payload.confirmation_id === 'string')
                setConfirmationId(payload.confirmation_id);
            }
            if (event.type === 'run.error')
              setError(
                new ApiFailure(
                  String((event.payload as any).code),
                  String((event.payload as any).message),
                  503,
                ),
              );
            if (
              event.type === 'assistant.message' ||
              event.type === 'run.status'
            ) {
              void api<Run>(`/runs/${runId}`)
                .then((value) => {
                  if (closed) return;
                  setRun(value);
                  if (terminal(value)) {
                    source?.close();
                    setConnection('');
                    void loadThread(threadId).catch(setError);
                    void refreshList().catch(() => {});
                  } else if (
                    value.status.startsWith('waiting') ||
                    value.status === 'interrupted'
                  )
                    void loadThread(threadId).catch(setError);
                })
                .catch(setError);
              if (event.type === 'assistant.message')
                void loadThread(threadId).catch(setError);
            }
          } catch {
            source?.close();
            void loadThread(threadId).catch(setError);
          }
        }) as EventListener);
      source.onerror = () => {
        source?.close();
        if (closed) return;
        setConnection('reconnecting');
        void api<Run>(`/runs/${runId}`)
          .then(async (value) => {
            if (terminal(value)) {
              setRun(value);
              await loadThread(threadId);
              setConnection('');
              return;
            }
            const next = await api<Snapshot>(`/threads/${threadId}/snapshot`);
            if (closed) return;
            setSnapshot(next);
            streamState.current = createRunEventState(runId, next.through_seq);
            setRun(value);
          })
          .catch(setError)
          .finally(() => {
            if (!closed)
              retry = setTimeout(
                reconnect,
                Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) +
                  Math.random() * 200,
              );
          });
      };
    };
    reconnect();
    return () => {
      closed = true;
      source?.close();
      clearTimeout(retry);
    };
  }, [run?.id, snapshot?.thread.id, loadThread, refreshList]);
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!content.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const message = {
        content: content.trim(),
        client_message_id: crypto.randomUUID(),
        intent: 'continue',
        resource_refs: selectedRefs,
        attachment_ids: [],
        ...(selectedSkill ? { selected_skill_version_id: selectedSkill } : {}),
      };
      let id = currentThread.current;
      if (!id) {
        const accepted = await api<{ thread: Thread; run_id: string }>(
          '/threads',
          { method: 'POST', body: { title: null, initial_message: message } },
        );
        id = accepted.thread.id;
        selectThread(id);
      } else {
        const latest = await api<Snapshot>(`/threads/${id}/snapshot`);
        await api(`/threads/${id}/messages`, {
          method: 'POST',
          body: { ...message, expected_version: latest.thread.version },
        });
      }
      setContent('');
      setSelectedRefs([]);
      await loadThread(id);
      await refreshList();
      composer.current?.focus();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const openEntry = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      const accepted = await api<{ thread_id: string }>(
        `/home/entries/${key}/open`,
        {
          method: 'POST',
          body: {
            client_message_id: crypto.randomUUID(),
            expected_binding_version: null,
          },
        },
      );
      selectThread(accepted.thread_id);
      await refreshList();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const latest = await api<Run>(`/runs/${run.id}`);
      setRun(
        await api<Run>(`/runs/${run.id}/cancel`, {
          method: 'POST',
          body: {
            expected_version: latest.version,
            reason: '用户停止当前任务',
          },
        }),
      );
      if (currentThread.current) await loadThread(currentThread.current);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    if (!run?.checkpoint_id) return;
    setBusy(true);
    try {
      await api(`/runs/${run.id}/resume`, {
        method: 'POST',
        body: {
          expected_version: run.version,
          checkpoint_id: run.checkpoint_id,
        },
      });
      if (currentThread.current) await loadThread(currentThread.current);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const openResource = (ref: ResourceRef) => {
    setDocument(ref);
    const url = new URL(location.href);
    url.searchParams.set('drawer', ref.type);
    url.searchParams.set('resource', ref.id);
    history.pushState(null, '', url);
  };
  const closeDocument = () => {
    setDocument(null);
    const url = new URL(location.href);
    url.searchParams.delete('drawer');
    url.searchParams.delete('resource');
    history.pushState(null, '', url);
  };
  const openCard = async (card: AgentCard) => {
    try {
      const latest = await api<Card>(`/cards/${encodeURIComponent(card.id)}`);
      if ('unavailable' in latest)
        throw new ApiFailure(
          'NOT_FOUND',
          '此结果引用的数据已不可查看，请重新查询。',
          404,
        );
      setCardDrawer(latest);
    } catch (failure) {
      setError(failure);
    }
  };
  const cardView = (card: Card) =>
    'unavailable' in card ? (
      <article className="assistant-result" key={card.id}>
        <p>{card.title}</p>
      </article>
    ) : (
      <article className="assistant-result" key={card.id}>
        <div className="result-heading">
          <h3>{card.title}</h3>
          {card.stale && <span className="stale-label">数据已有更新</span>}
        </div>
        <p>{card.summary}</p>
        {card.type === 'todo_summary' && (
          <p className="result-number">
            {String(card.payload.count)} 张{' '}
            <span>{formatMoney(card.payload.total as any)}</span>
          </p>
        )}
        {card.type === 'preaudit_summary' && (
          <div className="risk-breakdown">
            {Object.entries((card.payload as any).counts ?? {}).map(
              ([type, count]) => (
                <span key={type}>
                  <Status value={type} />
                  {String(count)} 张
                </span>
              ),
            )}
          </div>
        )}
        <small>
          生成于 {new Date(card.snapshot_at).toLocaleString('zh-CN')} · 修订{' '}
          {card.revision}
        </small>
        <div className="button-row">
          {card.resource_refs.map((ref) => (
            <button
              key={`${ref.type}:${ref.id}`}
              onClick={() => openResource(ref)}
            >
              {resourceLabels[ref.type]} {ref.id}
            </button>
          ))}
          <button onClick={() => void openCard(card)}>查看详情与依据</button>
        </div>
      </article>
    );
  const business = home?.business;
  const businessTotal =
    business?.total ?? business?.total_amount ?? business?.total_pending_amount;
  const businessCount =
    business?.pending_count ?? business?.count ?? business?.todo_count;
  return (
    <div className="assistant-layout">
      <aside className="conversation-list" aria-label="我的会话">
        <header>
          <h2>我的会话</h2>
          <button className="text-button" onClick={() => selectThread(null)}>
            新任务
          </button>
        </header>
        {threads.length ? (
          threads.map((thread) => (
            <button
              key={thread.id}
              className={snapshot?.thread.id === thread.id ? 'selected' : ''}
              onClick={() => selectThread(thread.id)}
            >
              <strong>{thread.title}</strong>
              <small>
                {new Date(thread.updated_at).toLocaleDateString('zh-CN')}
              </small>
            </button>
          ))
        ) : (
          <p className="muted">开始一件事后，会话会保存在这里。</p>
        )}
      </aside>
      <div className="assistant-main">
        {!snapshot ? (
          <>
            <header className="assistant-welcome">
              <h1>{me.display_name}，从一件财务小事开始</h1>
              <p>查政策、准备单据，或查看当前待办。</p>
              <a href="?page=personal&tab=inbox" className="inbox-link">
                收件箱
                {home?.unread_count ? ` · ${home.unread_count} 条未读` : ''}
              </a>
            </header>
            {loading ? (
              <p role="status">正在读取当前待办…</p>
            ) : (
              home && (
                <div className="assistant-entries">
                  {home.entries
                    .filter(
                      (entry) =>
                        entry.key !== 'approval-review' ||
                        me.actor.permissions.includes('approval.decide'),
                    )
                    .map((entry) => (
                      <button
                        key={entry.key}
                        disabled={busy}
                        onClick={() => void openEntry(entry.key)}
                      >
                        <strong>{entry.title}</strong>
                        {entry.key === 'approval-review' &&
                        businessCount !== undefined ? (
                          <span>
                            {businessCount} 项待处理
                            {businessTotal
                              ? ` · ${formatMoney(businessTotal)}`
                              : ''}
                          </span>
                        ) : (
                          <span>
                            {entry.key === 'prepare-expense'
                              ? '整理票据与所需材料'
                              : entry.key === 'expense-analysis'
                                ? '从有权查看的数据开始'
                                : entry.key === 'policy-question'
                                  ? '按来源查演示制度'
                                  : '读取当前授权待办'}
                          </span>
                        )}
                        <span aria-hidden="true">→</span>
                      </button>
                    ))}
                </div>
              )
            )}
          </>
        ) : (
          <>
            <header className="conversation-heading">
              <div>
                <h1>{snapshot.thread.title}</h1>
                <p>仅你可见 · {snapshot.messages.length} 条消息</p>
              </div>
              <button
                onClick={() =>
                  void loadThread(snapshot.thread.id).catch(setError)
                }
              >
                刷新记录
              </button>
            </header>
            <div
              ref={transcript}
              className="conversation-transcript"
              tabIndex={0}
              aria-label="对话记录"
            >
              {snapshot.messages.map((message) => (
                <article
                  className={`conversation-message message-${message.role}`}
                  key={message.id}
                >
                  <strong>
                    {message.role === 'user'
                      ? me.display_name
                      : message.role === 'assistant'
                        ? '财小智'
                        : '系统提示'}
                  </strong>
                  <p>{message.content}</p>
                  {message.status === 'pending_consumption' && (
                    <small>已保存，将在任务下一安全步骤处理。</small>
                  )}
                </article>
              ))}
              {snapshot.cards.map(cardView)}
              {streamText && (
                <article className="conversation-message message-assistant">
                  <strong>财小智</strong>
                  <p>{streamText}</p>
                  <small>正在整理结果…</small>
                </article>
              )}
              {snapshot.messages.length === 0 && (
                <Empty>可以从一件具体的事开始。</Empty>
              )}
            </div>
            {newMessages && (
              <button
                className="new-messages-button"
                onClick={() => {
                  transcript.current?.scrollTo({
                    top: transcript.current.scrollHeight,
                    behavior: 'smooth',
                  });
                  setNewMessages(false);
                }}
              >
                查看新消息
              </button>
            )}
          </>
        )}
        <ErrorNotice error={error} />
        {run && (
          <div className="run-progress" aria-live="polite">
            <div>
              <Status value={run.status} />
              {run.error_code === 'DEPENDENCY_UNAVAILABLE' && (
                <span>模型服务未配置或暂不可用，请配置后重试。</span>
              )}
              {connection === 'reconnecting' && (
                <span>连接暂时中断，任务仍在继续。</span>
              )}
              {run.phase === 'waiting_domain_job' && (
                <span>正在处理领域任务，当前不占用模型。</span>
              )}
            </div>
            <div className="button-row">
              {run.status === 'waiting_confirmation' && confirmationId && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() =>
                    void api<InteractiveConfirmationReview>(
                      `/confirmations/${encodeURIComponent(confirmationId)}`,
                    )
                      .then(setConfirmationReview)
                      .catch(setError)
                  }
                >
                  查看待确认操作
                </button>
              )}
              {run.status === 'interrupted' && (
                <button disabled={busy} onClick={() => void resume()}>
                  继续任务
                </button>
              )}
              {!terminal(run) && (
                <button disabled={busy} onClick={() => void stop()}>
                  停止后续步骤
                </button>
              )}
            </div>
          </div>
        )}
        <form
          className="assistant-composer"
          onSubmit={(event) => void send(event)}
        >
          {selectedSkill && (
            <div className="selected-context">
              已选择本次能力
              <button type="button" onClick={() => setSelectedSkill('')}>
                {skills.find(
                  (skill) =>
                    (skill.current_version_id ?? skill.published_version_id) ===
                    selectedSkill,
                )?.title ?? '已授权财务 Skill'}{' '}
                · 移除
              </button>
            </div>
          )}
          {selectedRefs.length > 0 && (
            <div className="selected-context">
              本次追问对象：
              {selectedRefs.map((ref) => (
                <button
                  type="button"
                  key={ref.id}
                  onClick={() =>
                    setSelectedRefs((old) =>
                      old.filter((item) => item.id !== ref.id),
                    )
                  }
                >
                  {resourceLabels[ref.type]} {ref.id} · 移除
                </button>
              ))}
            </div>
          )}
          <label className="sr-only" htmlFor="assistant-input">
            向财小智提问
          </label>
          <textarea
            id="assistant-input"
            ref={composer}
            value={content}
            maxLength={8000}
            placeholder="例如：下周去杭州，住宿标准是多少？"
            onChange={(event) => setContent(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !composing.current &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <div>
              {skills.length > 0 && (
                <select
                  aria-label="选择本次Skill"
                  value={selectedSkill}
                  onChange={(event) => setSelectedSkill(event.target.value)}
                >
                  <option value="">基础财务助理</option>
                  {skills
                    .filter(
                      (skill) =>
                        skill.current_version_id ?? skill.published_version_id,
                    )
                    .map((skill) => (
                      <option
                        key={skill.id}
                        value={
                          skill.current_version_id ?? skill.published_version_id
                        }
                      >
                        {skill.title ?? skill.name ?? '已授权 Skill'}
                      </option>
                    ))}
                </select>
              )}
              <small>Enter 发送 · Shift + Enter 换行</small>
            </div>
            <button
              className="primary-button"
              disabled={
                busy ||
                !content.trim() ||
                run?.status === 'reconciling' ||
                run?.status === 'interrupted'
              }
            >
              {busy ? '正在保存…' : '发送'}
            </button>
          </div>
        </form>
        <p className="composer-note">
          重要业务操作需要你明确确认，完成状态以服务端回执为准。
        </p>
      </div>
      {document &&
        ['travel', 'expense_claim', 'oa_request'].includes(document.type) && (
          <BusinessDocumentDrawer
            kind={
              document.type === 'travel'
                ? 'travel'
                : document.type === 'expense_claim'
                  ? 'expenses'
                  : 'oa'
            }
            id={document.id}
            me={me}
            onClose={closeDocument}
            onChanged={() => {
              if (snapshot) void loadThread(snapshot.thread.id);
            }}
          />
        )}
      {document &&
        !['travel', 'expense_claim', 'oa_request'].includes(document.type) && (
          <Drawer
            title={resourceLabels[document.type] ?? '资源详情'}
            onClose={closeDocument}
          >
            <p>请在对应工作区查看已授权的最新资源。</p>
            <a
              href={`?page=${['analysis', 'report'].includes(document.type) ? 'analytics' : 'knowledge'}&resource=${encodeURIComponent(document.id)}`}
            >
              打开对应工作区
            </a>
            <button
              onClick={() => {
                setSelectedRefs([document]);
                closeDocument();
                composer.current?.focus();
              }}
            >
              将此对象用于追问
            </button>
          </Drawer>
        )}
      {cardDrawer && (
        <Drawer
          title={cardDrawer.title}
          subtitle={`快照生成于 ${new Date(cardDrawer.snapshot_at).toLocaleString('zh-CN')}`}
          onClose={() => setCardDrawer(null)}
        >
          <p className="preserve-lines">{cardDrawer.summary}</p>
          {cardDrawer.stale && (
            <p role="alert">数据已有更新，请读取最新对象后再准备操作。</p>
          )}
          {cardDrawer.type === 'policy_answer' && (
            <>
              <p className="preserve-lines">
                {String(cardDrawer.payload.answer)}
              </p>
              <h3>引用依据</h3>
              {((cardDrawer.payload.citation_refs ?? []) as string[]).map(
                (id) => (
                  <button
                    key={id}
                    onClick={() =>
                      void api<Record<string, any>>(
                        `/knowledge/citations/${encodeURIComponent(id)}`,
                      )
                        .then(setCitation)
                        .catch(setError)
                    }
                  >
                    查看制度原段落
                  </button>
                ),
              )}
            </>
          )}
          {cardDrawer.resource_refs.map((ref) => (
            <div className="card-resource-row" key={ref.id}>
              <p>
                {resourceLabels[ref.type]} {ref.id} · v{ref.version}
              </p>
              <div className="button-row">
                <button
                  onClick={() => {
                    setCardDrawer(null);
                    openResource(ref);
                  }}
                >
                  查看最新详情
                </button>
                <button
                  onClick={() => {
                    setSelectedRefs([ref]);
                    setCardDrawer(null);
                    composer.current?.focus();
                  }}
                >
                  用于本次追问
                </button>
              </div>
            </div>
          ))}
          {cardDrawer.type === 'action_result' && (
            <ul className="result-outcomes">
              {((cardDrawer.payload.outcomes ?? []) as any[]).map((outcome) => (
                <li key={outcome.action_id}>
                  {outcome.action_id} <Status value={outcome.outcome} />
                </li>
              ))}
            </ul>
          )}
          {cardDrawer.type === 'reminder_summary' && (
            <p>这是只读摘要快照，未自动处理任何审批。</p>
          )}
        </Drawer>
      )}
      {citation && (
        <Drawer title="制度来源" onClose={() => setCitation(null)}>
          <p>
            {String(citation.policy_title ?? citation.title ?? '已授权制度')}
          </p>
          <p className="preserve-lines">
            {String(
              citation.text ??
                citation.content ??
                citation.quote ??
                citation.paragraph ??
                '请打开制度工作区查看完整段落。',
            )}
          </p>
        </Drawer>
      )}
      {confirmationReview && (
        <ConfirmationPanel
          initial={confirmationReview}
          actorName={me.display_name}
          onClose={() => setConfirmationReview(null)}
          onChanged={() => {
            if (currentThread.current)
              void loadThread(currentThread.current).catch(setError);
            void refreshList().catch(setError);
          }}
        />
      )}
    </div>
  );
}
