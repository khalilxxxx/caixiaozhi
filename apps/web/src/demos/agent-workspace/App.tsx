import { useEffect, useRef, useState, type SetStateAction } from 'react';
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
  conversationState,
  formatConversationTime,
  lastMessageTime,
  recentConversations,
} from './conversation-model';
import { getCapability, type CapabilityId } from './capability-model';
import { SkillPickerPanel } from './Skills';
import { ConversationHistory } from './ConversationHistory';
import { Composer, Home, ChatPage, logo } from './Chat';
import { RulesPage, RulesPanel, AuditPanel } from './RulesSubmission';
import { SubmissionPage, SubmissionPanel } from './SubmissionWorkspace';
import {
  DocumentsPage,
  FilesPage,
  DocumentPanel,
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
  KnowledgePage,
  KnowledgePanel,
  AppsPanel,
  ContextPanel,
  HelpPanel,
  PreferencesPanel,
  RenamePanel,
} from './Supporting';

const frequentApps: PageId[] = ['skills', 'rules', 'submission'];
const uid = () => crypto.randomUUID();
const initial: WorkspaceState = { data: {}, tasks: [], activeTask: null };
function homeDraft(): {
  input?: string;
  refs?: ContextRef[];
  capability?: CapabilityId | null;
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
  skills: '技能·工具',
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
  const p = location.hash.slice(1).split('?')[0] as PageId;
  return p in pageTitles ? p : 'home';
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
export default function App() {
  const [savedState, setSavedState] = useState<WorkspaceState>(initial),
    [ready, setReady] = useState(false),
    [runFailures, setRunFailures] = useState<Record<string, string>>({}),
    [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>({
      state: 'loading',
    }),
    [health, setHealth] = useState<{
      modelConfigured: boolean;
      model: string;
      framework: string;
    } | null>(null),
    [streams, setStreams] = useState<
      Record<string, { runId: string; text: string; activity?: string }>
    >({}),
    [page, setPage] = useState<PageId>(readPage),
    [mode, setModeState] = useState<Mode>(readMode),
    [panel, setPanel] = useState<PanelSpec | null>(() => {
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
    [toast, setToast] = useState(''),
    [homeInput, setHomeInput] = useState(() => homeDraft().input ?? ''),
    [homeRefs, setHomeRefs] = useState<ContextRef[]>(
      () => homeDraft().refs ?? [],
    ),
    [homeCapability, setHomeCapability] = useState<CapabilityId | null>(
      () => homeDraft().capability ?? null,
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
      const messages =
        stream?.text &&
        !task.messages.some(
          (message) => message.id === `assistant-${stream.runId}`,
        )
          ? [
              ...task.messages,
              {
                id: `assistant-${stream.runId}`,
                role: 'assistant' as const,
                text: stream.text,
                createdAt: Date.now(),
              },
            ]
          : task.messages;
      return {
        ...task,
        status: busyIds.includes(task.id)
          ? '处理中'
          : failure
            ? '执行失败'
            : task.status,
        messages: failure
          ? [
              ...messages,
              {
                id: `failure-${task.id}`,
                role: 'assistant' as const,
                text: failure,
              },
            ]
          : messages,
      };
    }),
  };
  const stateRef = useRef(savedState),
    panelRef = useRef(panel),
    draftTaskId = useRef<string | null>(
      page === 'home' ? null : state.activeTask,
    ),
    dialog = useRef<HTMLDialogElement>(null),
    lastFocus = useRef<HTMLElement | null>(null),
    connections = useRef(
      new Map<string, { runId: string; source: EventSource }>(),
    ),
    starting = useRef(new Set<string>()),
    mounted = useRef(true),
    initialized = useRef(false),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  stateRef.current = savedState;
  panelRef.current = panel;
  const active = state.tasks.find((t) => t.id === state.activeTask),
    chatVisible = page === 'chat' && active,
    inlinePanel =
      (mode === 'operations' ||
        panel?.kind === 'report' ||
        panel?.kind === 'submission') &&
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
      viewportWidth >= (panel.kind === 'submission' ? 1280 : 1100);
  const attention = selectHomeTasks(state.tasks).attention;
  const attentionCount = attention.length;
  const conversations = recentConversations(state.tasks);
  useEffect(() => {
    const timer = window.setInterval(
      () => setConversationClock(Date.now()),
      60000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (page === 'home') draftTaskId.current = null;
    else if (chatVisible) draftTaskId.current = active.id;
  }, [page, chatVisible, active?.id]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeWorkspace((snapshot) => {
      const next = initialized.current
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
        : snapshot.state;
      initialized.current = true;
      stateRef.current = next;
      setSavedState(next);
      setReady(true);
    });
    const unsubscribeStatus = subscribeRuntimeStatus(setRuntimeStatus);
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
        }),
      );
    } catch {}
  }, [homeInput, homeRefs, homeCapability]);
  useEffect(() => {
    if (!ready) return;
    for (const task of savedState.tasks)
      if (task.activeRunId && !connections.current.has(task.id))
        connectRun(task.id, task.activeRunId);
  }, [ready, savedState.tasks]);
  useEffect(() => {
    try {
      sessionStorage.setItem('cx.agent.local.panel', JSON.stringify(panel));
    } catch {}
  }, [panel]);
  useEffect(() => {
    const resized = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  useEffect(() => {
    document.title = `财小智 · ${pageTitles[page]}`;
  }, [page]);
  useEffect(() => {
    const hash = () => setPage(readPage());
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
      if (e.key === 'Escape' && inlinePanel) closePanel();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [inlinePanel, page, homeInput, homeRefs, homeCapability]);
  useEffect(() => {
    const element = dialog.current;
    if (ready && panel && !inlinePanel) {
      if (element && !element.open) element.showModal();
    } else if (element?.open) element.close();
  }, [ready, panel, inlinePanel]);
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
      const value = await runtimeApi<{
        modelConfigured: boolean;
        model: string;
        framework: string;
      }>('/health');
      if (mounted.current) setHealth(value);
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
  function connectRun(taskId: string, runId: string) {
    if (connections.current.has(taskId)) return;
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
    setStreams((old) => ({ ...old, [taskId]: { runId, text: '' } }));
    const seen = new Set<string>();
    let terminal = false;
    const clear = () => {
      source.close();
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
    event('tool', (value) =>
      setStreams((old) => ({
        ...old,
        [taskId]: {
          ...old[taskId],
          runId,
          text: old[taskId]?.text ?? '',
          activity:
            value.status === 'completed'
              ? ''
              : String(value.label ?? '正在处理'),
        },
      })),
    );
    event('delta', (value) =>
      setStreams((old) => ({
        ...old,
        [taskId]: {
          runId,
          text: (old[taskId]?.text ?? '') + String(value.text ?? ''),
        },
      })),
    );
    event('result', (value) => {
      terminal = true;
      if (value.workspace?.state)
        acceptWorkspace(value.workspace as WorkspaceSnapshot);
    });
    event('error', (value) => {
      terminal = true;
      notify(value.message || '处理失败，请重试。');
    });
    event('done', () => {
      clear();
      void refresh().catch((error) => notify(error.message));
    });
    source.onerror = (error) => {
      if (error instanceof MessageEvent) return;
      if (terminal) {
        clear();
        void refresh().catch(() => {});
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
              void refresh().catch(() => {});
            }
          })
          .catch((error) => {
            if (error.status === 404) {
              clear();
              setRunFailures((old) => ({
                ...old,
                [taskId]: '任务已不可用，请重新发送。',
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
    draftTaskId.current = draft.id;
    setState((current) => ({
      ...current,
      activeTask: draft.id,
      tasks: [draft, ...current.tasks],
    }));
    setHomeInput('');
    setHomeRefs([]);
    setHomeCapability(null);
  }
  function navigate(next: PageId) {
    if (next !== 'home' && next !== 'chat') preserveHomeDraft();
    setPage(next);
    setMobileOpen(false);
    if (location.hash !== `#${next}`) location.hash = next;
  }
  function openPanel(next: PanelSpec) {
    if (!panelRef.current)
      lastFocus.current = document.activeElement as HTMLElement;
    setPanel(next);
  }
  function closePanel() {
    setPanel(null);
    requestAnimationFrame(
      () => lastFocus.current?.isConnected && lastFocus.current.focus(),
    );
  }
  function updateTask(id: string, fn: (task: Task) => Task) {
    setState((s) => ({
      ...s,
      tasks: s.tasks.map((t) => (t.id === id ? fn(t) : t)),
    }));
  }
  function selectTask(id: string) {
    preserveHomeDraft();
    draftTaskId.current = id;
    setState((s) => ({ ...s, activeTask: id }));
    navigate('chat');
    if (mode === 'operations') {
      const t = stateRef.current.tasks.find((t) => t.id === id);
      const card = t?.messages.flatMap((m) => m.cards ?? []).at(-1);
      if (card && card.kind !== 'documents' && card.kind !== 'clarify')
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
    draftTaskId.current = null;
    setState((s) => ({ ...s, activeTask: null }));
    setHomeInput('');
    setHomeRefs([]);
    setHomeCapability(null);
    setPanel(null);
    navigate('home');
  }
  function attach(ref: ContextRef) {
    if (page === 'home') {
      setHomeRefs((current) => [
        ...current.filter(
          (item) =>
            !(
              item.kind === ref.kind &&
              (ref.kind === 'submission' || item.id === ref.id)
            ),
        ),
        ref,
      ]);
      if (ref.kind === 'submission') setHomeCapability('submission');
      closePanel();
      requestAnimationFrame(() =>
        document.getElementById('message-input')?.focus(),
      );
      notify(`已添加「${ref.title}」`);
      return;
    }
    const freshTask = makeTask();
    const targetId = draftTaskId.current ?? freshTask.id;
    // Reserve the draft before React batches consecutive reference additions.
    draftTaskId.current = targetId;
    setState((s) => {
      const existing = s.tasks.find((t) => t.id === targetId);
      const task = existing ?? { ...freshTask, id: targetId };
      const updated = {
        ...task,
        input: existing ? task.input : homeInput,
        capability:
          ref.kind === 'submission'
            ? ('submission' as const)
            : existing
              ? task.capability
              : homeCapability,
        refs: [
          ...(existing ? task.refs : homeRefs).filter(
            (r) =>
              !(
                r.kind === ref.kind &&
                (ref.kind === 'submission' || r.id === ref.id)
              ),
          ),
          ref,
        ],
      };
      return {
        ...s,
        activeTask: task.id,
        tasks: existing
          ? s.tasks.map((t) => (t.id === task.id ? updated : t))
          : [updated, ...s.tasks],
      };
    });
    setHomeInput('');
    setHomeRefs([]);
    setHomeCapability(null);
    closePanel();
    navigate('chat');
    notify(`已引用「${ref.title}」`);
  }
  async function send(text: string, explicitRefs?: ContextRef[]) {
    if (!text.trim() || !ready) return;
    let task =
      page === 'chat'
        ? stateRef.current.tasks.find(
            (t) => t.id === stateRef.current.activeTask,
          )
        : undefined;
    if (!task) {
      task = makeTask(text.slice(0, 24));
      task.capability = page === 'home' ? homeCapability : null;
      setState((current) => ({
        ...current,
        tasks: [task!, ...current.tasks],
        activeTask: task!.id,
      }));
    }
    const id = task.id;
    if (starting.current.has(id) || connections.current.has(id)) return;
    starting.current.add(id);
    setRunFailures((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    const baseRefs = explicitRefs ?? (page === 'chat' ? task.refs : homeRefs);
    const openSubmission =
      panelRef.current?.kind === 'submission' ? panelRef.current : null;
    const refs =
      openSubmission && !explicitRefs
        ? [
            ...baseRefs.filter((ref) => ref.kind !== 'submission'),
            {
              kind: 'submission',
              id: openSubmission.id ?? 'expense',
              title: openSubmission.title,
            },
          ]
        : baseRefs;
    const capability = explicitRefs?.some((ref) => ref.kind === 'document')
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
      input: '',
      capability,
      refs,
      updated: '刚刚',
      messages:
        current.messages.at(-1)?.role === 'user' &&
        current.messages.at(-1)?.text === text
          ? current.messages
          : [
              ...current.messages,
              { id: uid(), role: 'user', text, createdAt: Date.now() },
            ],
    }));
    setHomeInput('');
    setHomeRefs([]);
    setHomeCapability(null);
    navigate('chat');
    setBusyIds((old) => [...old.filter((value) => value !== id), id]);
    try {
      await flushWorkspace();
      const result = await runtimeApi<{ runId: string; taskId: string }>(
        '/runs',
        { taskId: id, message: text, refs, capability },
      );
      connectRun(result.taskId, result.runId);
      await readWorkspace();
    } catch (error) {
      // A lost POST response can still represent a running server task. Reconcile before retrying.
      const snapshot = await readWorkspace().catch(() => null);
      const current = snapshot?.state.tasks.find((task) => task.id === id);
      if (current?.activeRunId) connectRun(id, current.activeRunId);
      else if (!connections.current.has(id)) {
        setBusyIds((old) => old.filter((value) => value !== id));
        const receivedAnswer = current?.messages.at(-1)?.role === 'assistant';
        if (!receivedAnswer) {
          setRunFailures((old) => ({ ...old, [id]: (error as Error).message }));
          updateTask(id, (value) => ({ ...value, input: text }));
        }
      }
      notify((error as Error).message);
    } finally {
      starting.current.delete(id);
    }
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
    if (!active) return;
    const run = connections.current.get(active.id);
    if (!run) return;
    try {
      await runtimeApi(`/runs/${encodeURIComponent(run.runId)}/cancel`, {});
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
    send,
    message,
    notify,
    setTaskStatus: (status) => {
      if (stateRef.current.activeTask)
        updateTask(stateRef.current.activeTask, (t) => ({ ...t, status }));
    },
  };
  const currentInput = chatVisible ? active.input : homeInput,
    currentRefs = chatVisible ? active.refs : homeRefs,
    currentCapability =
      getCapability(chatVisible ? active.capability : homeCapability)?.id ??
      null;
  function selectCapability(capability: CapabilityId | null) {
    if (chatVisible) updateTask(active.id, (task) => ({ ...task, capability }));
    else setHomeCapability(capability);
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
  const composer = (
    <Composer
      capability={currentCapability}
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
          updateTask(active.id, (task) => ({ ...task, refs: add(task.refs) }));
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
      onStop={stop}
      onUpload={upload}
      compact={!!chatVisible}
    />
  );
  const renderedPanel =
    ready && panel ? (
      panel.kind === 'document' ? (
        <DocumentPanel panel={panel} />
      ) : panel.kind === 'materials' ? (
        <MaterialsPanel panel={panel} />
      ) : panel.kind === 'submission' ? (
        <SubmissionPanel panel={panel} />
      ) : panel.kind === 'audit' ? (
        <AuditPanel panel={panel} />
      ) : panel.kind === 'rule' ? (
        <RulesPanel panel={panel} />
      ) : panel.kind === 'analysis' ? (
        <AnalysisPanel panel={panel} />
      ) : panel.kind === 'report' ? (
        <ReportPanel panel={panel} />
      ) : panel.kind === 'skill-picker' ? (
        <SkillPickerPanel />
      ) : panel.kind === 'skill' ? (
        <SkillPanel panel={panel} />
      ) : panel.kind === 'governance' ? (
        <GovernancePanel panel={panel} />
      ) : panel.kind === 'knowledge' ? (
        <KnowledgePanel panel={panel} />
      ) : panel.kind === 'apps' ? (
        <AppsPanel />
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
  const panelHeader = (
    <header className="panel-header">
      <h2 id="panel-title">{panel?.title}</h2>
      <div>
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
          <button className="brand" onClick={newTask} title="财小智">
            <img src={logo} alt="" />
            <span>财小智</span>
          </button>
          <button className="new-task" onClick={newTask} title="新建会话">
            <Icon name="plus" size={17} />
            <span>新建会话</span>
          </button>
          <div className="sidebar-scroll">
            <nav className="nav-group sidebar-apps" aria-label="应用导航">
              {frequentApps
                .map((id) => apps.find((app) => app.id === id)!)
                .filter(Boolean)
                .map((app) => (
                  <button
                    key={app.id}
                    className={`nav-item ${page === app.id ? 'active' : ''}`}
                    onClick={() => {
                      navigate(app.id);
                      closePanel();
                    }}
                    title={app.label}
                  >
                    <Icon name={app.icon} size={17} />
                    <span>{app.label}</span>
                  </button>
                ))}
              <button
                className={`nav-item sidebar-all-apps ${panel?.kind === 'apps' || apps.some((app) => app.id === page && !frequentApps.includes(app.id)) ? 'active' : ''}`}
                onClick={() => {
                  setMobileOpen(false);
                  openPanel({ kind: 'apps', title: '全部应用' });
                }}
                title="全部应用"
              >
                <Icon name="grid" size={17} />
                <span>全部应用</span>
              </button>
            </nav>
            <div className="recent-navigation">
              <div className="nav-label recent-heading">
                <span>最近会话</span>
                <button
                  className={`all-conversations ${page === 'history' ? 'active' : ''}`}
                  aria-label="全部对话"
                  onClick={() => navigate('history')}
                >
                  全部对话
                  <Icon name="chevron" size={12} />
                </button>
              </div>
              <div className="conversation-list">
                {conversations.map((task) => {
                  const status = conversationState(task);
                  const time = lastMessageTime(task);
                  return (
                    <button
                      key={task.id}
                      className={`recent-chat ${active?.id === task.id && page === 'chat' ? 'active' : ''}`}
                      onClick={() => selectTask(task.id)}
                      title={task.title}
                    >
                      <span className="recent-chat-title">
                        {task.title === '新任务' ? '新会话' : task.title}
                      </span>
                      {time !== null && (
                        <time
                          dateTime={new Date(time).toISOString()}
                          title={new Date(time).toLocaleString('zh-CN')}
                        >
                          {formatConversationTime(time).replace(/\s/g, '')}
                        </time>
                      )}
                      <span
                        className={`conversation-state ${status.tone}`}
                        title={status.label}
                        aria-label={status.label}
                      >
                        <Icon name={status.icon} size={14} />
                      </span>
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
            <button
              className={`runtime-status is-${runtimeStatus.state}`}
              onClick={() => void connectRuntime()}
              title={
                runtimeStatus.message ||
                (health
                  ? `${health.framework} · ${health.model}`
                  : '检查本地服务')
              }
            >
              <span aria-hidden="true" />
              {runtimeStatus.state === 'loading'
                ? '正在连接'
                : runtimeStatus.state === 'offline'
                  ? '连接异常 · 重试'
                  : runtimeStatus.state === 'saving'
                    ? '正在保存'
                    : health?.modelConfigured === false
                      ? '模型未配置'
                      : (active && streams[active.id]?.activity) ||
                        '本地服务已连接'}
            </button>
            <div className="profile">
              <span className="avatar">悦</span>
              <div>
                <strong>林悦</strong>
                <small>华川科技 · 财务部</small>
              </div>
            </div>
          </div>
        </aside>
        <main className="main-shell">
          {viewportWidth <= 640 && (
            <header className="mobile-topbar">
              <button
                className="icon-btn"
                aria-label="打开导航"
                aria-controls="workspace-navigation"
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen(true)}
              >
                <Icon name="layout" size={20} />
              </button>
              <strong>财小智</strong>
            </header>
          )}
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
                      className="icon-btn"
                      aria-label="新建会话"
                      onClick={newTask}
                    >
                      <Icon name="plus" size={16} />
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
                    task={active}
                    composer={composer}
                    busy={busyIds.includes(active.id)}
                    onRename={() =>
                      openPanel({ kind: 'rename', title: '重命名会话' })
                    }
                  />
                ) : (
                  <Home
                    composer={composer}
                    onPrepare={prepareDraft}
                    capability={currentCapability}
                    onCapabilityChange={selectCapability}
                  />
                )}
              </div>
              {inlinePanel && (
                <aside
                  className={`inline-detail${panel.kind === 'report' ? ' report-detail' : ''}${panel.kind === 'submission' ? ' submission-detail' : ''}`}
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
                </aside>
              )}
            </div>
          ) : (
            <div className="page-container">
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
                <AnalysisPage />
              ) : page === 'skills' ? (
                <SkillsPage />
              ) : page === 'knowledge' ? (
                <KnowledgePage />
              ) : null}
            </div>
          )}
        </main>
        <button
          className="help-trigger"
          onClick={() => openPanel({ kind: 'help', title: '使用指引' })}
        >
          <Icon name="help" size={14} />
          使用指引
        </button>
        <dialog
          ref={dialog}
          className={`detail-dialog${panel?.kind === 'submission' ? ' submission-dialog' : ''}${panel?.kind === 'report' ? ' report-dialog' : ''}${panel?.kind === 'analysis' ? ' analysis-dialog' : ''}`}
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
