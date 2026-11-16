import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DshRuntimeAdapter,
  readDshModelConfig,
} from '../../packages/agent-runtime/src/dsh/driver.js';
import { RunBudgetsSchema } from '@caixiaozhi/contracts/runs';
import type { RuntimeStart } from '../../packages/agent-runtime/src/adapter.js';

const input: RuntimeStart = {
  run_id: 'isolated-sdk-test',
  thread_id: 'test-thread',
  lease_epoch: 1,
  origin: 'conversation',
  occurrence_id: null,
  context_bundle_ref: 'test',
  profile_version: 'finance-sdk-v1',
  tool_catalog_ref: 'test',
  session_store_ref: 'test',
  budgets: RunBudgetsSchema.parse({}),
};
const tools = [
  {
    name: 'finance.health.read',
    version: '1.0.0',
    description: '读取财务服务健康状态。',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    effect: 'read' as const,
  },
];
async function readFixtureModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  const data = JSON.parse(body || '{}');
  const names = (data.tools ?? []).map(
    (tool: any) => tool.function?.name ?? tool.name,
  );
  if (
    names.some(
      (name: unknown) =>
        typeof name !== 'string' ||
        !/^[a-zA-Z0-9_-]+$/.test(name) ||
        Buffer.byteLength(name) > 64,
    )
  ) {
    response.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message:
            'Function name must match ^[a-zA-Z0-9_-]+$ and fit within 64 bytes.',
        },
      }),
    );
    return null;
  }
  return data;
}
describe('真实 dsh SDK 与受控 profile 的确定性传输验证（模型为显式测试夹具）', () => {
  it('真实SDK工具结果增长后在第二次模型前拒绝超额上下文，网关只收到一次模型请求且无成功答复', async () => {
    let requests = 0,
      dispatches = 0,
      reservations = 0;
    const secretMarker = 'EXPLICIT_PRIVATE_LARGE_TOOL_RESULT';
    const server = createServer((request, response) => {
      void (async () => {
        const data = await readFixtureModelRequest(request, response);
        if (!data) return;
        requests++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta =
          requests === 1
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'large-result-fixture-call',
                    type: 'function',
                    function: {
                      name: data.tools[0].function.name,
                      arguments: '{}',
                    },
                  },
                ],
              }
            : { role: 'assistant', content: '不应通过预算屏障的成功答复。' };
        const chunk = (value: unknown, finish: string | null) => ({
          id: `large-fixture-${requests}`,
          object: 'chat.completion.chunk',
          model: 'fixture-model',
          choices: [{ index: 0, delta: value, finish_reason: finish }],
        });
        response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
        response.write(
          `data: ${JSON.stringify(chunk({}, requests === 1 ? 'tool_calls' : 'stop'))}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      })().catch(() => response.end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('explicit gateway unavailable');
    const root = await mkdtemp(join(tmpdir(), 'finance-dsh-growth-budget-'));
    const adapter = new DshRuntimeAdapter({
      workspaceRoot: root,
      model: () => ({
        apiKey: 'explicit-test-fixture',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        model: 'fixture-model',
        contextWindow: 8192,
        protocol: 'openai-completions',
      }),
      resolveMaterial: async () => ({
        tenant_id: 'explicit-budget-tenant',
        owner_id: 'explicit-budget-owner',
        prompt: '先调用 finance.health.read，再根据结果作答。',
        tools,
        beforeModelCall: async () => {
          reservations++;
        },
        dispatch: async () => {
          dispatches++;
          return {
            status: 'ok',
            data: { large_result: secretMarker.repeat(1000) },
            evidence_refs: [],
            action_id: null,
            error_code: null,
          };
        },
      }),
    });
    let handle;
    try {
      handle = await adapter.start({
        ...input,
        run_id: 'large-result-context-budget',
      });
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(dispatches).toBe(1);
      expect(requests).toBe(1);
      expect(reservations).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'RATE_LIMITED' }),
      );
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === 'response_complete' || event.type === 'idle',
        ),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain(secretMarker);
    } finally {
      if (handle) await adapter.dispose(handle);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
  it.each(['resume_input', 'completed_tools'] as const)(
    '初始%s独自超额时启动前拒绝，未建运行目录或调用显式模型网关',
    async (field) => {
      let requests = 0,
        modelCalls = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(500).end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('explicit gateway unavailable');
      const root = await mkdtemp(join(tmpdir(), 'finance-dsh-initial-budget-')),
        large = '显式初始预算数据'.repeat(1000);
      const adapter = new DshRuntimeAdapter({
        workspaceRoot: root,
        model: () => ({
          apiKey: 'explicit-test-fixture',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
          model: 'fixture-model',
          contextWindow: 8192,
          protocol: 'openai-completions',
        }),
        resolveMaterial: async () => ({
          tenant_id: 'explicit-initial-budget',
          owner_id: 'owner',
          prompt: '仅一条简短问题。',
          tools: [],
          ...(field === 'resume_input'
            ? { resume_input: { user_input: large } }
            : {
                completed_tools: [
                  {
                    call_id: 'prior-completed',
                    name: 'finance.document.get',
                    result: {
                      status: 'ok' as const,
                      data: { content: large },
                      evidence_refs: [],
                      action_id: null,
                      error_code: null,
                    },
                  },
                ],
              }),
          beforeModelCall: async () => {
            modelCalls++;
          },
          dispatch: async () => {
            throw new Error('初始超额不应派发工具。');
          },
        }),
      });
      let handle;
      try {
        await expect(
          adapter
            .start({ ...input, run_id: `initial-${field}-budget` })
            .then((value) => {
              handle = value;
              return value;
            }),
        ).rejects.toMatchObject({
          code: 'RATE_LIMITED',
          details: { reason: 'CONTEXT_BUDGET_EXCEEDED' },
        });
        expect(requests).toBe(0);
        expect(modelCalls).toBe(0);
        expect(await readdir(root)).toEqual([]);
      } finally {
        if (handle) await adapter.dispose(handle);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
    60000,
  );
  it('真实SDK在requires_confirmation后结束本轮，不再调用模型或发送成功答案', async () => {
    let modelCalls = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const data = await readFixtureModelRequest(request, response);
        if (!data) return;
        modelCalls++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = {
          id: 'pause-fixture',
          object: 'chat.completion.chunk',
          model: 'fixture-model',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'pause-call',
                    type: 'function',
                    function: {
                      name: data.tools[0].function.name,
                      arguments: '{}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      })().catch(() => response.end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture unavailable');
    const root = await mkdtemp(join(tmpdir(), 'finance-dsh-pause-'));
    const adapter = new DshRuntimeAdapter({
      workspaceRoot: root,
      model: () => ({
        apiKey: 'explicit-test-fixture',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        model: 'fixture-model',
        contextWindow: 8192,
        protocol: 'openai-completions',
      }),
      resolveMaterial: async () => ({
        tenant_id: 'test',
        owner_id: 'test',
        prompt: '调用finance.action.prepare。',
        tools: [
          { ...tools[0]!, name: 'finance.action.prepare', effect: 'propose' },
        ],
        dispatch: async () => ({
          status: 'requires_confirmation',
          data: { confirmation_id: 'trusted-confirmation' },
          action_id: 'trusted-action',
          evidence_refs: [],
          error_code: null,
        }),
      }),
    });
    let handle;
    try {
      handle = await adapter.start({ ...input, run_id: 'pause-sdk-test' });
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(modelCalls).toBe(1);
      expect(events.find((e) => e.type === 'checkpoint')).toMatchObject({
        checkpoint: {
          stage: 'waiting_confirmation',
          pending_confirmation_id: 'trusted-confirmation',
          action_ids: ['trusted-action'],
        },
      });
      expect(
        events.some((e) => e.type === 'response_complete' || e.type === 'idle'),
      ).toBe(false);
    } finally {
      if (handle) await adapter.dispose(handle);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
  it('实际启动dsh子进程，禁用shell/fs，仅通过财务桥完成tool往返并关闭', async () => {
    let calls = 0;
    let dispatches = 0;
    const names: string[][] = [];
    let modelCalls = 0;
    const receivedPrompts: string[] = [];
    const requestedOutputTokens: number[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const data = await readFixtureModelRequest(request, response);
        if (!data) return;
        receivedPrompts.push(JSON.stringify(data.messages));
        requestedOutputTokens.push(
          Number(data.max_tokens ?? data.max_completion_tokens ?? 0),
        );
        names.push(
          (data.tools ?? []).map(
            (tool: any) => tool.function?.name ?? tool.name,
          ),
        );
        calls++;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const content =
          calls === 1
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'fixture-call-1',
                    type: 'function',
                    function: {
                      name: data.tools[0].function.name,
                      arguments: '{}',
                    },
                  },
                ],
              }
            : { content: '财务服务健康状态已核验。' };
        const message = (delta: unknown, finish_reason: string | null) => ({
          id: `chatcmpl-fixture-${calls}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason }],
        });
        response.write(
          `data: ${JSON.stringify(message({ role: 'assistant', ...content }, null))}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify(message({}, calls === 1 ? 'tool_calls' : 'stop'))}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: `chatcmpl-fixture-${calls}`, object: 'chat.completion.chunk', model: 'fixture-model', choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      })().catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('test gateway unavailable');
    const root = await mkdtemp(join(tmpdir(), '财小智-dsh-sdk-'));
    const adapter = new DshRuntimeAdapter({
      workspaceRoot: root,
      model: () => ({
        apiKey: 'explicit-test-fixture',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        model: 'fixture-model',
        contextWindow: 8192,
        protocol: 'openai-completions',
      }),
      resolveMaterial: async () => ({
        tenant_id: 'test',
        owner_id: 'test',
        prompt: '必须先调用 finance.health.read，再根据工具结果用中文回答。',
        resume_input: {
          message: '新的续接输入',
          receipt: { action_id: 'prior-action', outcome: 'succeeded' },
        },
        completed_tools: [
          {
            call_id: 'completed-before-restart',
            name: 'finance.document.get',
            result: {
              status: 'ok',
              data: { version: 3 },
              evidence_refs: [],
              action_id: null,
              error_code: null,
            },
          },
        ],
        tools,
        beforeModelCall: async () => {
          modelCalls++;
        },
        dispatch: async (request) => {
          expect(request.name).toBe('finance.health.read');
          dispatches++;
          return {
            status: 'ok',
            data: { healthy: true },
            evidence_refs: ['fixture-health'],
            action_id: null,
            error_code: null,
          };
        },
      }),
    });
    let handle;
    try {
      handle = await adapter.start({
        ...input,
        budgets: { ...input.budgets, output_tokens: 25 },
      });
      const events = [];
      for await (const event of handle.events) events.push(event);
      expect(dispatches).toBe(1);
      expect(calls).toBe(2);
      expect(modelCalls).toBe(2);
      expect(receivedPrompts[0]).toContain('新的续接输入');
      expect(receivedPrompts[0]).toContain('prior-action');
      expect(receivedPrompts[0]).toContain('completed-before-restart');
      for (const limit of requestedOutputTokens) {
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(Math.floor(8192 * 0.3));
      }
      expect(requestedOutputTokens).toEqual([25, 15]);
      expect(
        names.every(
          (list) =>
            list.length === 1 &&
            /^[a-zA-Z0-9_-]+$/.test(list[0]!) &&
            Buffer.byteLength(list[0]!) <= 64,
        ),
      ).toBe(true);
      expect(names[0]).toEqual(names[1]);
      const profileFile = (await readdir(root, { recursive: true })).find(
        (file) => file.endsWith('finance-profile.json'),
      );
      if (!profileFile) throw new Error('显式SDK测试未生成工具桥配置。');
      const patches = JSON.parse(
        await readFile(join(root, profileFile), 'utf8'),
      );
      const bridge = patches
        .flatMap((patch: any) => patch.insert ?? [])
        .find((plugin: any) => plugin.id === 'finance-tool-bridge').config;
      const configuredWireName = names[0]![0]!;
      expect(bridge.tools[0]).toMatchObject({
        name: 'finance.health.read',
        wire_name: configuredWireName,
        version: '1.0.0',
      });
      const unknownWireName = `${configuredWireName.slice(0, -1)}${configuredWireName.endsWith('A') ? 'B' : 'A'}`;
      for (const deniedCall of [
        { name: 'finance.health.read', version: '1.0.0' },
        { name: unknownWireName, version: '1.0.0' },
        { name: configuredWireName, version: 'other-version' },
      ]) {
        const denied = await fetch(`${bridge.endpoint}/tool`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bridge.token}`,
          },
          body: JSON.stringify({
            ...deniedCall,
            call_id: 'explicit-denied-call',
            arguments: {},
          }),
        });
        expect(denied.status).toBe(403);
      }
      expect(dispatches).toBe(1);
      expect(events.some((event) => event.type === 'response_delta')).toBe(
        true,
      );
      expect(
        events.find((event) => event.type === 'response_complete'),
      ).toMatchObject({ text: '财务服务健康状态已核验。' });
      await adapter.dispose(handle);
      handle = undefined;
    } finally {
      if (handle) await adapter.dispose(handle);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
  it('点号与下划线工具使用互异短别名，历史回传和目录换序续接保持绑定', async () => {
    const canonicalTools = [
      { ...tools[0]!, name: 'finance.a.b' },
      { ...tools[0]!, name: 'finance.a_b' },
      { ...tools[0]!, name: `finance.${'long_capability_name_'.repeat(8)}` },
    ];
    const requests: Array<{
      names: string[];
      descriptions: string[];
      messages: any[];
    }> = [];
    const dispatched: string[] = [];
    let materialRequests = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const data = await readFixtureModelRequest(request, response);
        if (!data) return;
        const names = data.tools.map((tool: any) => tool.function.name);
        requests.push({
          names,
          descriptions: data.tools.map(
            (tool: any) => tool.function.description,
          ),
          messages: data.messages,
        });
        const hasToolResults = data.messages.some(
          (message: any) => message.role === 'tool',
        );
        const delta = hasToolResults
          ? { role: 'assistant', content: '规范财务能力已核验。' }
          : {
              role: 'assistant',
              tool_calls: names.map((name: string, index: number) => ({
                index,
                id: `alias-fixture-call-${index}`,
                type: 'function',
                function: { name, arguments: '{}' },
              })),
            };
        const chunk = (value: unknown, finish_reason: string | null) => ({
          id: `alias-fixture-${requests.length}`,
          object: 'chat.completion.chunk',
          model: 'fixture-model',
          choices: [{ index: 0, delta: value, finish_reason }],
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
        response.write(
          `data: ${JSON.stringify(chunk({}, hasToolResults ? 'stop' : 'tool_calls'))}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      })().catch(() => response.end());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('显式别名测试网关不可用。');
    const root = await mkdtemp(join(tmpdir(), 'finance-dsh-wire-alias-'));
    const adapter = new DshRuntimeAdapter({
      workspaceRoot: root,
      model: () => ({
        apiKey: 'explicit-test-fixture',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        model: 'fixture-model',
        contextWindow: 32768,
        protocol: 'openai-completions',
      }),
      resolveMaterial: async () => {
        materialRequests++;
        return {
          tenant_id: 'alias-test',
          owner_id: 'alias-owner',
          prompt: '调用已注册的规范财务能力。',
          tools:
            materialRequests === 1
              ? canonicalTools
              : [...canonicalTools].reverse(),
          completed_tools: [
            {
              call_id: 'canonical-before-resume',
              name: canonicalTools[0]!.name,
              result: {
                status: 'ok' as const,
                data: { verified: true },
                evidence_refs: [],
                action_id: null,
                error_code: null,
              },
            },
          ],
          dispatch: async (call) => {
            dispatched.push(call.name);
            return {
              status: 'ok' as const,
              data: { canonical_name: call.name },
              evidence_refs: [],
              action_id: null,
              error_code: null,
            };
          },
        };
      },
    });
    let handle;
    try {
      for (const lease_epoch of [1, 2]) {
        handle =
          lease_epoch === 1
            ? await adapter.start({
                ...input,
                run_id: 'stable-alias-run',
                lease_epoch,
              })
            : await adapter.continue({
                ...input,
                run_id: 'stable-alias-run',
                lease_epoch,
                checkpoint_id: 'explicit-alias-checkpoint',
              });
        const events = [];
        for await (const event of handle.events) events.push(event);
        expect(
          events
            .filter((event) => event.type === 'tool_call')
            .map((event) => event.name)
            .sort(),
        ).toEqual(canonicalTools.map((tool) => tool.name).sort());
        expect(
          events.find((event) => event.type === 'response_complete'),
        ).toMatchObject({ text: '规范财务能力已核验。' });
        expect(events.some((event) => event.type === 'error')).toBe(false);
        await adapter.dispose(handle);
        handle = undefined;
      }
      expect(requests).toHaveLength(4);
      expect(dispatched.sort()).toEqual(
        canonicalTools.flatMap((tool) => [tool.name, tool.name]).sort(),
      );
      const originalBindings = new Map<string, string>();
      for (const request of requests) {
        expect(new Set(request.names).size).toBe(canonicalTools.length);
        for (const [index, name] of request.names.entries()) {
          expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
          expect(Buffer.byteLength(name)).toBeLessThanOrEqual(64);
          const canonicalTool = canonicalTools.find((tool) =>
            request.descriptions[index]!.includes(
              `${tool.name}@${tool.version}`,
            ),
          );
          expect(canonicalTool).toBeTruthy();
          const key = canonicalTool!.name;
          if (originalBindings.has(key))
            expect(name).toBe(originalBindings.get(key));
          else originalBindings.set(key, name);
        }
      }
      for (const request of [requests[1]!, requests[3]!]) {
        const assistant = request.messages.find(
          (message) =>
            message.role === 'assistant' && message.tool_calls?.length,
        );
        expect(
          assistant.tool_calls.map((call: any) => call.function.name).sort(),
        ).toEqual([...request.names].sort());
        expect(JSON.stringify(request.messages)).toContain(
          'canonical-before-resume',
        );
      }
      expect(originalBindings.get('finance.a.b')).not.toBe(
        originalBindings.get('finance.a_b'),
      );
    } finally {
      if (handle) await adapter.dispose(handle);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

// 由 pnpm test:agent:real 显式启用；缺配置必须失败退出，不能 skip 成绿色。
describe.runIf(process.env.AGENT_REAL_TEST === '1')(
  '真实内网模型验收（绝不使用确定性模型夹具）',
  () => {
    it('dsh_real_tool_roundtrip', async () => {
      const model = readDshModelConfig();
      const root = await mkdtemp(join(tmpdir(), 'finance-dsh-real-'));
      let dispatches = 0;
      const adapter = new DshRuntimeAdapter({
        workspaceRoot: root,
        model: () => model,
        resolveMaterial: async () => ({
          tenant_id: 'real-integration',
          owner_id: 'real-tester',
          prompt:
            '先调用 finance.health.read，然后用中文简述其返回的真实验证标识，不调用其他工具。',
          tools,
          dispatch: async () => {
            dispatches++;
            return {
              status: 'ok',
              data: {
                healthy: true,
                verification_id: 'caixiaozhi-health-readonly',
              },
              evidence_refs: ['health-readonly'],
              action_id: null,
              error_code: null,
            };
          },
        }),
      });
      let handle;
      try {
        handle = await adapter.start({
          ...input,
          run_id: 'real-sdk-roundtrip',
        });
        const events = [];
        for await (const event of handle.events) events.push(event);
        expect(dispatches).toBeGreaterThan(0);
        expect(events.some((event) => event.type === 'response_complete')).toBe(
          true,
        );
        expect(events.some((event) => event.type === 'error')).toBe(false);
      } finally {
        if (handle) await adapter.dispose(handle);
        await rm(root, { recursive: true, force: true });
      }
    }, 150000);
  },
);
