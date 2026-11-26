import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from 'react';
import {
  api as runtimeApi,
  acceptWorkspace,
  flushWorkspace,
  readWorkspace,
  saveWorkspace,
  subscribeWorkspace,
  subscribeRuntimeStatus,
  uploadFile,
  workspacePatch,
  type RuntimeStatus,
  type WorkspaceSnapshot,
} from './runtime-client';
import './runtime.css';
import {
  rememberComposerDraft,
  readComposerDraft,
  forgetComposerDraft,
} from './composer-draft';
import {
  createRunStream,
  mergeRunMessages,
  reduceRunEvent,
  type RunStream,
} from './run-progress-model';
import { isReimbursementPanel } from './reimbursement-batch';
import { boardReference } from './business-board-handoff';
import type { BusinessBoardSnapshot } from './business-board-model';
import { BusinessAnalysisCard, BusinessReportPanel } from './BusinessAnalysisResults';
import { ContextHelp } from './ContextHelp';
import { PublicFinancialsPanel, PublicFinancialReportPanel } from './PublicFinancials';
import {
  readSkillDraftTarget,
  saveSkillDraftTarget,
  selectSkillDraft,
} from './skill-selection';
import {
  WorkspaceContext,
  type WorkspaceState,
  type WorkspaceAPI,
  type Task,
  type ResultCard,
  type PageId,
  type PanelSpec,
  type ContextRef,
} from './workspace';
import { Icon, Button, Badge, Empty } from './ui';
import { syncTaskStates } from './card-model';
import { appendDraft, selectHomeTasks } from './task-model';
import {
  pendingQuestion,
  questionState,
  prepareQuestionAnswer,
  continuedQuestionPanel,
  continuationDraftId,
  type QuestionAnswerInput,
} from './question-model';
import {
  recentConversationAlert,
  formatConversationTime,
  lastMessageTime,
  recentConversations,
} from './conversation-model';
import { useConversationReads } from './conversation-reads';
import { NotificationCenter } from './NotificationCenter';
import { useWorkspaceNotifications, type WorkspaceNotification } from './notification-center-model';
import {
  expertTeamRefs, getCapability, isExpertTeam, prepareExpertTeamDraft,
  type CapabilityId, type ExpertTeamId,
} from './capability-model';
import { SkillPickerPanel } from './Skills';
import { CapabilityCenter } from './CapabilityCenter';
import { CatalogHeading } from './CatalogHeading';
import { catalogArea } from './skills-catalog-model';
import { ConversationHistory } from './ConversationHistory';
import { ScheduledTasksPage } from './ScheduledTasks';
import { TranslationPanel } from './TranslationPanel';
import { SkillArtifactPanel } from './SkillArtifactPanel';
import { Composer, Home, ChatPage } from './Chat';
import { QuestionComposer, clearQuestionResponse } from './QuestionComposer';
import { RulesPage, RulesPanel } from './RulesSubmission';
import { AuditPanel } from './WorkInbox';
import { findWorkDocument, workDocumentTitle, type WorkDocument } from './work-document-model';
import { WorkDocumentIcon } from './WorkDocumentIcon';
import { SubmissionPage, SubmissionPanel } from './SubmissionWorkspace';
import {
  DocumentsPage,
  FilesPage,
  DocumentPanel,
  DocumentPanelActions,
  useDocumentPanelLookup,
  MaterialsPanel,
} from './Documents';
import {
  AnalysisPage,
  SkillsPage,
  AnalysisPanel,
  ReportPanel,
  SkillPanel,
  GovernancePanel,
} from './AnalyticsSkills';
import {
  apps,
  workspaceApps,
  frequentAppStorageKey,
  readFrequentApps,
  KnowledgePage,
  KnowledgePanel,
  AppsPanel,
  ContextPanel,
  HelpPanel,
  PreferencesPanel,
  RenamePanel,
} from './Supporting';

const uid = () => crypto.randomUUID();
const initial: WorkspaceState = { data: {}, tasks: [], activeTask: null };
function BrandWordmark() {
  return (
    <img
      className="brand-wordmark"
      src="/agent-assets/caixiaozhi-wordmark.svg"
      alt="财小智"
      width={108}
      height={28}
      draggable={false}
    />
  );
}

function homeDraft(): {
  input?: string;
  refs?: ContextRef[];
  capability?: CapabilityId | null;
  expertTeamName?: string | null;
} {
  try {
    return JSON.parse(
      sessionStorage.getItem('cx.agent.local.homeDraft') ?? '{}',
    );
  } catch {
    return {};
  }
}
const pageTitles: Record<PageId, string> = {
  home: '新会话',
  chat: '会话',
  history: '全部对话',
  documents: '单据进展',
  submission: '智能提单',
  rules: '规则中心',
  analysis: '数据分析',
  skills: '能力中心',
  'light-apps': '轻应用',
  todos: '我的工作',
  schedules: '自动化',
  knowledge: '制度知识',
  files: '材料与文件',
};
type Mode = 'assistant' | 'operations';
function readMode(): Mode {
  return new URLSearchParams(location.search).get('mode') === 'operations'
    ? 'operations'
    : 'assistant';
}
function readPage(): PageId {
  const area = catalogArea(location.hash);
  if (area) return area;
  const p = location.hash.slice(1).split('?')[0] as PageId;
  return Object.hasOwn(pageTitles, p) ? p : 'home';
}
function makeTask(title = '新会话'): Task {
  return {
    id: uid(),
    title,
    status: '待开始',
    type: 'chat',
    messages: [],
    input: '',
    refs: [],
    updated: '刚刚',
  };
}
interface SendAttempt {
  text: string;
  refs: ContextRef[];
  capability?: CapabilityId | null;
}

interface RunFailure {
  message: string;
  retry?: SendAttempt;
}

