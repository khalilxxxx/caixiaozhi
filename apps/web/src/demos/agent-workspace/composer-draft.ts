// Only unsent text in this browser tab; business records remain server-owned.
const prefix = 'cx.agent.composer.';

function storage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

export function rememberComposerDraft(taskId: string, text: string, target = storage()) {
  try { target?.setItem(prefix + taskId, text); } catch { /* Server saving remains available. */ }
}

export function readComposerDraft(taskId: string, target = storage()): string | null {
  try { return target?.getItem(prefix + taskId) ?? null; } catch { return null; }
}

export function forgetComposerDraft(taskId: string, target = storage()) {
  try { target?.removeItem(prefix + taskId); } catch { /* Best-effort local cleanup. */ }
}
