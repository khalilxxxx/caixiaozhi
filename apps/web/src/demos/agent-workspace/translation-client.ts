import { api, ApiError } from './runtime-client';
import type { TranslationResult } from './translation-model';

const results = new Map<string, TranslationResult>();
const reads = new Map<string, Promise<TranslationResult | null>>();
const translations = new Map<string, Promise<TranslationResult>>();
function retainResult(
  id: string,
  result: TranslationResult,
): TranslationResult {
  if (
    result.status !== 'completed' ||
    !result.pages?.some((page) =>
      page.blocks?.some(
        (block) => block.source?.trim() && block.target?.trim(),
      ),
    )
  )
    throw new Error('未取得可用译文，请检查原件是否清晰后重试。');
  results.set(id, result);
  return result;
}
export function readTranslation(id: string): Promise<TranslationResult | null> {
  const running = translations.get(id);
  if (running) return running;
  const result = results.get(id);
  if (result) return Promise.resolve(result);
  const reading = reads.get(id);
  if (reading) return reading;
  const promise = api<TranslationResult>(
    `/files/${encodeURIComponent(id)}/translation`,
  )
    .then((value) => retainResult(id, value))
    .catch((error) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    })
    .finally(() => {
      reads.delete(id);
    });
  reads.set(id, promise);
  return promise;
}
export function startTranslation(id: string): Promise<TranslationResult> {
  const result = results.get(id);
  if (result) return Promise.resolve(result);
  const running = translations.get(id);
  if (running) return running;
  const promise = api<TranslationResult>(
    `/files/${encodeURIComponent(id)}/translation`,
    undefined,
    'POST',
  )
    .then((value) => retainResult(id, value))
    .finally(() => {
      translations.delete(id);
    });
  translations.set(id, promise);
  return promise;
}
export function translationIsRunning(id: string): boolean {
  return translations.has(id);
}
