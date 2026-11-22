import { useSyncExternalStore } from 'react';
import { ApiError } from './runtime-client';

export interface SubmissionAttempt {
  version: number;
  key: string;
  receipt?: { requestId: string; businessId: string };
}

const changed = 'cx-submission-attempt-change';
const storageKey = (id: string) =>
  'cx.agent.pending-submission.' + encodeURIComponent(id);

function parseAttempt(raw: string | null): SubmissionAttempt | null {
  if (!raw) return null;
  try {
    const item = JSON.parse(raw);
    return Number.isSafeInteger(item?.version) &&
      item.version > 0 &&
      typeof item.key === 'string' &&
      item.key
      ? item
      : null;
  } catch {
    return null;
  }
}

function snapshot(id: string) {
  try {
    return window.localStorage.getItem(storageKey(id));
  } catch {
    return null;
  }
}

function subscribe(update: () => void) {
  window.addEventListener(changed, update);
  window.addEventListener('storage', update);
  return () => {
    window.removeEventListener(changed, update);
    window.removeEventListener('storage', update);
  };
}

export function useSubmissionAttempt(id: string) {
  const raw = useSyncExternalStore(
    subscribe,
    () => snapshot(id),
    () => null,
  );
  return parseAttempt(raw);
}

function writeAttempt(id: string, attempt: SubmissionAttempt) {
  try {
    window.localStorage.setItem(storageKey(id), JSON.stringify(attempt));
  } catch {
    throw new Error('未能保存本次提交标识，请允许浏览器保存本地数据后重试。');
  }
  window.dispatchEvent(new Event(changed));
}

export function beginSubmissionAttempt(
  id: string,
  version: number,
): SubmissionAttempt {
  const existing = parseAttempt(snapshot(id));
  if (existing) {
    if (existing.version !== version) throw new Error('请先核实上次提交结果。');
    return existing;
  }
  // A draft version can be accepted only once. Concurrent tabs must use the same intent.
  const attempt = { key: 'browser-submit:' + id + ':' + version, version };
  writeAttempt(id, attempt);
  return attempt;
}

export function recordSubmissionReceipt(
  id: string,
  attempt: SubmissionAttempt,
  receipt: NonNullable<SubmissionAttempt['receipt']>,
) {
  if (parseAttempt(snapshot(id))?.key === attempt.key)
    writeAttempt(id, { ...attempt, receipt });
}

export function clearSubmissionAttempt(id: string, attempt: SubmissionAttempt) {
  if (parseAttempt(snapshot(id))?.key !== attempt.key) return;
  window.localStorage.removeItem(storageKey(id));
  window.dispatchEvent(new Event(changed));
}

export function submitWasRejected(error: unknown) {
  return (
    error instanceof ApiError &&
    [403, 404, 409, 422].includes(error.status) &&
    typeof error.payload?.code === 'string'
  );
}
