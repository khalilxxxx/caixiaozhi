import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Task,
  WorkspaceState,
} from '../../apps/web/src/demos/agent-workspace/workspace';

const task = (): Task => ({
  id: 't1',
  title: '会话',
  status: '待开始',
  type: 'chat',
  messages: [],
  input: '',
  refs: [],
  updated: '刚刚',
});
const state = (): WorkspaceState => ({
  data: {
    submissions: {
      drafts: { expense: { title: '原草稿', version: 1 } },
      edits: {},
    },
  },
  tasks: [task()],
  activeTask: 't1',
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('本地运行时并发保存', () => {
  it('只重放用户更改的草稿字段，保留工具产生的版本、消息和其他单据', async () => {
    const { rebaseWorkspaceValue } =
      await import('../../apps/web/src/demos/agent-workspace/runtime-client');
    const before = state(),
      after = structuredClone(before),
      remote = structuredClone(before);
    after.data.submissions.edits.expense = { title: '未保存输入' };
    after.tasks[0]!.input = '继续追问';
    remote.data.submissions.drafts.expense.version = 2;
    remote.data.submissions.drafts.travel = { title: '新差旅' };
    remote.tasks[0]!.messages.push({
      id: 'assistant-run',
      role: 'assistant',
      text: '已生成草稿',
    });
    const merged = rebaseWorkspaceValue(before, after, remote);
    expect(merged.data.submissions.drafts.expense.version).toBe(2);
    expect(merged.data.submissions.drafts.travel.title).toBe('新差旅');
    expect(merged.data.submissions.edits.expense.title).toBe('未保存输入');
    expect(merged.tasks[0].messages[0].id).toBe('assistant-run');
    expect(merged.tasks[0].input).toBe('继续追问');
  });

  it('409 后以最新修订重放增量，不覆盖运行新增的字段和消息', async () => {
    const client =
      await import('../../apps/web/src/demos/agent-workspace/runtime-client');
    const initial = state(),
      latest = structuredClone(initial);
    latest.data.submissions.drafts.expense.version = 2;
    latest.tasks[0]!.messages.push({
      id: 'assistant-run',
      role: 'assistant',
      text: '结果',
    });
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        bodies.push(body);
        if (bodies.length === 1)
          return response(
            { message: '版本更新', state: latest, revision: 2 },
            409,
          );
        return response({
          state: {
            ...latest,
            data: { ...latest.data, ...body.data },
            tasks: body.tasks,
          },
          revision: 3,
        });
      }),
    );
    client.acceptWorkspace({ state: initial, revision: 1 });
    const changed = structuredClone(initial.data.submissions);
    changed.edits.expense = { title: '人工修改' };
    client.saveWorkspace({
      data: { submissions: changed },
      tasks: [{ ...initial.tasks[0]!, input: '下一句' }],
    });
    await client.flushWorkspace();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].baseRevision).toBe(2);
    expect(bodies[1].data.submissions.drafts.expense.version).toBe(2);
    expect(bodies[1].data.submissions.edits.expense.title).toBe('人工修改');
    expect(bodies[1].tasks[0].messages[0].id).toBe('assistant-run');
  });

  it('保存尚未返回时输入的新变更继续排队，不被首次回执覆盖', async () => {
    const client =
      await import('../../apps/web/src/demos/agent-workspace/runtime-client');
    let release!: (value: Response) => void;
    const bodies: any[] = [];
    let current = state();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body));
        bodies.push(body);
        current = { ...current, tasks: body.tasks };
        if (bodies.length === 1)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return response({ state: current, revision: 3 });
      }),
    );
    client.acceptWorkspace({ state: current, revision: 1 });
    client.saveWorkspace({
      tasks: [{ ...current.tasks[0]!, input: '第一句' }],
    });
    const flush = client.flushWorkspace();
    client.saveWorkspace({
      tasks: [{ ...current.tasks[0]!, input: '第二句' }],
    });
    release(response({ state: current, revision: 2 }));
    await flush;
    expect(bodies).toHaveLength(2);
    expect(bodies[1].baseRevision).toBe(2);
    expect(bodies[1].tasks[0].input).toBe('第二句');
  });
  it('服务端修正草稿版本和保护字段后直接接纳回执，不循环保存旧值', async () => {
    const client =
      await import('../../apps/web/src/demos/agent-workspace/runtime-client');
    const initial = state();
    let observed: any;
    client.acceptWorkspace({ state: initial, revision: 1 });
    client.subscribeWorkspace((snapshot) => {
      observed = snapshot;
    });
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      const corrected = { ...initial, data: { ...initial.data, ...body.data } };
      corrected.data.submissions.drafts.expense.version = 2;
      corrected.data.submissions.checks = {};
      return response({ state: corrected, revision: 2 });
    });
    vi.stubGlobal('fetch', fetcher);
    const changed = structuredClone(initial.data.submissions);
    changed.drafts.expense.title = '修订草稿';
    changed.drafts.expense.version = 99;
    changed.checks = { expense: { version: 99 } };
    client.saveWorkspace({ data: { submissions: changed } });
    await client.flushWorkspace();
    await client.flushWorkspace();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(observed.state.data.submissions.drafts.expense.version).toBe(2);
    expect(observed.state.data.submissions.checks).toEqual({});
  });
});
