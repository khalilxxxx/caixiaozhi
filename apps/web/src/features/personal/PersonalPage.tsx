import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import { api } from '../../api.js';
import {
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  SectionTitle,
  Status,
} from '../../ui.js';
import './personal.css';
type Memory = {
  id: string;
  version: number;
  kind: string;
  key: string;
  content: string | null;
  value: Record<string, string | boolean> | null;
  status: string;
  expires_at: string | null;
  updated_at: string;
  source: { kind: string; message_id?: string };
};
type Subscription = {
  id: string;
  version: number;
  type: string;
  title: string;
  status: string;
  next_run_at: string;
  schedule: {
    frequency: string;
    local_time: string;
    timezone: string;
    start_date: string;
  };
  query_spec: Record<string, any>;
  skill_version_id: string | null;
  error_code: string | null;
};
type Inbox = {
  id: string;
  version: number;
  title: string;
  preview: string;
  revision: number;
  read_revision: number;
  unread: boolean;
  created_at: string;
  thread_id: string | null;
};
const memoryLabels: Record<string, string> = {
  response_preference: '表达偏好',
  input_preference: '输入偏好',
  personal_context: '工作背景',
};
const stateLabels: Record<string, string> = {
  active: '已启用',
  paused: '已暂停',
  blocked: '权限待复核',
  deleted: '已删除',
  expired: '已过期',
  source_unavailable: '来源不可用',
  scheduled: '待生成',
  generating: '生成中',
  generated: '已生成',
  delivered: '已送达',
  failed: '生成失败',
  skipped_coalesced: '已合并补跑',
  skipped_late: '已超过补跑时间',
  superseded: '日程已修改',
  cancelled: '已停止',
  delivery_expired: '投递已过期',
};
const localDate = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
export function PersonalPage({ me }: { me: Me }) {
  const [tab, setTab] = useState(
      new URLSearchParams(location.search).get('tab') ?? 'memories',
    ),
    [memories, setMemories] = useState<Memory[]>([]),
    [subscriptions, setSubscriptions] = useState<Subscription[]>([]),
    [inbox, setInbox] = useState<Inbox[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [success, setSuccess] = useState('');
  const [memoryEdit, setMemoryEdit] = useState<Memory | null | undefined>(
      undefined,
    ),
    [memoryKind, setMemoryKind] = useState('response_preference'),
    [memoryKey, setMemoryKey] = useState(''),
    [memoryContent, setMemoryContent] = useState(''),
    [memoryExpiry, setMemoryExpiry] = useState('');
  const [subscriptionEdit, setSubscriptionEdit] = useState<
      Subscription | null | undefined
    >(undefined),
    [title, setTitle] = useState('工作日待审报销'),
    [type, setType] = useState('todo_digest'),
    [frequency, setFrequency] = useState('weekdays'),
    [time, setTime] = useState('09:00'),
    [timezone, setTimezone] = useState('Asia/Shanghai'),
    [startDate, setStartDate] = useState(localDate(new Date())),
    [scope, setScope] = useState('own_expenses'),
    [period, setPeriod] = useState('this_month'),
    [documentType, setDocumentType] = useState('expense_claim'),
    [documentId, setDocumentId] = useState(''),
    [documentVersion, setDocumentVersion] = useState('1');
  const [preview, setPreview] = useState<
      Array<{
        scheduled_at: string;
        local_date: string;
        local_time: string;
        timezone: string;
      }>
    >([]),
    [history, setHistory] = useState<{
      subscription: Subscription;
      items: any[];
    } | null>(null),
    [inboxDetail, setInboxDetail] = useState<{
      item: Inbox;
      thread_id: string;
      messages: Array<{ id: string; content: string }>;
    } | null>(null);
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api<{ items: Memory[] }>('/memories'),
      api<{ items: Subscription[] }>('/subscriptions'),
      api<{ items: Inbox[] }>('/inbox'),
    ]);
    const [m, s, i] = results;
    if (m.status === 'fulfilled') setMemories(m.value.items);
    else setError(m.reason);
    if (s.status === 'fulfilled') setSubscriptions(s.value.items);
    else setError(s.reason);
    if (i.status === 'fulfilled') setInbox(i.value.items);
    else setError(i.reason);
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
    void api<{ business_now: string }>('/demo/environments/current')
      .then((value) => setStartDate(localDate(new Date(value.business_now))))
      .catch(() => {});
  }, [refresh]);
  useEffect(() => {
    if (
      !inboxDetail ||
      inboxDetail.item.read_revision >= inboxDetail.item.revision
    )
      return;
    let active = true;
    void api(`/inbox/${inboxDetail.item.id}/read`, {
      method: 'POST',
      body: {
        expected_version: inboxDetail.item.version,
        read_revision: inboxDetail.item.revision,
      },
    })
      .then(() => {
        if (active) void refresh();
      })
      .catch((failure) => {
        if (active) setError(failure);
      });
    return () => {
      active = false;
    };
  }, [inboxDetail?.item.id, inboxDetail?.item.revision, refresh]);
  const changeTab = (value: string) => {
    setTab(value);
    setError(null);
    setSuccess('');
    const url = new URL(location.href);
    url.searchParams.set('tab', value);
    historyPush(url);
  };
  const operation = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess('');
    try {
      await work();
      await refresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const editMemory = (memory: Memory | null) => {
    setMemoryEdit(memory);
    setMemoryKind(memory?.kind ?? 'response_preference');
    setMemoryKey(memory?.key ?? '');
    setMemoryContent(memory?.content ?? '');
    setMemoryExpiry(
      memory?.expires_at
        ? new Date(
            new Date(memory.expires_at).getTime() -
              new Date().getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : '',
    );
  };
  const saveMemory = (event: FormEvent) => {
    event.preventDefault();
    void operation(async () => {
      const input = {
        kind: memoryKind,
        key: memoryKey.trim(),
        content: memoryContent.trim(),
        value: {},
        expires_at: memoryExpiry ? new Date(memoryExpiry).toISOString() : null,
        source: { kind: 'manual' },
        explicit_save: true,
      };
      await api(memoryEdit ? `/memories/${memoryEdit.id}` : '/memories', {
        method: memoryEdit ? 'PATCH' : 'POST',
        body: {
          ...input,
          ...(memoryEdit ? { expected_version: memoryEdit.version } : {}),
        },
      });
      setMemoryEdit(undefined);
      setSuccess('个人记忆已保存，仅对你后续的表达与输入建议生效。');
    });
  };
  const editSubscription = (subscription: Subscription | null) => {
    setSubscriptionEdit(subscription);
    setTitle(subscription?.title ?? '工作日待审报销');
    setType(
      subscription?.type ??
        (me.actor.permissions.includes('approval.decide')
          ? 'todo_digest'
          : me.actor.permissions.includes('analytics.query')
            ? 'expense_digest'
            : 'document_progress'),
    );
    setFrequency(subscription?.schedule.frequency ?? 'weekdays');
    setTime(subscription?.schedule.local_time ?? '09:00');
    setTimezone(subscription?.schedule.timezone ?? 'Asia/Shanghai');
    if (subscription) setStartDate(subscription.schedule.start_date);
    setScope(subscription?.query_spec.scope ?? 'own_expenses');
    setPeriod(subscription?.query_spec.period ?? 'this_month');
    const ref = subscription?.query_spec.resource_refs?.[0];
    setDocumentType(ref?.type ?? 'expense_claim');
    setDocumentId(ref?.id ?? '');
    setDocumentVersion(String(ref?.version ?? 1));
  };
  const saveSubscription = (event: FormEvent) => {
    event.preventDefault();
    void operation(async () => {
      const query_spec =
        type === 'todo_digest'
          ? { scope: 'current_approval_scope', include_existing_preaudit: true }
          : type === 'document_progress'
            ? {
                scope: 'documents',
                resource_refs: [
                  {
                    type: documentType,
                    id: documentId.trim(),
                    version: Number(documentVersion),
                  },
                ],
              }
            : { scope, period };
      const input = {
        type,
        title: title.trim(),
        schedule: {
          frequency,
          local_time: time,
          timezone,
          start_date: startDate,
        },
        query_spec,
        skill_version_id: subscriptionEdit?.skill_version_id ?? null,
        delivery: { channel: 'in_app' },
      };
      const response = await api<{ next_occurrences?: typeof preview }>(
        subscriptionEdit
          ? `/subscriptions/${subscriptionEdit.id}`
          : '/subscriptions',
        {
          method: subscriptionEdit ? 'PATCH' : 'POST',
          body: {
            ...input,
            ...(subscriptionEdit
              ? { expected_version: subscriptionEdit.version }
              : {}),
          },
        },
      );
      setPreview(response.next_occurrences ?? []);
      setSubscriptionEdit(undefined);
      setSuccess('只读日程已保存，结果会进入你的收件箱。');
    });
  };
  const changeSubscription = (
    subscription: Subscription,
    action: 'pause' | 'resume' | 'delete',
  ) =>
    void operation(async () => {
      await api(
        action === 'delete'
          ? `/subscriptions/${subscription.id}`
          : `/subscriptions/${subscription.id}/${action}`,
        {
          method: action === 'delete' ? 'DELETE' : 'POST',
          body: { expected_version: subscription.version },
        },
      );
      setSuccess(
        action === 'pause'
          ? '已暂停，后续不会投递新摘要。'
          : action === 'resume'
            ? '已恢复，将从下一次计划时间开始。'
            : '日程已删除，历史摘要仍可独立管理。',
      );
    });
  const openHistory = (subscription: Subscription) =>
    void operation(async () => {
      const response = await api<{ items: any[] }>(
        `/subscriptions/${subscription.id}/occurrences`,
      );
      setHistory({ subscription, items: response.items });
    });
  const openInbox = (item: Inbox) =>
    void operation(async () => {
      const opened = await api<{ thread_id: string }>(
        `/inbox/${item.id}/open`,
        { method: 'POST', body: { expected_version: item.version } },
      );
      const snapshot = await api<{
        messages: Array<{ id: string; content: string }>;
      }>(`/threads/${opened.thread_id}/snapshot`);
      setInboxDetail({
        item,
        thread_id: opened.thread_id,
        messages: snapshot.messages,
      });
    });
  const unread = inbox.filter((item) => item.unread).length;
  return (
    <div className="personal-page">
      <SectionTitle
        title="我的记忆与提醒"
        description="明确保存自己的偏好，安排只读摘要，随时查看或停止。"
        actions={
          <button disabled={loading || busy} onClick={() => void refresh()}>
            刷新
          </button>
        }
      />
      <nav className="personal-tabs" aria-label="个人设置">
        <button
          className={tab === 'memories' ? 'active' : ''}
          aria-current={tab === 'memories' ? 'page' : undefined}
          onClick={() => changeTab('memories')}
        >
          个人记忆
        </button>
        <button
          className={tab === 'subscriptions' ? 'active' : ''}
          aria-current={tab === 'subscriptions' ? 'page' : undefined}
          onClick={() => changeTab('subscriptions')}
        >
          摘要日程
        </button>
        <button
          className={tab === 'inbox' ? 'active' : ''}
          aria-current={tab === 'inbox' ? 'page' : undefined}
          onClick={() => changeTab('inbox')}
        >
          收件箱{unread > 0 && <span>{unread}</span>}
        </button>
      </nav>
      <ErrorNotice error={error} />
      {success && (
        <p className="personal-success" role="status">
          {success}
        </p>
      )}
      {loading ? (
        <p role="status" className="loading-line">
          正在读取个人设置…
        </p>
      ) : tab === 'memories' ? (
        <>
          <div className="personal-section-intro">
            <p>只在你明确保存后用于后续会话。审核阈值请到规则中心管理。</p>
            <button className="primary-button" onClick={() => editMemory(null)}>
              保存一条偏好
            </button>
          </div>
          {memories.length === 0 ? (
            <Empty>还没有保存的记忆。普通聊天不会自动成为跨会话记忆。</Empty>
          ) : (
            <div className="personal-records">
              {memories.map((memory) => (
                <article key={memory.id}>
                  <div>
                    <div className="personal-record-heading">
                      <strong>{memory.key}</strong>
                      <span>{memoryLabels[memory.kind]}</span>
                      <span>{stateLabels[memory.status] ?? memory.status}</span>
                    </div>
                    <p>{memory.content ?? '记忆内容已删除。'}</p>
                    <small>
                      {memory.source.kind === 'manual'
                        ? '手工保存'
                        : '来自明确保存消息'}{' '}
                      ·{' '}
                      {memory.expires_at
                        ? `有效至 ${new Date(memory.expires_at).toLocaleString('zh-CN')}`
                        : '持续有效，直到你删除'}{' '}
                      · v{memory.version}
                    </small>
                  </div>
                  <div className="button-row">
                    {memory.status === 'active' ? (
                      <>
                        <button onClick={() => editMemory(memory)}>编辑</button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void operation(async () => {
                              await api(`/memories/${memory.id}`, {
                                method: 'DELETE',
                                body: { expected_version: memory.version },
                              });
                              setSuccess(
                                '记忆已删除，后续上下文立即停止使用。',
                              );
                            })
                          }
                        >
                          删除记忆
                        </button>
                      </>
                    ) : (
                      <button
                        disabled={busy || memory.status === 'expired'}
                        onClick={() =>
                          void operation(async () => {
                            await api(`/memories/${memory.id}/restore`, {
                              method: 'POST',
                              body: {
                                expected_version: memory.version,
                                revision_to_restore: 1,
                              },
                            });
                            setSuccess('已重新核实来源并恢复为新的记忆版本。');
                          })
                        }
                      >
                        恢复最初版本
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : tab === 'subscriptions' ? (
        <>
          <div className="personal-section-intro">
            <p>
              摘要只读，不会替你审批。工作日按周一至周五，不推断法定节假日。
            </p>
            <button
              className="primary-button"
              onClick={() => editSubscription(null)}
            >
              创建只读日程
            </button>
          </div>
          {preview.length > 0 && (
            <section className="schedule-preview" aria-label="未来三次计划">
              <h3>接下来的计划时间</h3>
              <ol>
                {preview.map((item) => (
                  <li key={item.scheduled_at}>
                    {item.local_date} {item.local_time} · {item.timezone}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {subscriptions.length === 0 ? (
            <Empty>还没有启用的摘要日程。</Empty>
          ) : (
            <div className="personal-records">
              {subscriptions.map((subscription) => (
                <article key={subscription.id}>
                  <div>
                    <div className="personal-record-heading">
                      <strong>{subscription.title}</strong>
                      <span>
                        {stateLabels[subscription.status] ??
                          subscription.status}
                      </span>
                    </div>
                    <p>
                      {subscription.schedule.frequency === 'weekdays'
                        ? '周一至周五'
                        : '每天'}{' '}
                      {subscription.schedule.local_time} ·{' '}
                      {subscription.schedule.timezone}
                    </p>
                    <small>
                      下一次{' '}
                      {new Date(subscription.next_run_at).toLocaleString(
                        'zh-CN',
                        { timeZone: subscription.schedule.timezone },
                      )}{' '}
                      · 仅投递到本人收件箱
                    </small>
                    {subscription.error_code && (
                      <p className="personal-blocked">
                        读取权限或配置已变化，请核实范围后恢复。
                      </p>
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      disabled={busy}
                      onClick={() => editSubscription(subscription)}
                    >
                      编辑
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => openHistory(subscription)}
                    >
                      执行记录
                    </button>
                    {subscription.status === 'active' ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          changeSubscription(subscription, 'pause')
                        }
                      >
                        暂停
                      </button>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() =>
                          changeSubscription(subscription, 'resume')
                        }
                      >
                        核实并恢复
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => changeSubscription(subscription, 'delete')}
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="personal-section-intro">
            <p>
              {unread ? `${unread} 条未读` : '当前没有未读摘要'}
              。打开后查看当时快照，办理业务时仍读取最新数据。
            </p>
          </div>
          {inbox.length === 0 ? (
            <Empty>收件箱还是空的。已启用日程的摘要会显示在这里。</Empty>
          ) : (
            <div className="personal-records inbox-records">
              {inbox.map((item) => (
                <article key={item.id}>
                  <div>
                    <div className="personal-record-heading">
                      <strong>{item.title}</strong>
                      {item.unread && (
                        <span className="unread-label">未读</span>
                      )}
                    </div>
                    <p>{item.preview}</p>
                    <small>
                      {new Date(item.created_at).toLocaleString('zh-CN')} ·
                      摘要修订 {item.revision}
                    </small>
                  </div>
                  <div className="button-row">
                    <button disabled={busy} onClick={() => openInbox(item)}>
                      查看摘要
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void operation(async () => {
                          await api(`/inbox/${item.id}`, {
                            method: 'DELETE',
                            body: { expected_version: item.version },
                          });
                          setSuccess('已从个人收件箱删除。');
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {memoryEdit !== undefined && (
        <Drawer
          title={memoryEdit ? '编辑个人记忆' : '保存个人偏好'}
          subtitle="仅你可见，不改变业务权限或审单规则"
          dirty={!!memoryContent.trim()}
          onClose={() => setMemoryEdit(undefined)}
        >
          <form className="personal-editor" onSubmit={saveMemory}>
            <Field label="用途">
              <select
                value={memoryKind}
                onChange={(event) => setMemoryKind(event.target.value)}
              >
                {Object.entries(memoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="偏好名称" hint="例如：报告表达顺序">
              <input
                required
                maxLength={100}
                value={memoryKey}
                onChange={(event) => setMemoryKey(event.target.value)}
              />
            </Field>
            <Field label="要记住的内容">
              <textarea
                required
                maxLength={2000}
                value={memoryContent}
                onChange={(event) => setMemoryContent(event.target.value)}
                rows={5}
              />
            </Field>
            <Field label="有效期" hint="留空表示持续有效，直到你删除">
              <input
                type="datetime-local"
                value={memoryExpiry}
                onChange={(event) => setMemoryExpiry(event.target.value)}
              />
            </Field>
            <ErrorNotice error={error} />
            <div className="editor-actions">
              <button type="button" onClick={() => setMemoryEdit(undefined)}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || !memoryKey.trim() || !memoryContent.trim()}
              >
                {busy ? '正在保存…' : '明确保存偏好'}
              </button>
            </div>
          </form>
        </Drawer>
      )}
      {subscriptionEdit !== undefined && (
        <Drawer
          title={subscriptionEdit ? '编辑只读日程' : '创建只读摘要'}
          subtitle="读取范围由当前权限与订阅授权共同限制"
          dirty
          onClose={() => setSubscriptionEdit(undefined)}
        >
          <form className="personal-editor" onSubmit={saveSubscription}>
            <Field label="日程名称">
              <input
                required
                maxLength={60}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="摘要内容">
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                {me.actor.permissions.includes('approval.decide') && (
                  <option value="todo_digest">当前待我审批的只读摘要</option>
                )}
                {me.actor.permissions.includes('analytics.query') && (
                  <option value="expense_digest">费用分析摘要</option>
                )}
                <option value="document_progress">指定申请的审批进度</option>
              </select>
            </Field>
            {type === 'expense_digest' && (
              <>
                <Field label="读取范围">
                  <select
                    value={scope}
                    onChange={(event) => setScope(event.target.value)}
                  >
                    <option value="own_expenses">本人费用</option>
                    {me.actor.permissions.includes(
                      'expense.read.department',
                    ) && (
                      <option value="authorized_department_expenses">
                        明确授权部门
                      </option>
                    )}
                  </select>
                </Field>
                <Field label="统计区间">
                  <select
                    value={period}
                    onChange={(event) => setPeriod(event.target.value)}
                  >
                    <option value="this_month">本月</option>
                    <option value="last_month">上月</option>
                  </select>
                </Field>
              </>
            )}
            {type === 'document_progress' && (
              <>
                <Field label="单据类型">
                  <select
                    value={documentType}
                    onChange={(event) => setDocumentType(event.target.value)}
                  >
                    <option value="expense_claim">报销单</option>
                    <option value="travel">差旅申请</option>
                    <option value="oa_request">前置申请</option>
                  </select>
                </Field>
                <Field label="明确单据编号">
                  <input
                    required
                    value={documentId}
                    onChange={(event) => setDocumentId(event.target.value)}
                  />
                </Field>
                <Field label="当前版本">
                  <input
                    type="number"
                    min="1"
                    required
                    value={documentVersion}
                    onChange={(event) => setDocumentVersion(event.target.value)}
                  />
                </Field>
              </>
            )}
            <div className="personal-form-pair">
              <Field label="频率">
                <select
                  value={frequency}
                  onChange={(event) => setFrequency(event.target.value)}
                >
                  <option value="weekdays">工作日（周一至周五）</option>
                  <option value="daily">每天</option>
                </select>
              </Field>
              <Field label="当地时间">
                <input
                  type="time"
                  required
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                />
              </Field>
            </div>
            <Field label="时区">
              <input
                required
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                list="digest-timezones"
              />
              <datalist id="digest-timezones">
                <option value="Asia/Shanghai" />
                <option value="Asia/Hong_Kong" />
                <option value="America/New_York" />
              </datalist>
            </Field>
            <Field label="开始日期">
              <input
                required
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
              />
            </Field>
            <p className="muted">
              结果仅进入你的站内收件箱。不会创建隐藏聊天，也不会自动审批或发送到外部。
            </p>
            <ErrorNotice error={error} />
            <div className="editor-actions">
              <button
                type="button"
                onClick={() => setSubscriptionEdit(undefined)}
              >
                取消
              </button>
              <button
                disabled={busy || !title.trim()}
                className="primary-button"
              >
                {busy ? '正在保存…' : '启用只读日程'}
              </button>
            </div>
          </form>
        </Drawer>
      )}
      {history && (
        <Drawer
          title={`${history.subscription.title} · 执行记录`}
          onClose={() => setHistory(null)}
        >
          {history.items.length === 0 ? (
            <Empty>尚无计划发生记录。</Empty>
          ) : (
            <div className="occurrence-list">
              {history.items.map((item) => (
                <article key={item.id}>
                  <strong>
                    {new Date(item.scheduled_at).toLocaleString('zh-CN', {
                      timeZone: history.subscription.schedule.timezone,
                    })}
                  </strong>
                  <p>{stateLabels[item.status] ?? item.status}</p>
                  {item.dst_adjusted && (
                    <small>已顺延到当日第一个有效时刻。</small>
                  )}
                  {item.status === 'failed' && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void operation(async () => {
                          await api(
                            `/subscriptions/${history.subscription.id}/occurrences/${item.id}/retry`,
                            {
                              method: 'POST',
                              body: { expected_version: item.version },
                            },
                          );
                          const response = await api<{ items: any[] }>(
                            `/subscriptions/${history.subscription.id}/occurrences`,
                          );
                          setHistory({ ...history, items: response.items });
                        })
                      }
                    >
                      重试同一条摘要
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
          <ErrorNotice error={error} />
        </Drawer>
      )}
      {inboxDetail && (
        <Drawer
          title={inboxDetail.item.title}
          subtitle={`快照生成于 ${new Date(inboxDetail.item.created_at).toLocaleString('zh-CN')}`}
          onClose={() => setInboxDetail(null)}
        >
          {inboxDetail.messages.map((message) => (
            <p className="inbox-body" key={message.id}>
              {message.content}
            </p>
          ))}
          <p className="muted">
            此摘要只读。继续处理时，系统会重新核对权限和对象版本。
          </p>
          <a
            className="primary-button personal-open-link"
            href={`?page=assistant&thread=${encodeURIComponent(inboxDetail.thread_id)}`}
          >
            进入会话继续处理
          </a>
        </Drawer>
      )}
    </div>
  );
}
function historyPush(url: URL) {
  window.history.pushState(null, '', url);
}
