import { MessageText } from './MessageText';
import { useEffect, useRef, useState } from 'react';
import type { ContextRef, ResultCard, Task } from './workspace';
import { useWorkspace } from './workspace';
import { Badge, Icon, Button } from './ui';
import { DocumentResults, materialBatchId } from './Documents';
import { AnalysisCard } from './AnalyticsSkills';
import { currentCard } from './card-model';
import { getAuditSummary } from './RulesSubmission';
import {
  capabilities,
  capabilityExamples,
  getCapability,
  type CapabilityId,
} from './capability-model';
import { ComposerSkillPicker } from './Skills';
import { SubmissionCard } from './SubmissionCard';
import {
  latestSubmissionCards,
  visibleMessageCards,
} from './submission-conversation';
import { QuestionCard } from './QuestionCard';
import { pendingQuestion, resumeQuestionMessage } from './question-model';
import { RunProgress } from './RunProgress';

export const logo = '/agent-assets/caixiaozhi.png';
function XiaozhiMark({ className = '' }: { className?: string }) {
  return (
    <span className={`xiaozhi-mark ${className}`} aria-hidden="true">
      <img src={logo} alt="" draggable={false} />
    </span>
  );
}

function CapabilityControl({
  value,
  onChange,
  more = false,
}: {
  value: CapabilityId | null;
  onChange: (value: CapabilityId | null) => void;
  more?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState('');
  const wrap = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null);
  const selected = getCapability(value);
  const items = capabilities.filter(
    (item) =>
      (!more || !item.featured) &&
      `${item.label} ${item.description}`.includes(query.trim()),
  );
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div
      className="composer-capability"
      ref={wrap}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !wrap.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <div
        className={`composer-capability-control ${selected ? 'selected' : ''}`}
      >
        <button
          type="button"
          ref={trigger}
          className={more ? 'composer-quick-action' : 'composer-tool'}
          aria-label={
            more
              ? '更多能力'
              : selected
                ? `切换能力，当前为${selected.label}`
                : '选择能力'
          }
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? 'capability-menu' : undefined}
          onClick={() => {
            setQuery('');
            setOpen((current) => !current);
          }}
        >
          <Icon name={selected?.icon ?? 'grid'} size={15} />
          <span>{selected?.label ?? (more ? '更多能力' : '选择能力')}</span>
          <Icon name="down" size={12} />
        </button>
        {selected && (
          <button
            type="button"
            className="composer-skill-clear"
            aria-label={`退出${selected.label}`}
            title="退出当前能力"
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {open && (
        <div
          className="shortcut-menu capability-menu"
          id="capability-menu"
          role="dialog"
          aria-label={more ? '更多能力' : '选择能力'}
        >
          <input
            ref={search}
            aria-label="搜索能力"
            placeholder="搜索能力"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="capability-list">
            {items.map((item) => (
              <button
                type="button"
                className="capability-option"
                key={item.id}
                aria-pressed={item.id === value}
                onClick={() => {
                  setOpen(false);
                  onChange(item.id);
                }}
              >
                <Icon name={item.icon} size={17} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {item.id === value && <Icon name="check" size={15} />}
              </button>
            ))}
            {!items.length && <p className="shortcut-empty">未找到相关能力</p>}
          </div>
        </div>
      )}
    </div>
  );
}
function QuickActions({
  onSelect,
}: {
  onSelect: (value: CapabilityId | null) => void;
}) {
  return (
    <div
      className="composer-quick-actions"
      role="group"
      aria-label="选择办理能力"
    >
      {capabilities
        .filter((item) => item.featured)
        .map((shortcut) => (
          <button
            type="button"
            className="composer-quick-action"
            key={shortcut.id}
            title={shortcut.description}
            onClick={() => onSelect(shortcut.id)}
          >
            <Icon name={shortcut.icon} size={15} />
            <span>{shortcut.label}</span>
          </button>
        ))}
      <CapabilityControl value={null} onChange={onSelect} more />
    </div>
  );
}
export function Composer({
  value,
  onChange,
  onSend,
  refs,
  onAdd,
  onRemove,
  busy,
  onStop,
  onUpload,
  compact = false,
  capability,
  onCapabilityChange,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  refs: ContextRef[];
  onAdd: (ref: ContextRef) => void;
  onRemove: (ref: ContextRef) => void;
  busy: boolean;
  onStop: () => void;
  onUpload: (files: FileList) => void;
  compact?: boolean;
  capability: CapabilityId | null;
  onCapabilityChange: (value: CapabilityId | null) => void;
}) {
  const workspace = useWorkspace();
  const input = useRef<HTMLInputElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    skills = useRef<HTMLDivElement>(null),
    skillButton = useRef<HTMLButtonElement>(null),
    skillSearch = useRef<HTMLInputElement>(null),
    [openMenu, setOpenMenu] = useState<'skills' | null>(null);
  const selectedSkills = refs.filter((ref) => ref.kind === 'skill');
  const materialRefs = refs.filter((ref) => ref.kind !== 'skill');
  const skillLabel =
    selectedSkills.length === 1
      ? selectedSkills[0]!.title
      : selectedSkills.length > 1
        ? `技能 · ${selectedSkills.length}`
        : '选择技能';
  useEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 220)}px`;
      field.style.overflowY = field.scrollHeight > 220 ? 'auto' : 'hidden';
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [value]);
  useEffect(() => {
    if (!openMenu) return;
    skillSearch.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !skills.current?.contains(event.target)
      ) {
        setOpenMenu(null);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpenMenu(null);
      skillButton.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [openMenu]);
  return (
    <div className={`composer ${compact ? 'composer-compact' : ''}`}>
      <div className="refs">
        {materialRefs.map((ref) => (
          <span className="ref-chip" key={`${ref.kind}/${ref.id}`}>
            <Icon name={ref.kind === 'file' ? 'attach' : 'link'} size={13} />
            <span>
              {ref.title}
              {ref.version ? ` · ${ref.version}` : ''}
            </span>
            <button
              aria-label={`移除${ref.title}`}
              onClick={() => onRemove(ref)}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      <label className="sr-only" htmlFor="message-input">
        给财小智发送消息
      </label>
      <textarea
        ref={textarea}
        id="message-input"
        rows={2}
        placeholder={
          getCapability(capability)?.placeholder ??
          (compact ? '继续补充需求…' : '交给财小智，从一件事开始…')
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (value.trim() && !busy) onSend();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            className="composer-tool"
            onClick={() => input.current?.click()}
            aria-label="上传文件"
          >
            <Icon name="attach" size={15} />
            <span>上传文件</span>
          </button>
          <div
            className="composer-skills"
            ref={skills}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                !skills.current?.contains(event.relatedTarget)
              )
                setOpenMenu((current) =>
                  current === 'skills' ? null : current,
                );
            }}
          >
            <div
              className={`composer-skill-control ${selectedSkills.length ? 'selected' : ''}`}
            >
              <button
                ref={skillButton}
                className="composer-tool"
                aria-label={
                  selectedSkills.length
                    ? `选择技能，已选${selectedSkills.length}项：${selectedSkills.map((ref) => ref.title).join('、')}`
                    : '选择技能'
                }
                title={
                  selectedSkills.length
                    ? selectedSkills.map((ref) => ref.title).join('、')
                    : undefined
                }
                aria-haspopup="dialog"
                aria-expanded={openMenu === 'skills'}
                aria-controls={
                  openMenu === 'skills' ? 'composer-skill-menu' : undefined
                }
                onClick={() =>
                  setOpenMenu((current) =>
                    current === 'skills' ? null : 'skills',
                  )
                }
              >
                <Icon name="spark" size={15} />
                <span className="composer-skill-label">{skillLabel}</span>
                <Icon name="down" size={12} />
              </button>
              {selectedSkills.length > 0 && (
                <button
                  className="composer-skill-clear"
                  aria-label="清除已选技能"
                  title="清除已选技能"
                  onClick={() => {
                    selectedSkills.forEach(onRemove);
                    setOpenMenu(null);
                    skillButton.current?.focus();
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
            {openMenu === 'skills' && (
              <div
                className="shortcut-menu composer-skill-menu"
                id="composer-skill-menu"
                role="dialog"
                aria-label="选择技能"
              >
                <ComposerSkillPicker
                  selected={selectedSkills}
                  searchRef={skillSearch}
                  onToggle={(ref) =>
                    selectedSkills.some((item) => item.id === ref.id)
                      ? onRemove(ref)
                      : onAdd(ref)
                  }
                />
              </div>
            )}
          </div>
          {(capability || compact) && (
            <CapabilityControl
              value={capability}
              onChange={onCapabilityChange}
            />
          )}
          {capability === 'translation' && (
            <button
              className="composer-tool"
              onClick={() =>
                workspace.openPanel({
                  kind: 'translation',
                  title: '附件翻译',
                  id: materialRefs.find((ref) => ref.kind === 'file')?.id,
                  data: {
                    fileIds: materialRefs
                      .filter((ref) => ref.kind === 'file')
                      .map((ref) => ref.id),
                  },
                })
              }
            >
              <Icon name="layout" size={15} />
              <span>翻译窗口</span>
            </button>
          )}
        </div>
        <div className="inline-actions">
          <span className="composer-hint">Enter 发送</span>
          {busy ? (
            <button
              className="send-button"
              aria-label="停止当前任务"
              onClick={onStop}
            >
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="发送消息"
              disabled={!value.trim()}
              onClick={onSend}
            >
              <Icon name="up" size={18} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) onUpload(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
export function Result({
  card,
  latest = true,
}: {
  card: ResultCard;
  latest?: boolean;
}) {
  const w = useWorkspace();
  if (card.kind === 'submission')
    return <SubmissionCard card={card} latest={latest} />;
  card = currentCard(card, w.state.data);
  if (card.kind === 'documents')
    return (
      <DocumentResults
        limit={3}
        query={card.data?.query}
        documentId={card.data?.ref}
        documents={card.data?.items}
      />
    );
  if (card.kind === 'analysis')
    return <AnalysisCard scope={card.data?.scope} />;
  if (card.kind === 'clarify')
    return (
      <div className="clarify-options">
        {(card.data?.options ?? ['费用报销', '差旅申请', '查单据进展']).map(
          (option: string) => (
            <Button
              key={option}
              disabled={!latest}
              onClick={() => w.send(option)}
            >
              {option}
            </Button>
          ),
        )}
      </div>
    );
  const icon =
    (
      {
        materials: 'attach',
        submission: 'file',
        audit: 'shield',
        rule: 'shield',
        rules: 'shield',
        report: 'chart',
        tool: 'chart',
        skill: 'spark',
        knowledge: 'book',
        document: 'file',
      } as Record<string, string>
    )[card.kind] ?? 'file';
  return (
    <button
      className="result-card"
      onClick={() =>
        card.kind === 'rules'
          ? w.navigate('rules')
          : w.openPanel({
              kind: card.kind,
              title: card.title,
              id: card.id,
              data: card.data,
            })
      }
    >
      <span className="result-icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="result-text">
        <span className="result-title">
          <strong>{card.title}</strong>
          {card.status && (
            <Badge tone={card.tone ?? 'blue'}>{card.status}</Badge>
          )}
        </span>
        {card.subtitle && (
          <span className="result-subtitle">{card.subtitle}</span>
        )}
      </span>
      <Icon name="chevron" size={16} className="result-arrow" />
    </button>
  );
}
export function ChatPage({
  task,
  composer,
  busy,
  activity,
  phase,
  onRename,
}: {
  task: Task;
  composer: React.ReactNode;
  busy: boolean;
  activity?: string;
  phase?: string;
  onRename: () => void;
}) {
  const w = useWorkspace(),
    scroll = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const scrollToLatest = () => {
    followLatest.current = true;
    setShowLatest(false);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };

  useEffect(() => {
    scrollToLatest();
  }, [task.id]);

  useEffect(() => {
    if (followLatest.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [task.messages, busy, activity, phase]);

  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current && scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);

  const last = task.messages.filter((m) => m.role === 'assistant').at(-1);
  const isRunningMessage = (message: Task['messages'][number]) =>
    busy &&
    message.role === 'assistant' &&
    Boolean(task.activeRunId) &&
    (message.runId === task.activeRunId ||
      message.id === task.activeRunId ||
      message.id === `assistant-${task.activeRunId}`);
  const hasRunningMessage = task.messages.some(isRunningMessage);
  const latestSubmissions = latestSubmissionCards(task);
  const pending = pendingQuestion(task);
  const canResume =
    !busy &&
    !pending &&
    (/暂停|未完成|失败|中断|异常/.test(task.status) ||
      ['failed', 'interrupted', 'cancelled'].includes(last?.runStatus ?? ''));
  const kind = last ? visibleMessageCards(last)[0]?.card.kind : undefined;
  const suggestions =
    kind === 'analysis'
      ? ['只看销售部', '换成9月', '生成报告']
      : kind === 'documents'
        ? ['查看OA单据', '查看采购付款']
        : kind === 'materials'
          ? ['生成报销草稿', '查看我的单据']
          : kind === 'audit'
            ? ['查看规则中心', '只看需要关注的单据']
            : kind === 'knowledge'
              ? ['查看差旅申请', '查询我的单据进展']
              : [];
  return (
    <div className="chat-page">
      <div className="chat-titlebar">
        <h1>{task.title}</h1>
        <div className="inline-actions">
          {!busy && (
            <Badge
              tone={
                task.status.includes('补充') ||
                task.status.includes('核对') ||
                task.status === '待你回答'
                  ? 'amber'
                  : 'blue'
              }
            >
              {task.status}
            </Badge>
          )}
          <button
            className="icon-btn"
            aria-label="重命名会话"
            onClick={onRename}
          >
            <Icon name="edit" size={16} />
          </button>
        </div>
      </div>
      <div
        className="chat-thread"
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            72;
          followLatest.current = nearBottom;
          setShowLatest(!nearBottom);
        }}
      >
        <div className="chat-thread-content" ref={content}>
          {!task.messages.length && !busy && (
            <div className="chat-empty-brand">
              <XiaozhiMark className="empty-chat-mark" />
              <p>从这里继续对话</p>
            </div>
          )}
          {task.messages.map((message) => {
            const visibleCards = visibleMessageCards(message);
            const messageRunning = isRunningMessage(message);
            const latestStatus =
              message.id === last?.id && !busy
                ? pending
                  ? 'awaiting_input'
                  : task.status === '已暂停'
                    ? 'paused'
                    : /未完成|失败|中断|异常/.test(task.status)
                      ? 'failed'
                      : undefined
                : undefined;
            if (
              message.role === 'assistant' &&
              message.submissionPhase === 'collecting' &&
              !message.text.trim() &&
              !message.question &&
              !visibleCards.length &&
              !message.tools?.length &&
              !messageRunning
            )
              return null;
            return (
              <article className={`message ${message.role}`} key={message.id}>
                {message.role === 'user' ? (
                  <div className="user-bubble">{message.text}</div>
                ) : (
                  <div>
                    <div className="assistant-name">
                      <XiaozhiMark className="reply-mark" />
                      <span>财小智</span>
                    </div>
                    <RunProgress
                      steps={message.tools}
                      running={messageRunning}
                      status={latestStatus ?? message.runStatus}
                      activity={messageRunning ? activity : undefined}
                      phase={messageRunning ? phase : undefined}
                    />
                    {message.text.trim() &&
                      (!message.question ||
                        message.text !== message.question.title) && (
                        <MessageText text={message.text} />
                      )}
                    {message.question && (
                      <QuestionCard
                        question={message.question}
                        active={pending?.id === message.question.id}
                        busy={busy}
                      />
                    )}
                    {visibleCards.length > 0 && (
                      <div className="message-cards">
                        {visibleCards.map(({ card, index }) => (
                          <Result
                            card={card}
                            latest={
                              card.kind === 'clarify'
                                ? message.id === last?.id && !pending && !busy
                                : card.kind !== 'submission' ||
                                  latestSubmissions.has(
                                    `${message.id}:${index}`,
                                  )
                            }
                            key={`${card.kind}-${index}`}
                          />
                        ))}
                      </div>
                    )}
                    {message.text.trim() && (
                      <div className="message-tools">
                        <button
                          className="icon-btn"
                          title="复制回复"
                          aria-label="复制回复"
                          onClick={() => {
                            navigator.clipboard?.writeText(message.text).then(
                              () => w.notify('已复制回复'),
                              () => w.notify('复制失败，请选择文字复制'),
                            );
                          }}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {busy && !hasRunningMessage && (
            <article className="message assistant">
              <div className="assistant-name">
                <XiaozhiMark className="reply-mark" />
                <span>财小智</span>
              </div>
              <RunProgress running activity={activity} phase={phase} />
            </article>
          )}
          {canResume && (
            <div className="chat-resume-action">
              <Button
                variant="primary"
                icon="refresh"
                onClick={() =>
                  w.send(
                    task.status === '已暂停'
                      ? resumeQuestionMessage(task)
                      : '继续处理当前事项，保留已保存的草稿和成果，先核对当前办理状态，再继续尚未完成的步骤，不要重复提交已提交的单据。',
                  )
                }
              >
                继续处理
              </Button>
            </div>
          )}
          {!busy && !pending && !canResume && suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((s) => (
                <button onClick={() => w.send(s)} key={s}>
                  {s}
                  <Icon name="chevron" size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {showLatest && (
        <div className="chat-latest">
          <button
            type="button"
            className="chat-latest-button"
            onClick={scrollToLatest}
          >
            <Icon name="down" size={13} />
            回到最新
          </button>
        </div>
      )}
      <div className="chat-compose">{composer}</div>
    </div>
  );
}
export function AttentionRows({
  tasks,
  onTask,
}: {
  tasks: Task[];
  onTask: (id: string) => void;
}) {
  const w = useWorkspace();
  return (
    <div className="attention-rows">
      {tasks.map((task) => {
        const latest = task.messages
          .filter((message) => message.role === 'assistant')
          .at(-1);
        const card = latest?.cards?.at(-1);
        const knownMaterial =
          card?.kind === 'materials' && card.id === materialBatchId;
        const knownAudit = card?.kind === 'audit' && card.id === 'batch';
        const knownSubmission =
          card?.kind === 'submission' &&
          !!(card.id && w.state.data.submissions?.drafts?.[card.id]);
        const canOpenDetail = knownMaterial || knownAudit || knownSubmission;
        const summary =
          card && canOpenDetail
            ? knownAudit
              ? getAuditSummary(w.state.data)
              : currentCard(card, w.state.data)
            : card;
        const paused = task.status.includes('暂停');
        const action =
          paused || !canOpenDetail
            ? '继续处理'
            : knownMaterial
              ? summary?.data?.pending
                ? `核对${summary.data.pending}项信息`
                : '查看费用'
              : knownAudit
                ? '审阅单据'
                : task.status.includes('确认')
                  ? '核对草稿'
                  : '补充信息';
        return (
          <button
            className="attention-row"
            key={task.id}
            onClick={() => {
              onTask(task.id);
              if (card && canOpenDetail && !paused) {
                w.openPanel({
                  kind: card.kind,
                  id: card.id,
                  title: card.title,
                  data: card.data,
                });
              }
            }}
          >
            <span
              className={`row-icon ${task.type === 'audit' ? 'purple' : 'amber'}`}
            >
              <Icon
                name={
                  task.type === 'audit'
                    ? 'shield'
                    : task.type === 'materials'
                      ? 'attach'
                      : 'tasks'
                }
                size={18}
              />
            </span>
            <span className="row-text">
              <strong>{task.title}</strong>
              <small>
                {summary?.subtitle ||
                  latest?.text ||
                  task.input ||
                  task.updated}
              </small>
            </span>
            <span className="attention-row-end">
              <Badge tone="amber">
                {knownAudit && summary?.data?.stale
                  ? `${task.status} · 需重审`
                  : task.status}
              </Badge>
              <span className="row-action">
                {action}
                <Icon name="chevron" size={14} />
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
export function Home({
  composer,
  onPrepare,
  capability,
  onCapabilityChange,
}: {
  composer: React.ReactNode;
  onPrepare: (text: string) => void;
  capability: CapabilityId | null;
  onCapabilityChange: (value: CapabilityId | null) => void;
}) {
  const [examples, setExamples] = useState(() =>
    capabilityExamples(capability),
  );
  useEffect(() => setExamples(capabilityExamples(capability)), [capability]);
  return (
    <div className="workspace-home">
      <div className="home-intro">
        <div className="home-greeting">
          <XiaozhiMark className="home-brand-mark" />
          <h1>吴侠，今天想完成什么财务工作？</h1>
        </div>
      </div>
      {composer}
      <div className="home-below">
        {!capability && <QuickActions onSelect={onCapabilityChange} />}
        <section className="home-examples" aria-label="需求示例">
          <div className="home-examples-header">
            <h2>{getCapability(capability)?.label ?? '从这些事开始'}</h2>
            <button
              className="btn ghost"
              onClick={() =>
                setExamples((current) =>
                  capabilityExamples(capability, current),
                )
              }
            >
              <Icon name="refresh" size={13} />
              <span>换一组</span>
            </button>
          </div>
          <div className="home-example-list">
            {examples.map((text) => (
              <button
                className="home-example"
                key={text}
                onClick={() => onPrepare(text)}
              >
                <Icon name="chat" size={15} />
                <span>{text}</span>
                <Icon name="arrow" size={14} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
