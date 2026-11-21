import { createContext, useContext } from 'react';
import type { CapabilityId, ExpertTeamId } from './capability-model';
import type { BusinessBoardScope } from './business-board-model';
import type { ToolStep } from './run-progress-model';
import type { WorkDocument } from './work-document-model';
import type {
  ClarificationQuestion,
  QuestionAnswerInput,
} from './question-model';

export type PageId =
  | 'home'
  | 'chat'
  | 'history'
  | 'documents'
  | 'submission'
  | 'rules'
  | 'analysis'
  | 'skills'
  | 'light-apps'
  | 'todos'
  | 'schedules'
  | 'knowledge'
  | 'files';
export interface PanelSpec {
  kind: string;
  title: string;
  id?: string;
  data?: Record<string, any>;
}
export interface ContextRef {
  kind: string;
  id: string;
  title: string;
  version?: string;
  fileIds?: string[];
  scope?: BusinessBoardScope;
  followupId?: string;
}
export interface ResultCard {
  kind: string;
  title: string;
  subtitle?: string;
  status?: string;
  tone?: string;
  id?: string;
  data?: Record<string, any>;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards?: ResultCard[];
  submissionPhase?: 'collecting' | 'ready';
  tools?: ToolStep[];
  runId?: string;
  capability?: CapabilityId | null;
  expertTeamName?: string | null;
  runStatus?: string;
  time?: string;
  createdAt?: number;
  question?: ClarificationQuestion;
  questionAnswer?: QuestionAnswerInput;
}
export interface Task {
  id: string;
  title: string;
  status: string;
  type: string;
  messages: ChatMessage[];
  input: string;
  refs: ContextRef[];
  capability?: CapabilityId | null;
  expertTeamName?: string | null;
  updated: string;
  activeRunId?: string | null;
}
export interface WorkspaceState {
  data: Record<string, any>;
  tasks: Task[];
  activeTask: string | null;
}
export interface WorkspaceAPI {
  state: WorkspaceState;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
  updateData: <T>(
    key: string,
    next: T | ((previous: T | undefined) => T),
  ) => void;
  openPanel: (panel: PanelSpec) => void;
  closePanel: () => void;
  navigate: (page: PageId, hash?: string) => void;
  attach: (ref: ContextRef) => void;
  discussAuditDocument: (doc: WorkDocument) => void;
  selectSkill: (ref: ContextRef) => void;
  summonExpertTeam: (id: ExpertTeamId, prompt?: string, teamName?: string) => void;
  send: (text: string, refs?: ContextRef[]) => void;
  answerQuestion: (answer: QuestionAnswerInput) => Promise<void>;
  message: (text: string, cards?: ResultCard[]) => void;
  notify: (text: string) => void;
  setTaskStatus: (status: string) => void;
}
export const WorkspaceContext = createContext<WorkspaceAPI | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace provider missing');
  return value;
}
export function useSlice<T>(
  key: string,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const w = useWorkspace();
  const current = (w.state.data[key] as T | undefined) ?? initial;
  return [
    current,
    (next) =>
      w.updateData<T>(key, (previous) =>
        typeof next === 'function'
          ? (next as (p: T) => T)(previous ?? initial)
          : next,
      ),
  ];
}
