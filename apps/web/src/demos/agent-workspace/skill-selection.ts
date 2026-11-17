import type { CapabilityId } from './capability-model';
import type { ContextRef, WorkspaceState } from './workspace';

interface HomeDraft {
  input: string;
  refs: ContextRef[];
  capability: CapabilityId | null;
}

const draftTargetKey = 'cx.agent.local.skillDraftTarget';

export function readSkillDraftTarget(
  storage?: Pick<Storage, 'getItem'>,
): string | null {
  try {
    const target: unknown = JSON.parse(
      (storage ?? sessionStorage).getItem(draftTargetKey) ?? 'null',
    );
    return typeof target === 'string' && target.trim() ? target : null;
  } catch {
    return null;
  }
}

export function saveSkillDraftTarget(
  targetId: string | null,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    // Explicit null records the home draft, even when an older task is active.
    (storage ?? sessionStorage).setItem(
      draftTargetKey,
      JSON.stringify(targetId),
    );
  } catch {
    // The current in-memory draft remains usable when storage is unavailable.
  }
}

export function selectSkillDraft(
  state: WorkspaceState,
  home: HomeDraft,
  targetId: string | null,
  skill: ContextRef,
): { state: WorkspaceState; home: HomeDraft; page: 'home' | 'chat' } {
  const add = (refs: ContextRef[]) => [
    ...refs.filter((ref) => ref.kind !== skill.kind || ref.id !== skill.id),
    skill,
  ];
  const target = targetId
    ? state.tasks.find((task) => task.id === targetId)
    : undefined;
  if (!target)
    return { state, home: { ...home, refs: add(home.refs) }, page: 'home' };
  return {
    state: {
      ...state,
      activeTask: target.id,
      tasks: state.tasks.map((task) =>
        task.id === target.id ? { ...task, refs: add(task.refs) } : task,
      ),
    },
    home,
    page: 'chat',
  };
}
