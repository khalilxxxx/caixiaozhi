import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts';
import type { RunCheckpoint } from '@caixiaozhi/contracts/runs';
import { AppError } from '@caixiaozhi/platform/errors';

export type ContextEntry = {
  id: string;
  version: number;
  text: string;
  kind:
    | 'constraint'
    | 'permission'
    | 'skill'
    | 'task'
    | 'resource'
    | 'memory'
    | 'history'
    | 'input';
  required?: boolean;
};
export async function buildContext(input: {
  actor: ActorContext;
  freshActor: (actor: ActorContext) => Promise<ActorContext>;
  load: (actor: ActorContext) => Promise<ContextEntry[]>;
  contextLimit: number;
  checkpoint?: RunCheckpoint | null;
  /** 由可信调用方提供：稍后追加的工具、续接内容、固定提示等，计入同一个输入预算。 */
  reservedText?: string;
}) {
  const actor = await input.freshActor(input.actor);
  const entries = await input.load(actor);
  if (!Number.isSafeInteger(input.contextLimit) || input.contextLimit < 100)
    throw new AppError(
      'DEPENDENCY_UNAVAILABLE',
      '模型上下文上限尚未正确配置。',
    );
  const rank = [
    'constraint',
    'permission',
    'skill',
    'task',
    'resource',
    'memory',
    'history',
    'input',
  ];
  entries.sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind));
  const budget = Math.floor(input.contextLimit * 0.7);
  // 中文/混合输入按 UTF-8 字节估算，保守地每字节一 token；超限明确退出。
  const checkpointText = input.checkpoint
    ? `\n\n[已保存的结构化状态]\n${JSON.stringify(input.checkpoint)}`
    : '';
  const render = (items: ContextEntry[]) =>
    items
      .map((e) => `[${e.kind}:${e.id}@${e.version}]\n${e.text}`)
      .join('\n\n') + checkpointText;
  const size = (items: ContextEntry[]) =>
    Buffer.byteLength(render(items) + (input.reservedText ?? ''), 'utf8');
  const selected = [...entries];
  for (const kind of ['history', 'memory', 'resource']) {
    for (let i = selected.length - 1; i >= 0 && size(selected) > budget; i--) {
      if (selected[i]?.kind === kind && !selected[i]?.required)
        selected.splice(i, 1);
    }
  }
  if (size(selected) > budget)
    throw new AppError(
      'RATE_LIMITED',
      '任务上下文超出模型预算，请缩小处理范围。',
      { details: { reason: 'CONTEXT_BUDGET_EXCEEDED' } },
    );
  return {
    actor,
    entries: selected,
    prompt: render(selected),
    resource_refs: [] as ResourceRef[],
    authz_version: actor.authz_version,
  };
}