export default function App() {
  const [savedState, setSavedState] = useState<WorkspaceState>(initial),
    [ready, setReady] = useState(false),
    [runFailures, setRunFailures] = useState<Record<string, RunFailure>>({}),
    [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({
      state: 'loading',
    }),
    [streams, setStreams] = useState<Record<string, RunStream>>({}),
    [page, setPage] = useState<PageId>(readPage),
    [mode, setModeState] = useState<Mode>(readMode),
    [panel, setPanel] = useState<PanelSpec | null>(() => {
      const id = new URLSearchParams(location.search).get('review-document');
      if (new URLSearchParams(location.search).has('review-layout') || (readPage() === 'todos' && id)) {
        return readPage() === 'todos' && id ? { kind: 'audit', id, title: '待办单据' } : null;
      }
      try {
        const saved = JSON.parse(
          sessionStorage.getItem('cx.agent.local.panel') ?? 'null',
        );
        return saved && ['search', 'notifications'].includes(saved.kind)
          ? null
          : saved;
      } catch {
        return null;
      }
    }),
    [mobileOpen, setMobileOpen] = useState(false),
    [frequentApps, setFrequentApps] = useState(readFrequentApps),
    [notificationsOpen, setNotificationsOpen] = useState(false),
    [notificationRefreshFailed, setNotificationRefreshFailed] = useState(false),
    [toast, setToast] = useState(''),
    [homeInput, setHomeInput] = useState(() => homeDraft().input ?? ''),
    [homeRefs, setHomeRefs] = useState<ContextRef[]>(
      () => homeDraft().refs ?? [],
    ),
    [homeCapability, setHomeCapability] = useState<CapabilityId | null>(
      () => homeDraft().capability ?? null,
    ),
    [homeExpertTeamName, setHomeExpertTeamName] = useState<string | null>(
      () => homeDraft().expertTeamName ?? null,
    ),
    [busyIds, setBusyIds] = useState<string[]>([]),
    [compact, setCompact] = useState(
      () => localStorage.getItem('cx.compact') === '1',
    ),
    [, setConversationClock] = useState(Date.now()),
    [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const state = {
    ...savedState,
    tasks: savedState.tasks.map((task) => {
      const stream = streams[task.id];
      const failure = runFailures[task.id];
      const messages = mergeRunMessages(task.messages, stream);
      return {
        ...task,
        status: busyIds.includes(task.id)
          ? '处理中'
          : failure
            ? (failure.retry ? '发送失败' : '执行失败')
            : task.status,
        messages: failure
          ? [
              ...messages,
              {
                id: `failure-${task.id}`,
                role: 'assistant' as const,
                runStatus: 'failed',
                text: failure.message,
              },
            ]
          : messages,
      };
    }),
  };
  const stateRef = useRef(savedState),
    panelRef = useRef(panel),
    draftTaskId = useRef<string | null>(
      page === 'home' ? null : readSkillDraftTarget(),
    ),
    dialog = useRef<HTMLDialogElement>(null),
    notificationTrigger = useRef<HTMLButtonElement>(null),
    mobileNavigationTrigger = useRef<HTMLButtonElement>(null),
    notificationReturnScroll = useRef(0),
    checkingNotifications = useRef(false),
    lastFocus = useRef<HTMLElement | null>(null),
    connections = useRef(
      new Map<string, { runId: string; source: EventSource }>(),
    ),
    starting = useRef(new Set<string>()),
    mounted = useRef(true),
    initialized = useRef(false),
    restoredPanel = useRef(false),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  stateRef.current = savedState;
  panelRef.current = panel;
  const active = state.tasks.find((t) => t.id === state.activeTask),
    chatVisible = page === 'chat' && active,
    submissionSurface = panel?.kind === 'submission' || isReimbursementPanel(panel),
    inlinePanel =
      (mode === 'operations' ||
        panel?.kind === 'report' ||
        submissionSurface) &&
      page === 'chat' &&
      panel &&
      [
        'document',
        'materials',
        'submission',
        'audit',
        'analysis',
        'report',
        'rule',
        'skill',
      ].includes(panel.kind) &&
      viewportWidth >= (submissionSurface ? 1280 : 1100);
  const attention = selectHomeTasks(state.tasks).attention;
  const attentionCount = attention.length;
  const conversations = recentConversations(state.tasks);
  const readingTask = notificationsOpen ? undefined : chatVisible || undefined;
  const { reads: readReplies, markRepliesRead } = useConversationReads(
    ready,
    state.tasks,
    readingTask,
  );
  const notifications = useWorkspaceNotifications({
    ready,
    tasks: state.tasks,
    data: state.data,
    readReplies,
    openTaskId: readingTask?.id,
  });
  const unreadNotifications = notifications.items.filter((item) => item.unread);
  useEffect(() => {
    const timer = window.setInterval(
      () => setConversationClock(Date.now()),
      60000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (page === 'home') setDraftTarget(null);
    else if (chatVisible) setDraftTarget(active.id);
  }, [page, chatVisible, active?.id]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWorkspace((snapshot) => {
      const firstSnapshot = !initialized.current;
      const next = !firstSnapshot
        ? {
            ...snapshot.state,
            activeTask:
              stateRef.current.activeTask &&
              snapshot.state.tasks.some(
                (task) => task.id === stateRef.current.activeTask,
              )
                ? stateRef.current.activeTask
                : null,
          }
        : {
            ...snapshot.state,
            tasks: snapshot.state.tasks.map((task) => {
              const input = readComposerDraft(task.id);
              return input === null ? task : { ...task, input };
            }),
          };
      initialized.current = true;
      stateRef.current = next;
      setSavedState(next);
      setReady(true);
      if (firstSnapshot) saveWorkspace(workspacePatch(snapshot.state, next));
    });
    const unsubscribeStatus = subscribeRuntimeStatus((status) => {
      setRuntimeStatus(status);
      if (status.state === 'ready') {
        for (const task of stateRef.current.tasks) {
          if (readComposerDraft(task.id) === task.input)
            forgetComposerDraft(task.id);
        }
      }
    });
    void connectRuntime();
    return () => {
      mounted.current = false;
      unsubscribe();
      unsubscribeStatus();
      connections.current.forEach(({ source }) => source.close());
      connections.current.clear();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        'cx.agent.local.homeDraft',
        JSON.stringify({
          input: homeInput,
          refs: homeRefs,
          capability: homeCapability,
          expertTeamName: homeExpertTeamName,
        }),
      );
    } catch {}
  }, [homeInput, homeRefs, homeCapability, homeExpertTeamName]);
  useEffect(() => {
    if (!ready) return;
    if (!restoredPanel.current) {
      restoredPanel.current = true;
      const task = savedState.tasks.find(
        (item) => item.id === savedState.activeTask,
      );
      if (task) {
        const next = continuedQuestionPanel(
          panelRef.current,
          continuationDraftId(task),
          task,
        );
        if (next) setPanel(next);
      }
    }
    for (const task of savedState.tasks)
      if (task.activeRunId && !connections.current.has(task.id))
        connectRun(task.id, task.activeRunId);
  }, [ready, savedState.tasks]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete('review-layout');
    if (page === 'todos' && panel?.kind === 'audit' && panel.id && panel.id !== 'batch')
      url.searchParams.set('review-document', panel.id);
    else url.searchParams.delete('review-document');
    if (url.href !== location.href) history.replaceState(history.state, '', url);
    try {
      sessionStorage.setItem('cx.agent.local.panel', JSON.stringify(panel));
    } catch {}
  }, [panel, page]);
  useEffect(() => {
    const resized = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  useEffect(() => {
    const syncFrequentApps = (event: StorageEvent) => {
      if (event.key === frequentAppStorageKey || event.key === null)
        setFrequentApps(readFrequentApps());
    };
    window.addEventListener('storage', syncFrequentApps);
    return () => window.removeEventListener('storage', syncFrequentApps);
  }, []);
  useEffect(() => {
    document.title = `财小智 · ${notificationsOpen ? '消息中心' : pageTitles[page]}`;
  }, [page, notificationsOpen]);
  useEffect(() => {
    const hash = () => {
      setNotificationsOpen(false);
      setPage(readPage());
    };
    window.addEventListener('hashchange', hash);
    return () => window.removeEventListener('hashchange', hash);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (panelRef.current) closePanel();
        navigate('history');
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (notificationsOpen && !mobileOpen) {
        e.preventDefault();
        closeNotifications();
      } else if (inlinePanel) closePanel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [inlinePanel, page, homeInput, homeRefs, homeCapability, homeExpertTeamName, notificationsOpen, mobileOpen]);
  useLayoutEffect(() => {
    if (!notificationsOpen) return;
    window.scrollTo(0, 0);
    document.getElementById('notification-center-heading')?.focus({ preventScroll: true });
  }, [notificationsOpen]);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(refreshNotifications, 60000);
    document.addEventListener('visibilitychange', refreshNotifications);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshNotifications);
    };
  }, [ready]);
  useEffect(() => {
    const element = dialog.current;
    if (ready && panel && !inlinePanel && !notificationsOpen) {
      if (element && !element.open) {
        element.showModal();
        element.querySelector<HTMLElement>('.rl-caption h2, .dp-caption h2')?.focus({ preventScroll: true });
      }
    } else if (element?.open) element.close();
  }, [ready, panel, inlinePanel, notificationsOpen]);
  useEffect(() => {
    if (mode === 'operations' && page === 'home') {
      const t =
        stateRef.current.tasks.find((t) => t.id === 'task-audit') ??
        stateRef.current.tasks[0];
      if (t) {
        setState((s) => ({ ...s, activeTask: t.id }));
        navigate('chat');
        setPanel({ kind: 'audit', title: '待审单据', id: 'batch' });
      }
    }
  }, []);
  function setState(action: SetStateAction<WorkspaceState>) {
    const before = stateRef.current;
    const after = typeof action === 'function' ? action(before) : action;
    stateRef.current = after;
    setSavedState(after);
    saveWorkspace(workspacePatch(before, after));
  }
  async function connectRuntime() {
    try {
      await flushWorkspace();
      await readWorkspace();
    } catch (error) {
      if (mounted.current) {
        setRuntimeStatus({
          state: 'offline',
          message: (error as Error).message,
        });
        notify((error as Error).message);
      }
    }
  }
  async function refresh() {
    await flushWorkspace();
    await readWorkspace();
  }
  async function refreshNotifications() {
    if (document.hidden || checkingNotifications.current) return;
    checkingNotifications.current = true;
    try {
      await readWorkspace();
      if (mounted.current) setNotificationRefreshFailed(false);
    } catch {
      if (mounted.current) setNotificationRefreshFailed(true);
    } finally {
      checkingNotifications.current = false;
    }
  }
  function connectRun(taskId: string, runId: string, questionDraftId?: string) {
    if (connections.current.has(taskId)) return;
    const resumedTask = stateRef.current.tasks.find(
      (task) => task.id === taskId,
    );
    questionDraftId ??= resumedTask
      ? continuationDraftId(resumedTask)
      : undefined;
    const reconcilePanel = () => {
      const completed = stateRef.current.tasks.find(
        (task) => task.id === taskId,
      );
      if (completed && stateRef.current.activeTask === taskId) {
        const next = continuedQuestionPanel(
          panelRef.current,
          questionDraftId,
          completed,
        );
        if (next) setPanel(next);
      }
    };
    const refreshRun = async () => {
      await refresh();
      reconcilePanel();
    };
    const source = new EventSource(
      `/api/local/runs/${encodeURIComponent(runId)}/events`,
    );
    connections.current.set(taskId, { runId, source });
    setRunFailures((old) => {
      const next = { ...old };
      delete next[taskId];
      return next;
    });
    setBusyIds((old) => (old.includes(taskId) ? old : [...old, taskId]));
    setStreams((old) => ({
      ...old,
      [taskId]: createRunStream(runId),
    }));
    const seen = new Set<string>();
    let terminal = false;
    const clear = () => {
      source.close();
      if (connections.current.get(taskId)?.source !== source) return;
      connections.current.delete(taskId);
      setBusyIds((old) => old.filter((id) => id !== taskId));
      setStreams((old) => {
        const next = { ...old };
        delete next[taskId];
        return next;
      });
    };
    const event = (name: string, handler: (value: any) => void) =>
      source.addEventListener(name, (raw) => {
        const message = raw as MessageEvent;
        if (
          !message.data ||
          (message.lastEventId && seen.has(message.lastEventId))
        )
          return;
        if (message.lastEventId) seen.add(message.lastEventId);
        try {
          handler(JSON.parse(message.data));
        } catch {
          notify('运行事件格式异常，请刷新会话。');
        }
      });
    const progressEvent = (kind: string, value: unknown) =>
      setStreams((old) => {
        const current = old[taskId];
        if (!current || current.runId !== runId) return old;
        return { ...old, [taskId]: reduceRunEvent(current, kind, value) };
      });
    event('tool', (value) => progressEvent('tool', value));
    event('status', (value) => progressEvent('status', value));
    event('delta', (value) => progressEvent('delta', value));
    event('result', (value) => {
      terminal = true;
      if (value.workspace?.state) {
        acceptWorkspace(value.workspace as WorkspaceSnapshot);
        reconcilePanel();
      }
    });
    event('error', (value) => {
      terminal = true;
      progressEvent('error', value);
      if (stateRef.current.activeTask !== taskId || readPage() !== 'chat')
        notify(value.message || '处理失败，请重试。');
    });
    event('done', () => {
      terminal = true;
      source.close();
      void refreshRun()
        .catch((error) => notify(error.message))
        .finally(clear);
    });
    source.onerror = (error) => {
      if (error instanceof MessageEvent) return;
      if (terminal) {
        clear();
        void refreshRun().catch(() => {});
      } else {
        setRuntimeStatus({
          state: 'offline',
          message: '运行连接中断，正在重新连接。',
        });
        void runtimeApi<{ status: string }>(
          `/runs/${encodeURIComponent(runId)}`,
        )
          .then((run) => {
            if (run.status !== 'running') {
              clear();
              void refreshRun().catch(() => {});
            }
          })
          .catch((error) => {
            if (error.status === 404) {
              clear();
              setRunFailures((old) => ({
                ...old,
                [taskId]: { message: '任务已不可用，请重新发送。' },
              }));
              void refresh().catch(() => {});
            }
          });
      }
    };
    source.onopen = () => setRuntimeStatus({ state: 'ready' });
  }
  function notify(text: string) {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3300);
  }
  function setDraftTarget(id: string | null) {
    draftTaskId.current = id;
    saveSkillDraftTarget(id);
  }
  function clearHomeDraft() {
    setHomeInput('');
    setHomeRefs([]);
    setHomeCapability(null);
    setHomeExpertTeamName(null);
  }
  function preserveHomeDraft() {
    if (
      page !== 'home' ||
      (!homeInput.trim() && homeRefs.length === 0 && !homeCapability)
    )
      return;
    const draft = makeTask(
      homeInput.trim() ? homeInput.trim().slice(0, 24) : '新会话',
    );
    draft.input = homeInput;
    draft.refs = homeRefs;
    draft.capability = homeCapability;
    draft.expertTeamName = homeExpertTeamName;
    setDraftTarget(draft.id);
    setState((current) => ({
      ...current,
      activeTask: draft.id,
      tasks: [draft, ...current.tasks],
    }));
    clearHomeDraft();
  }
  function navigate(next: PageId, hash: string = next) {
    if (next === 'skills' || next === 'light-apps') saveSkillDraftTarget(draftTaskId.current);
    else if (next !== 'home' && next !== 'chat') preserveHomeDraft();
    setPage(next);
    setNotificationsOpen(false);
    setMobileOpen(false);
    if (location.hash !== `#${hash}`) location.hash = hash;
  }
  function closeNotifications() {
    setNotificationsOpen(false);
    setMobileOpen(false);
    requestAnimationFrame(() => {
      window.scrollTo(0, notificationReturnScroll.current);
      (mobileNavigationTrigger.current ?? notificationTrigger.current)?.focus({ preventScroll: true });
    });
  }
  function toggleNotifications() {
    if (notificationsOpen) {
      closeNotifications();
      return;
    }
    notificationReturnScroll.current = window.scrollY;
    setNotificationsOpen(true);
    setMobileOpen(false);
    void refreshNotifications();
  }
  function markNotificationReplies(items: WorkspaceNotification[]) {
    const replies = new Map<string, string>();
    for (const item of items) {
      if (item.replyId) replies.set(item.taskId, item.replyId);
    }
    markRepliesRead(replies);
  }
  function markNotificationRead(id: string) {
    const item = notifications.items.find((notification) => notification.id === id);
    if (!item) return;
    notifications.markRead(id);
    markNotificationReplies([item]);
  }
  function openNotification(item: WorkspaceNotification) {
    markNotificationRead(item.id);
    selectTask(item.taskId);
    requestAnimationFrame(() => {
      document.getElementById('workspace-main')?.focus({ preventScroll: true });
    });
  }
  function openPanel(next: PanelSpec) {
    setNotificationsOpen(false);
    if (next.kind === 'tool') {
      saveSkillDraftTarget(draftTaskId.current);
      setPanel(null);
      setPage('light-apps');
      setMobileOpen(false);
      location.hash = `light-apps?tool=expense-summary${next.id ? `&result=${encodeURIComponent(next.id)}` : ''}`;
      return;
    }
    const trigger = document.activeElement;
    if (trigger instanceof HTMLElement && (!panelRef.current || (inlinePanel && !trigger.closest('.inline-detail'))))
      lastFocus.current = trigger;
    setPanel(next);
    if (trigger?.matches('button:focus-visible, a:focus-visible')) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.inline-detail .panel-header h2')?.focus({ preventScroll: true });
      });
    }
  }
  function closePanel() {
    const workId = page === 'todos' && panel?.kind === 'audit' ? panel.id : null;
    const trigger = lastFocus.current;
    lastFocus.current = null;
    setPanel(null);
    requestAnimationFrame(() => {
      if (trigger?.isConnected && trigger !== document.body) {
        trigger.focus();
      } else if (workId) {
        const row = document.querySelector<HTMLElement>(`[data-work-id="${CSS.escape(workId)}"]`);
        const next = row
          ?? document.querySelector<HTMLElement>('.wi-rows [data-work-id]')
          ?? document.querySelector<HTMLElement>('.wi-filters [aria-pressed="true"]');
        next?.focus();
      }
    });
  }
  function updateTask(id: string, fn: (task: Task) => Task) {
    setState((s) => ({
      ...s,
      tasks: s.tasks.map((t) => {
        if (t.id !== id) return t;
        const next = fn(t);
        if (next.input !== t.input) rememberComposerDraft(id, next.input);
        return next;
      }),
    }));
  }
  function selectTask(id: string) {
    preserveHomeDraft();
    setDraftTarget(id);
    setState((s) => ({ ...s, activeTask: id }));
    navigate('chat');
    if (mode === 'operations') {
      const t = stateRef.current.tasks.find((t) => t.id === id);
      const card = t?.messages.flatMap((m) => m.cards ?? []).at(-1);
      if (
        card &&
        card.kind !== 'documents' &&
        card.kind !== 'clarify' &&
        card.kind !== 'tool'
      )
        setPanel({
          kind: card.kind,
          title: card.title,
          id: card.id,
          data: card.data,
        });
      else setPanel(null);
    } else closePanel();
  }
  function newTask() {
    setDraftTarget(null);
    setState((s) => ({ ...s, activeTask: null }));
    clearHomeDraft();
    setPanel(null);
    navigate('home');
  }
  function discussBoard(snapshot: BusinessBoardSnapshot) {
    const ref = boardReference(snapshot);
    const task = makeTask(snapshot.departmentLabel + ' · ' + snapshot.title.replace(/看板$/, '分析'));
    task.capability = 'analysis';
    task.refs = [ref];
    setDraftTarget(task.id);
    setState((current) => ({
      ...current, activeTask: task.id, tasks: [task, ...current.tasks],
    }));
    setPanel(null);
    navigate('chat');
    requestAnimationFrame(() => document.getElementById('message-input')?.focus());
  }
  function discussAuditDocument(doc: WorkDocument) {
    const title = workDocumentTitle(doc);
    const ref: ContextRef = { kind: 'audit', id: doc.id, title };
    const target = stateRef.current.tasks.find((task) => task.id === draftTaskId.current);
    if (isExpertTeam(target ? target.capability : homeCapability)) {
      attach(ref);
      return;
    }
    preserveHomeDraft();
    const id = 'work-document-' + doc.id;
    setDraftTarget(id);
    setState((current) => {
      const existing = current.tasks.find((task) => task.id === id);
      const task = existing ?? { ...makeTask(title), id };
      const updated = {
        ...task,
        title: task.title === doc.title ? title : task.title,
        refs: [...task.refs.filter((item) => item.kind !== 'audit'), ref],
      };
      return {
        ...current,
        activeTask: id,
        tasks: existing
          ? current.tasks.map((item) => item.id === id ? updated : item)
          : [updated, ...current.tasks],
      };
    });
    closePanel();
    navigate('chat');
    requestAnimationFrame(() => document.getElementById('message-input')?.focus());
  }
  function selectSkill(ref: ContextRef) {
    if (ref.kind !== 'skill') return;
    const targetId = draftTaskId.current;
    const target = stateRef.current.tasks.find((task) => task.id === targetId);
    if (isExpertTeam(target ? target.capability : homeCapability)) {
      notify('请先退出当前专家团，再选择单项技能。');
      return;
    }
    const home = {
      input: homeInput,
      refs: homeRefs,
      capability: homeCapability,
    };
    const selection = selectSkillDraft(stateRef.current, home, targetId, ref);
    if (selection.page === 'chat') {
      setState(
        (current) => selectSkillDraft(current, home, targetId, ref).state,
      );
    } else {
      setDraftTarget(null);
      setHomeRefs(
        (refs) =>
          selectSkillDraft(stateRef.current, { ...home, refs }, null, ref).home
            .refs,
      );
    }
    closePanel();
    navigate(selection.page);
    requestAnimationFrame(() =>
      document.getElementById('message-input')?.focus(),
    );
  }
  function teamSwitchBlocked(task?: Task) {
    if (!task) return false;
    if (task.activeRunId || starting.current.has(task.id) || connections.current.has(task.id)) {
      notify('当前会话正在处理，请在本轮结束后切换。');
      return true;
    }
    const question = pendingQuestion(task);
    if (question && questionState(question, stateRef.current.data) === 'pending') {
      notify('请先回答当前问题，或选择“暂不处理”后再切换。');
      return true;
    }
    return false;
  }
  function summonExpertTeam(id: ExpertTeamId, prompt?: string, teamName?: string) {
    const target = stateRef.current.tasks.find((task) => task.id === draftTaskId.current);
    closePanel();
    if (target) {
      if (stateRef.current.activeTask !== target.id)
        setState((s) => ({ ...s, activeTask: target.id }));
      navigate('chat');
      if (teamSwitchBlocked(target)) return;
      updateTask(target.id, (task) => ({
        ...task, ...prepareExpertTeamDraft(task, id, prompt, teamName),
      }));
    } else {
      setDraftTarget(null);
      const draft = prepareExpertTeamDraft({ input: homeInput, refs: homeRefs }, id, prompt, teamName);
      setHomeInput(draft.input);
      setHomeRefs(draft.refs);
      setHomeCapability(id);
      setHomeExpertTeamName(draft.expertTeamName);
      navigate('home');
    }
    requestAnimationFrame(() => document.getElementById('message-input')?.focus());
  }
  function attach(ref: ContextRef) {
    function addReference(refs: ContextRef[], capability?: CapabilityId | null) {
      const single = ref.kind === 'submission' || (ref.kind === 'audit' && isExpertTeam(capability));
      return [...refs.filter((item) => {
        if (ref.kind === 'report' && ref.followupId &&
            item.kind === 'report' && item.id.startsWith('business-report-')) {
          return false;
        }
        return item.kind !== ref.kind || (!single && item.id !== ref.id);
      }), ref];
    }
    if (page === 'home') {
      setHomeRefs((current) => addReference(current, homeCapability));
      if (ref.kind === 'submission' && !isExpertTeam(homeCapability)) setHomeCapability('submission');
      closePanel();
      requestAnimationFrame(() =>
        document.getElementById('message-input')?.focus(),
      );
      notify(`已添加「${ref.title}」`);
      return;
    }
    const freshTask = makeTask();
    const targetId = draftTaskId.current ?? freshTask.id;
    const draftExisted = stateRef.current.tasks.some((task) => task.id === targetId);
    // Reserve the draft before React batches consecutive reference additions.
    setDraftTarget(targetId);
    setState((s) => {
      const existing = s.tasks.find((t) => t.id === targetId);
      const task = existing ?? { ...freshTask, id: targetId };
      const selected = existing ? task.capability : homeCapability;
      const updated = {
        ...task,
        input: existing ? task.input : homeInput,
        capability:
          ref.kind === 'submission' && !isExpertTeam(selected)
            ? ('submission' as const)
            : selected,
        expertTeamName: existing ? task.expertTeamName : homeExpertTeamName,
        refs: addReference(existing ? task.refs : homeRefs, selected),
      };
      return {
        ...s,
        activeTask: task.id,
        tasks: existing
          ? s.tasks.map((t) => (t.id === task.id ? updated : t))
          : [updated, ...s.tasks],
      };
    });
    if (!draftExisted) clearHomeDraft();
    closePanel();
    navigate('chat');
    notify(`已引用「${ref.title}」`);
  }
  async function send(
    text: string,
    explicitRefs?: ContextRef[],
    questionAnswer?: QuestionAnswerInput,
    retry?: SendAttempt,
  ) {
    if (!text.trim() || !ready) {
      if (questionAnswer) throw new Error('服务尚未就绪，请稍后重试。');
      return;
    }
    const targetId = page === 'chat' ? stateRef.current.activeTask : draftTaskId.current;
    const target = stateRef.current.tasks.find((task) => task.id === targetId);
    let task = page === 'chat' || isExpertTeam(target?.capability) ? target : undefined;
    const useHomeDraft = !task && (page === 'home' || (!target && isExpertTeam(homeCapability)));
    if (!task) {
      task = makeTask(text.slice(0, 24));
      if (useHomeDraft) Object.assign(task, {
        input: homeInput, refs: homeRefs, capability: homeCapability, expertTeamName: homeExpertTeamName,
      });
      setState((current) => ({
        ...current,
        tasks: [task!, ...current.tasks],
        activeTask: task!.id,
      }));
    }
    const id = task.id;
    if (task.activeRunId || starting.current.has(id) || connections.current.has(id)) {
      if (questionAnswer) throw new Error('当前会话正在处理，请稍后回答。');
      notify('当前会话正在处理，请稍后发送。');
      return;
    }
    const selectedTeam = isExpertTeam(task.capability);
    const question = pendingQuestion(task);
    if (selectedTeam && explicitRefs && !questionAnswer && question &&
        questionState(question, stateRef.current.data) === 'pending') {
      closePanel();
      selectTask(id);
      notify('请先处理当前待回答的问题。');
      return;
    }
    const preserveComposerDraft = !!task.input && task.input !== text;
    starting.current.add(id);
    setRunFailures((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    const composerRefs = task === target || useHomeDraft ? task.refs : homeRefs;
    const workRef = composerRefs.find((ref) => ref.kind === 'audit' && id === 'work-document-' + ref.id);
    const baseRefs = selectedTeam
      ? expertTeamRefs(composerRefs, explicitRefs)
      : explicitRefs && workRef && !explicitRefs.some((ref) => ref.kind === 'audit')
        ? [workRef, ...explicitRefs]
        : explicitRefs ?? composerRefs;
    const answering = !!questionAnswer || !!question;
    const activePanel = panelRef.current;
    const openSubmission = activePanel?.kind === 'submission' ? activePanel :
      activePanel && isReimbursementPanel(activePanel) ? {
        id: String(activePanel.data!.draftId), title: '费用报销',
      } : null;
    const refs = retry?.refs ?? (
      openSubmission && !explicitRefs && !answering
        ? [
            ...baseRefs.filter((ref) => ref.kind !== 'submission'),
            {
              kind: 'submission',
              id: openSubmission.id ?? 'expense',
              title: openSubmission.title,
            },
          ]
        : baseRefs
    );
    const capability = retry ? retry.capability : answering || selectedTeam
      ? task.capability
      : explicitRefs?.some((ref) => ref.kind === 'document')
        ? 'documents'
        : explicitRefs?.some((ref) => ref.kind === 'knowledge')
          ? 'knowledge'
          : explicitRefs?.some((ref) => ref.kind === 'submission')
            ? 'submission'
            : task.capability;
    updateTask(id, (current) => ({
      ...current,
      title: ['新任务', '新会话'].includes(current.title)
        ? text.slice(0, 24)
        : current.title,
      input: questionAnswer || preserveComposerDraft ? current.input : '',
      capability: retry ? current.capability : capability,
      refs: retry ? current.refs : refs,
      updated: '刚刚',
      messages:
        questionAnswer ||
        (current.messages.at(-1)?.role === 'user' &&
          current.messages.at(-1)?.text === text)
          ? current.messages
          : [
              ...current.messages,
              { id: uid(), role: 'user', text, createdAt: Date.now() },
            ],
    }));
    if (useHomeDraft) clearHomeDraft();
    setDraftTarget(id);
    if (stateRef.current.activeTask !== id) setState((s) => ({ ...s, activeTask: id }));
    navigate('chat');
    if (
      !answering &&
      (capability === 'translation' ||
        (!capability &&
          /翻译|翻成中文/.test(text) &&
          (refs.some((ref) => ref.kind === 'file') ||
            /附件|票据|发票|账单|收据/.test(text))))
    ) {
      const files = refs.filter((ref) => ref.kind === 'file');
      updateTask(id, (current) => ({
        ...current,
        type: 'translation',
        status: '待我处理',
        messages: [
          ...current.messages,
          {
            id: uid(),
            role: 'assistant',
            text: files.length
              ? '已打开中文翻译窗口，处理结果将在窗口内显示。'
              : '请上传需要翻译的票据图片或 PDF。',
            createdAt: Date.now(),
            cards: [
              {
                kind: 'translation',
                title: '附件翻译',
                subtitle: files.length
                  ? files.map((file) => file.title).join('、')
                  : '上传票据',
                id: files[0]?.id,
                data: { fileIds: files.map((file) => file.id) },
              },
            ],
          },
        ],
      }));
      starting.current.delete(id);
      openPanel({
        kind: 'translation',
        title: '附件翻译',
        id: files[0]?.id,
        data: {
          autoStart: files.length > 0,
          fileIds: files.map((file) => file.id),
        },
      });
      return;
    }
    setBusyIds((old) => [...old.filter((value) => value !== id), id]);
    try {
      await flushWorkspace();
      const result = await runtimeApi<{
        runId: string | null;
        taskId: string;
        workspace?: WorkspaceSnapshot;
      }>('/runs', {
        taskId: id,
        message: text,
        refs,
        capability,
        // The submitted draft was cleared before flushWorkspace. A newer draft
        // may already have been saved while this POST was in transit.
        preserveComposerDraft: true,
        ...(retry ? { useSavedComposer: true } : {}),
        ...(questionAnswer ? { questionAnswer } : {}),
      });
      if (result.workspace) acceptWorkspace(result.workspace);
      if (result.runId)
        connectRun(
          result.taskId,
          result.runId,
          answering ? pendingQuestion(task)?.draftId : undefined,
        );
      else setBusyIds((old) => old.filter((value) => value !== id));
      await readWorkspace();
    } catch (error) {
      // A lost POST response can still represent a running server task. Reconcile before retrying.
      const snapshot = await readWorkspace().catch(() => null);
      const current = snapshot?.state.tasks.find((task) => task.id === id);
      if (current?.activeRunId)
        connectRun(
          id,
          current.activeRunId,
          answering ? pendingQuestion(task)?.draftId : undefined,
        );
      else if (!connections.current.has(id)) {
        setBusyIds((old) => old.filter((value) => value !== id));
        const latest = current?.messages.at(-1);
        const receivedAnswer = latest?.role === 'assistant' &&
          !task.messages.some((message) => message.id === latest.id);
        if (!receivedAnswer && !questionAnswer) {
          setRunFailures((old) => ({
            ...old,
            [id]: { message: (error as Error).message, retry: { text, refs, capability } },
          }));
          if (!preserveComposerDraft)
            updateTask(id, (value) => ({ ...value, input: value.input || text }));
        }
      }
      if (questionAnswer && !current?.activeRunId) {
        const confirmed = current?.messages.some((message) =>
          message.question?.id === questionAnswer.questionId &&
          ['answered', 'deferred'].includes(message.question.status),
        );
        if (!confirmed) throw error;
      }
    } finally {
      starting.current.delete(id);
    }
  }
  async function answerQuestion(input: QuestionAnswerInput) {
    const task = stateRef.current.tasks.find(
      (item) => item.id === stateRef.current.activeTask,
    );
    if (!task || page !== 'chat') throw new Error('请返回原会话回答这个问题。');
    const prepared = prepareQuestionAnswer(task, input, stateRef.current.data);
    await send(prepared.message, task.refs, prepared.answer);
  }
  function message(text: string, cards?: ResultCard[]) {
    const id = stateRef.current.activeTask;
    if (id)
      updateTask(id, (t) => ({
        ...t,
        messages: [
          ...t.messages,
          { id: uid(), role: 'assistant', text, cards, createdAt: Date.now() },
        ],
        updated: '刚刚',
      }));
    else {
      const task = makeTask(cards?.[0]?.title ?? text.slice(0, 20));
      task.status = '待我处理';
      task.messages = [
        { id: uid(), role: 'assistant', text, cards, createdAt: Date.now() },
      ];
      setState((s) => ({
        ...s,
        tasks: [task, ...s.tasks],
        activeTask: task.id,
      }));
    }
  }
  async function stop() {
    if (!active?.activeRunId) return;
    try {
      await runtimeApi(`/runs/${encodeURIComponent(active.activeRunId)}/cancel`, {});
      await refresh();
    } catch (error) {
      notify((error as Error).message);
    }
  }
  async function upload(files: FileList) {
    const targetTaskId = page === 'chat' ? stateRef.current.activeTask : null;
    const selected = Array.from(files);
    if (!selected.length) return;
    const refs: ContextRef[] = [];
    try {
      await flushWorkspace();
      for (const file of selected) {
        const result = await uploadFile(file);
        refs.push({
          kind: 'file',
          id: result.file.id,
          title: result.file.name,
        });
      }
      await refresh();
      notify(`${refs.length} 份材料已上传`);
    } catch (error) {
      notify((error as Error).message);
      await readWorkspace().catch(() => {});
    }
    if (refs.length) {
      if (targetTaskId)
        updateTask(targetTaskId, (task) => ({
          ...task,
          refs: [...task.refs, ...refs],
        }));
      else setHomeRefs((old) => [...old, ...refs]);
    }
  }
  function setMode(value: Mode) {
    setModeState(value);
    const url = new URL(location.href);
    url.searchParams.set('mode', value);
    history.replaceState(null, '', url);
    closePanel();
    if (value === 'operations') {
      const t = active ?? state.tasks[1] ?? state.tasks[0];
      if (t) {
        setState((s) => ({ ...s, activeTask: t.id }));
        navigate('chat');
        const card = t.messages.flatMap((m) => m.cards ?? []).at(-1);
        if (card && card.kind !== 'documents')
          setPanel({
            kind: card.kind,
            title: card.title,
            id: card.id,
            data: card.data,
          });
      }
    }
  }
  const api: WorkspaceAPI = {
    state,
    refresh,
    flush: flushWorkspace,
    updateData: <T,>(key: string, next: T | ((previous: T | undefined) => T)) =>
      setState((s) => {
        const data = {
          ...s.data,
          [key]:
            typeof next === 'function'
              ? (next as (p: T | undefined) => T)(s.data[key])
              : next,
        };
        return { ...s, data, tasks: syncTaskStates(s.tasks, data, key) };
      }),
    openPanel,
    closePanel,
    navigate,
    attach,
    discussAuditDocument,
    selectSkill,
    summonExpertTeam,
    send,
    answerQuestion,
    message,
    notify,
    setTaskStatus: (status) => {
      if (stateRef.current.activeTask)
        updateTask(stateRef.current.activeTask, (t) => ({ ...t, status }));
    },
  };
  const currentInput = chatVisible ? active.input : homeInput,
    currentRefs = chatVisible ? active.refs : homeRefs,
    currentTeamName = chatVisible ? active.expertTeamName : homeExpertTeamName,
    currentCapability =
      getCapability(chatVisible ? active.capability : homeCapability)?.id ??
      null;
  function selectCapability(capability: CapabilityId | null) {
    if (isExpertTeam(capability)) {
      summonExpertTeam(capability, undefined, currentCapability === capability ? currentTeamName ?? undefined : undefined);
      return;
    }
    if (chatVisible) {
      if (isExpertTeam(currentCapability) && teamSwitchBlocked(active)) return;
      updateTask(active.id, (task) => ({ ...task, capability, expertTeamName: null }));
    } else {
      setHomeCapability(capability);
      setHomeExpertTeamName(null);
    }
    requestAnimationFrame(() =>
      document.getElementById('message-input')?.focus(),
    );
  }
  function prepareDraft(text: string) {
    setHomeInput((current) => appendDraft(current, text));
    requestAnimationFrame(() => {
      const field = document.getElementById(
        'message-input',
      ) as HTMLTextAreaElement | null;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    });
  }
  const pendingAnswer = chatVisible ? pendingQuestion(active) : undefined;
  const answerQuestionAtInput =
    pendingAnswer && questionState(pendingAnswer, state.data) === 'pending'
      ? pendingAnswer
      : undefined;
  useEffect(() => {
    if (!ready) return;
    for (const task of state.tasks) {
      for (const message of task.messages) {
        if (message.question && ['answered', 'expired'].includes(message.question.status)) {
          // A locally edited draft can temporarily invalidate the question.
          // Keep its answer until the server confirms the question has ended.
          clearQuestionResponse(task.id, message.question.id);
        }
      }
    }
  }, [ready, state.tasks]);
  const activeFailure = active && runFailures[active.id]?.retry;
  const retrySend = activeFailure
    ? () => send(activeFailure.text, activeFailure.refs, undefined, activeFailure)
    : undefined;
  const activeStream = active && streams[active.id];
  const stopActive = active?.activeRunId && (!activeStream || activeStream.runStatus === 'running')
    ? stop
    : undefined;
  const composer =
    answerQuestionAtInput && chatVisible ? (
      <QuestionComposer
        key={`${active.id}:${answerQuestionAtInput.id}`}
        taskId={active.id}
        question={answerQuestionAtInput}
        busy={busyIds.includes(active.id)}
        onStop={stopActive}
      />
    ) : (
      <Composer
        capability={currentCapability}
        teamName={currentTeamName}
        onCapabilityChange={selectCapability}
        value={currentInput}
        onChange={(value) =>
          chatVisible
            ? updateTask(active.id, (t) => ({ ...t, input: value }))
            : setHomeInput(value)
        }
        onSend={() => send(currentInput)}
        refs={currentRefs}
        onAdd={(ref) => {
          const add = (refs: ContextRef[]) => [
            ...refs.filter(
              (item) => item.kind !== ref.kind || item.id !== ref.id,
            ),
            ref,
          ];
          if (chatVisible)
            updateTask(active.id, (task) => ({
              ...task,
              refs: add(task.refs),
            }));
          else setHomeRefs(add);
        }}
        onRemove={(ref) =>
          chatVisible
            ? updateTask(active.id, (t) => ({
                ...t,
                refs: t.refs.filter(
                  (r) => r.id !== ref.id || r.kind !== ref.kind,
                ),
              }))
            : setHomeRefs((refs) =>
                refs.filter((r) => r.id !== ref.id || r.kind !== ref.kind),
              )
        }
        busy={!!chatVisible && busyIds.includes(active.id)}
        onStop={stopActive}
        onUpload={upload}
        compact={!!chatVisible}
      />
    );
  const progressLookup = useDocumentPanelLookup(panel, state.data.documents ?? [], state.data.documentSources?.states ?? {}, ready);
  const progressDoc = progressLookup.document;
  const progressFooter = panel?.kind === 'document'
    ? <DocumentPanelActions panel={panel} document={progressLookup.sourceId ? undefined : progressDoc} /> : null;
  const renderedPanel =
    ready && panel ? (
      panel.kind === 'artifact' ? (
        <SkillArtifactPanel panel={panel} />
      ) : panel.kind === 'translation' ? (
        <TranslationPanel panel={panel} />
      ) : panel.kind === 'document' ? (
        <DocumentPanel lookup={progressLookup} />
      ) : panel.kind === 'materials' ? (
        <MaterialsPanel panel={panel} />
      ) : panel.kind === 'submission' ? (
        <SubmissionPanel panel={panel} />
      ) : panel.kind === 'audit' ? (
        <AuditPanel
          panel={panel}
          fromInbox={page === 'todos'}
        />
      ) : panel.kind === 'rule' ? (
        <RulesPanel panel={panel} />
      ) : panel.kind === 'analysis' ? (
        panel.data?.businessBoard ? <BusinessAnalysisCard card={panel} /> :
        panel.data?.publicFinance ? <PublicFinancialsPanel panel={panel} /> : <AnalysisPanel panel={panel} />
      ) : panel.kind === 'report' ? (
        panel.data?.businessReport || panel.id?.startsWith('business-report-') ? <BusinessReportPanel id={panel.id} /> :
        panel.data?.publicFinance || panel.id?.startsWith('public-report-')
          ? <PublicFinancialReportPanel panel={panel} />
          : <ReportPanel panel={panel} />
      ) : panel.kind === 'skill-picker' ? (
        <SkillPickerPanel />
      ) : panel.kind === 'skill' ? (
        <SkillPanel panel={panel} />
      ) : panel.kind === 'governance' ? (
        <GovernancePanel panel={panel} />
      ) : panel.kind === 'knowledge' ? (
        <KnowledgePanel panel={panel} />
      ) : panel.kind === 'apps' ? (
        <AppsPanel
          frequentApps={frequentApps}
          onSaveFrequentApps={(ids) => {
            try {
              localStorage.setItem(frequentAppStorageKey, JSON.stringify(ids));
            } catch {
              return false;
            }
            setFrequentApps(ids);
            return true;
          }}
        />
      ) : panel.kind === 'context' ? (
        <ContextPanel />
      ) : panel.kind === 'help' ? (
        <HelpPanel />
      ) : panel.kind === 'preferences' ? (
        <PreferencesPanel
          mode={mode}
          setMode={setMode}
          compact={compact}
          setCompact={(v) => {
            setCompact(v);
            localStorage.setItem('cx.compact', v ? '1' : '0');
          }}
        />
      ) : panel.kind === 'rename' ? (
        <RenamePanel
          initial={active?.title ?? ''}
          onSave={(name) => {
            if (active) updateTask(active.id, (t) => ({ ...t, title: name }));
            closePanel();
          }}
        />
      ) : (
        <Empty title="未找到相关内容" />
      )
    ) : null;
  const isWorkDossier = panel?.kind === 'audit' && !!panel.id && !['batch', 'schedule'].includes(panel.id);
  const workDoc: WorkDocument | undefined = isWorkDossier
    ? findWorkDocument(state.data, panel.id!)
    : undefined;
  function sidebarApp(id: PageId) {
    const app = apps.find((item) => item.id === id);
    if (!app) return null;
    const current = !notificationsOpen && page === id;
    return (
      <button
        key={id}
        type="button"
        className={`nav-item ${current ? 'active' : ''}`}
        aria-current={current ? 'page' : undefined}
        title={app.label}
        onClick={() => {
          navigate(id, id === 'skills' ? 'skills?section=teams' : id);
          closePanel();
        }}
      >
        <Icon name={app.icon} size={17} />
        <span>{app.label}</span>
      </button>
    );
  }
  const browsingDirectory = !notificationsOpen && (
    panel?.kind === 'apps' ||
    (apps.some((app) => app.id === page) && !workspaceApps.includes(page) && !frequentApps.includes(page))
  );
  const skillReader = panel?.kind === 'skill' && !panel.data?.toolId;
  const helpInPanelHeader = submissionSurface || panel?.kind === 'document';
  const panelHeader = (
    <header className="panel-header">
      {workDoc ? (
        <div className="rl-caption">
          <WorkDocumentIcon doc={workDoc} />
          <div>
            <h2 id="panel-title" tabIndex={-1}>{workDocumentTitle(workDoc)}</h2>
            <span>{workDoc.id}</span>
          </div>
        </div>
      ) : progressDoc ? (
        <div className="dp-caption">
          <WorkDocumentIcon doc={progressDoc} />
          <div>
            <h2 id="panel-title" tabIndex={-1}>{progressDoc.title}</h2>
            <small>{progressDoc.typeLabel} · {progressDoc.id}</small>
          </div>
        </div>
      ) : <h2 id="panel-title" tabIndex={-1}>{skillReader ? '技能详情' : panel?.title}</h2>}
      <div>
        {helpInPanelHeader && <ContextHelp />}
        <button className="icon-btn" aria-label="关闭详情" onClick={closePanel}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </header>
  );
  return (
    <WorkspaceContext.Provider value={api}>
      <div
        className={`app-shell agent-first mode-${mode} ${compact ? 'compact-mode' : ''} ${inlinePanel && panel?.kind === 'submission' ? 'submission-open' : ''}`}
      >
        {mobileOpen && (
          <button
            className="mobile-veil"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          id="workspace-navigation"
          inert={viewportWidth <= 640 && !mobileOpen ? true : undefined}
          aria-hidden={viewportWidth <= 640 && !mobileOpen ? true : undefined}
          className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}
        >
          <button type="button" className="brand" onClick={newTask} title="财小智">
            <BrandWordmark />
          </button>
          <button
            type="button"
            className="new-task new-chat-trigger"
            onClick={newTask}
            title="新建会话"
          >
            <Icon name="xiaozhi" size={21} />
            <span>新建会话</span>
          </button>
          <div className="sidebar-scroll">
            <nav className="nav-group sidebar-apps" aria-label="应用导航">
              <div className="nav-group" role="group" aria-label="工作区">
                {workspaceApps.map(sidebarApp)}
              </div>
              <div className="nav-group sidebar-frequent-apps" role="group" aria-labelledby="frequent-apps-title">
                <h2 id="frequent-apps-title" className="nav-label">常用应用</h2>
                {frequentApps.map(sidebarApp)}
                <button
                  type="button"
                  className={`nav-item sidebar-all-apps ${browsingDirectory ? 'active' : ''}`}
                  aria-expanded={panel?.kind === 'apps'}
                  onClick={() => {
                    setMobileOpen(false);
                    openPanel({ kind: 'apps', title: '全部工具' });
                  }}
                  title="全部工具"
                >
                  <Icon name="grid" size={17} />
                  <span>全部工具</span>
                </button>
              </div>
            </nav>
            <div className="recent-navigation">
              <div className="nav-label recent-heading">
                <span>最近会话</span>
                <button
                  className={`all-conversations ${!notificationsOpen && page === 'history' ? 'active' : ''}`}
                  aria-current={!notificationsOpen && page === 'history' ? 'page' : undefined}
                  aria-label="全部对话"
                  onClick={() => navigate('history')}
                >
                  全部
                  <Icon name="chevron" size={12} />
                </button>
              </div>
              <div className="conversation-list">
                {conversations.map((task) => {
                  const notice =
                    readReplies &&
                    recentConversationAlert(task, readReplies.get(task.id) ?? null);
                  const noticeLabel = notice === 'error' ? '办理异常' : '有新消息';
                  const time = lastMessageTime(task);
                  const current = !notificationsOpen && page === 'chat' && active?.id === task.id;
                  return (
                    <button
                      key={task.id}
                      className={`recent-chat ${current ? 'active' : ''}`}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => selectTask(task.id)}
                      title={task.title}
                    >
                      <span className="recent-chat-title">
                        {task.title === '新任务' ? '新会话' : task.title}
                      </span>
                      {notice && (
                        <span
                          className="recent-notice"
                          data-kind={notice}
                          role="img"
                          title={noticeLabel}
                          aria-label={noticeLabel}
                        >
                          {notice === 'error' && (
                            <Icon name="error-circle" size={12} />
                          )}
                        </span>
                      )}
                      {time !== null && (
                        <time
                          dateTime={new Date(time).toISOString()}
                          title={new Date(time).toLocaleString('zh-CN')}
                        >
                          {formatConversationTime(time).replace(/\s/g, '')}
                        </time>
                      )}
                    </button>
                  );
                })}
                {!conversations.length && (
                  <p className="conversation-empty">暂无会话</p>
                )}
              </div>
            </div>
          </div>
          <div className="sidebar-bottom">
            <div className="profile">
              <span className="avatar">吴</span>
              <div>
                <strong>吴侠</strong>
                <small>华川科技 · 财务部</small>
              </div>
              <button
                ref={notificationTrigger}
                className="icon-btn notification-trigger"
                type="button"
                title="消息中心"
                aria-label={unreadNotifications.length ? `消息中心，${unreadNotifications.length} 条未读` : '消息中心'}
                aria-expanded={notificationsOpen}
                aria-controls={notificationsOpen ? 'workspace-notifications' : undefined}
                disabled={!ready}
                onClick={toggleNotifications}
              >
                <Icon name="bell" size={18} />
                {unreadNotifications.length > 0 && <span className="notification-trigger-dot" aria-hidden="true" />}
              </button>
            </div>
          </div>
        </aside>
        <main className="main-shell" id="workspace-main" tabIndex={-1}>
          {viewportWidth <= 640 && (
            <header className="mobile-topbar">
              <button
                ref={mobileNavigationTrigger}
                className="icon-btn"
                aria-label="打开导航"
                aria-controls="workspace-navigation"
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen(true)}
              >
                <Icon name="layout" size={20} />
              </button>
              <BrandWordmark />
            </header>
          )}
          {notificationsOpen && (
            <NotificationCenter
              items={notifications.items}
              onClose={closeNotifications}
              onOpen={openNotification}
              onMarkRead={markNotificationRead}
              refreshFailed={notificationRefreshFailed}
              onRefresh={refreshNotifications}
              onMarkAllRead={() => {
                notifications.markAllRead();
                markNotificationReplies(unreadNotifications);
              }}
            />
          )}
          <div className="workspace-page" hidden={notificationsOpen}>
          {!ready ? (
            <div className="runtime-loading">
              <Empty
                title={
                  runtimeStatus.state === 'offline'
                    ? '本地服务未连接'
                    : '正在加载工作空间'
                }
              >
                {runtimeStatus.state === 'offline' && (
                  <Button onClick={() => void connectRuntime()}>
                    重新连接
                  </Button>
                )}
              </Empty>
            </div>
          ) : page === 'home' || page === 'chat' ? (
            <div className="work-layout">
              {mode === 'operations' && (
                <aside className="task-rail">
                  <div className="section-heading">
                    <h2>任务队列</h2>
                    <button
                      className="icon-btn new-chat-trigger"
                      aria-label="新建会话"
                      title="新建会话"
                      onClick={newTask}
                    >
                      <Icon name="xiaozhi" size={20} />
                    </button>
                  </div>
                  <div className="rail-filter">
                    待我处理 <Badge tone="amber">{attentionCount}</Badge>
                  </div>
                  {state.tasks.map((t) => (
                    <button
                      className={`rail-task ${active?.id === t.id ? 'active' : ''}`}
                      key={t.id}
                      onClick={() => selectTask(t.id)}
                    >
                      <strong>{t.title}</strong>
                      <span>
                        <Badge
                          tone={/待我/.test(t.status) ? 'amber' : 'neutral'}
                        >
                          {t.status}
                        </Badge>
                        <small>{t.updated}</small>
                      </span>
                    </button>
                  ))}
                </aside>
              )}
              <div className="work-main">
                {chatVisible ? (
                  <ChatPage
                    streamingRunId={streams[active.id]?.runId}
                    task={active}
                    composer={composer}
                    busy={busyIds.includes(active.id)}
                    activity={streams[active.id]?.activity}
                    phase={streams[active.id]?.phase}
                    onStop={stopActive}
                    onRetrySend={retrySend}
                    onRename={() =>
                      openPanel({ kind: 'rename', title: '重命名会话' })
                    }
                  />
                ) : (
                  <Home
                    composer={composer}
                    onPrepare={prepareDraft}
                    capability={currentCapability}
                    teamName={currentTeamName}
                    onCapabilityChange={selectCapability}
                  />
                )}
              </div>
              {inlinePanel && (
                <aside
                  className={`inline-detail${skillReader ? ' skill-reader-inline' : ''}${panel.kind === 'report' ? ' report-detail' : ''}${submissionSurface ? ' submission-detail' : ''}`}
                  aria-labelledby="panel-title"
                >
                  {panelHeader}
                  <div
                    className="panel-body"
                    key={
                      panel.kind +
                      (panel.id ?? '') +
                      JSON.stringify(panel.data ?? {})
                    }
                  >
                    {renderedPanel}
                  </div>
                  {progressFooter}
                </aside>
              )}
            </div>
          ) : (
            <div className={`page-container${page === 'todos' ? ' work-inbox-page' : page === 'documents' ? ' document-progress-page' : ''}`}>
              {page === 'skills' || page === 'light-apps' || page === 'schedules' ? (
                <CatalogHeading area={page} />
              ) : page === 'documents' || page === 'analysis' ? null : (
                <div className="page-heading">
                  <h1>{pageTitles[page]}</h1>
                  {page === 'submission' && (
                    <Button
                      variant="ghost"
                      icon="clock"
                      onClick={() => navigate('documents')}
                    >
                      我的单据
                    </Button>
                  )}
                </div>
              )}
              {page === 'history' ? (
                <ConversationHistory
                  tasks={state.tasks}
                  onSelect={selectTask}
                />
              ) : page === 'documents' ? (
                <DocumentsPage />
              ) : page === 'files' ? (
                <FilesPage />
              ) : page === 'submission' ? (
                <SubmissionPage />
              ) : page === 'rules' ? (
                <RulesPage />
              ) : page === 'analysis' ? (
                <AnalysisPage onAsk={discussBoard} />
              ) : page === 'skills' ? (
                <CapabilityCenter />
              ) : page === 'light-apps' ? (
                <SkillsPage area="light-apps" />
              ) : page === 'schedules' ? (
                <ScheduledTasksPage onOpenConversation={async (id) => {
                  await flushWorkspace();
                  const snapshot = await readWorkspace();
                  if (!snapshot.state.tasks.some((task) => task.id === id))
                    throw new Error('关联会话已不存在或不可查看。');
                  selectTask(id);
                }} />
              ) : page === 'todos' ? (
                <AuditPanel
                  panel={{ kind: 'audit', id: 'batch', title: '我的工作' }}
                />
              ) : page === 'knowledge' ? (
                <KnowledgePage />
              ) : null}
            </div>
          )}
          </div>
        </main>
        {!notificationsOpen && (!panel || inlinePanel) && !helpInPanelHeader && !isWorkDossier && (
          <ContextHelp
            skillsContext={
              page === 'skills' || page === 'light-apps' ||
              panel?.kind === 'skill' ||
              panel?.kind === 'governance'
            }
          />
        )}
        <dialog
          ref={dialog}
          className={`detail-dialog${skillReader ? ' skill-reader-dialog' : ''}${submissionSurface ? ' submission-dialog' : ''}${panel?.kind === 'report' ? ' report-dialog' : ''}${panel?.kind === 'analysis' ? ' analysis-dialog' : ''}${panel?.kind === 'translation' ? ' translation-dialog' : ''}${panel?.kind === 'governance' ? ' governance-dialog' : ''}`}
          aria-labelledby="panel-title"
          onCancel={(e) => {
            e.preventDefault();
            closePanel();
          }}
          onClick={(e) => {
            if (e.target === dialog.current) {
              const r = dialog.current.getBoundingClientRect();
              if (e.clientX < r.left || e.clientX > r.right) closePanel();
            }
          }}
        >
          {!inlinePanel && (
            <>
              {panelHeader}
              <div
                className="panel-body"
                key={
                  (panel?.kind ?? '') +
                  (panel?.id ?? '') +
                  JSON.stringify(panel?.data ?? {})
                }
              >
                {renderedPanel}
              </div>
              {progressFooter}
              {panel && panel.kind !== 'help' && !helpInPanelHeader && !isWorkDossier && (
                <ContextHelp
                  skillsContext={
                    page === 'skills' || page === 'light-apps' ||
                    panel.kind === 'skill' ||
                    panel.kind === 'governance'
                  }
                />
              )}
            </>
          )}
        </dialog>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
