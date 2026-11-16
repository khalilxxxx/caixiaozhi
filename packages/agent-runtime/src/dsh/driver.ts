import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { AppError } from '@caixiaozhi/platform/errors';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import type {
  AgentRuntimeAdapter,
  NormalizedRuntimeEvent,
  RuntimeCapabilities,
  RuntimeContinue,
  RuntimeHandle,
  RuntimeMaterial,
  RuntimeStart,
  StopReason,
  StopResult,
} from '../adapter.js';
import { createWorkspace } from '../workspace.js';
import {
  FINANCE_SYSTEM_PROMPT,
  renderRuntimePrompt,
  assertRuntimeContextBudget,
} from '../context/prompt.js';

export const DSH_VERSION = '0.2.2-rc.1';
export const FINANCE_PROFILE_VERSION = 'finance-sdk-v1';
export type DshModelConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindow: number;
  protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
};
export function readDshModelConfig(
  env: NodeJS.ProcessEnv = process.env,
): DshModelConfig {
  const missing = [
    'DSH_API_KEY',
    'DSH_BASE_URL',
    'DSH_MODEL',
    'DSH_CONTEXT_WINDOW',
  ].filter((key) => !env[key]?.trim());
  if (missing.length)
    throw new AppError('DEPENDENCY_UNAVAILABLE', '模型服务未配置。', {
      details: { reason: 'MODEL_NOT_CONFIGURED', missing },
    });
  const contextWindow = Number(env.DSH_CONTEXT_WINDOW);
  const protocol = env.DSH_API_PROTOCOL ?? 'openai-completions';
  const url = new URL(env.DSH_BASE_URL!);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < 1024 ||
    !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(
      protocol,
    )
  )
    throw new AppError(
      'DEPENDENCY_UNAVAILABLE',
      '模型配置无效，请检查协议、地址和上下文上限。',
    );
  return {
    apiKey: env.DSH_API_KEY!,
    baseURL: url.href.replace(/\/$/, ''),
    model: env.DSH_MODEL!,
    contextWindow,
    protocol: protocol as DshModelConfig['protocol'],
  };
}
export function assertDshNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if ((major ?? 0) < 24 || (major === 24 && (minor ?? 0) < 9))
    throw new AppError(
      'DEPENDENCY_UNAVAILABLE',
      'dsh 需要 Node.js 24.9.0 或更高版本。',
      { details: { reason: 'RUNTIME_VERSION_UNSUPPORTED' } },
    );
}
class EventQueue implements AsyncIterable<NormalizedRuntimeEvent> {
  private values: NormalizedRuntimeEvent[] = [];
  private waiting: Array<
    (value: IteratorResult<NormalizedRuntimeEvent>) => void
  > = [];
  private ended = false;
  push(value: NormalizedRuntimeEvent) {
    if (this.ended) return;
    const resolve = this.waiting.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }
  end() {
    this.ended = true;
    for (const resolve of this.waiting.splice(0))
      resolve({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<NormalizedRuntimeEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
type Instance = {
  harness: DeepSeekHarness;
  queue: EventQueue;
  server: Server;
  pending: Set<string>;
  settled: boolean;
  close?: Promise<void>;
};

// 可信静态插件，只接受宿主生成的 loopback 地址；不读取会话凭据、文件或 shell。
const bridgeSource = String.raw`
export const name = 'caixiaozhi-finance-bridge';
export const inject = ['tools', 'llm'];
export function apply(ctx, config) {
  const boundedRequests=new WeakSet();
  async function send(path, body, signal) {
    const response = await fetch(config.endpoint + path, {method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+config.token}, body:JSON.stringify(body), signal});
    if (!response.ok) throw new Error('FINANCE_GATEWAY_REJECTED');
    return response.json();
  }
  ctx.on('llm/stream', async function* (options, next) {
    if(boundedRequests.has(options)){yield* next();return;}
    const allocation=await send('/model', {input_bytes:Buffer.byteLength(JSON.stringify({messages:options.messages,system:options.system,tools:options.tools}),'utf8')}, options.signal);
    const bounded={...options,maxTokens:Math.min(options.maxTokens??allocation.max_output_tokens,allocation.max_output_tokens)};
    boundedRequests.add(bounded);
    try { for await (const chunk of this.stream(bounded)) {
      if (chunk.type === 'text-delta') await send('/event', {type:'response_delta',text:chunk.text}, options.signal);
      if (chunk.type === 'usage') await send('/event', {type:'usage',input_tokens:chunk.usage.inputTokens,output_tokens:chunk.usage.outputTokens,cached_tokens:chunk.usage.cacheReadTokens||0,model_calls:0}, options.signal);
      yield chunk;
    }} finally {boundedRequests.delete(bounded);}
  });
  for (const tool of config.tools) {
    ctx.tools.register({name:tool.wire_name,description:tool.description+'\n规范能力：'+tool.name+'@'+tool.version,parameters:tool.input_schema,
      output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(args, exec)=>{
        const envelope=await send('/tool',{name:tool.wire_name,version:tool.version,arguments:args,call_id:exec.callId},exec.signal);
        if(envelope.suspend)exec.concludeTurn();
        return envelope.result;
      }
    });
  }
}
`;

export class DshRuntimeAdapter implements AgentRuntimeAdapter {
  readonly capabilities: RuntimeCapabilities = {
    native_prompt_cancel: false,
    process_per_run: true,
    session_persistence: 'jsonl',
    semantic_resume: 'application_checkpoint',
    profile_version: FINANCE_PROFILE_VERSION,
    sdk_version: DSH_VERSION,
  };
  private instances = new Map<string, Instance>();
  constructor(
    private readonly options: {
      workspaceRoot: string;
      resolveMaterial: (input: RuntimeStart) => Promise<RuntimeMaterial>;
      model?: () => DshModelConfig;
    },
  ) {}
  async start(input: RuntimeStart): Promise<RuntimeHandle> {
    assertDshNodeVersion();
    const model = (this.options.model ?? readDshModelConfig)();
    const maxOutputTokens = Math.min(
      16000,
      input.budgets.output_tokens,
      Math.floor(model.contextWindow * 0.3),
    );
    const material = await this.options.resolveMaterial(input);
    // 别名只用于模型协议，按规范名称与版本生成，续接和目录换序不会改变绑定。
    const wireTools = material.tools.map((tool) => ({
      ...tool,
      wire_name: `finance_${createHash('sha256')
        .update(JSON.stringify([tool.name, tool.version]))
        .digest('base64url')}`,
    }));
    const toolsByWire = new Map(
      wireTools.map((tool) => [
        tool.wire_name,
        { name: tool.name, version: tool.version },
      ]),
    );
    if (toolsByWire.size !== wireTools.length)
      throw new AppError('INVALID_STATE', '模型工具别名冲突，不能启动运行。');
    const prompt = renderRuntimePrompt(material);
    assertRuntimeContextBudget(
      Buffer.byteLength(
        JSON.stringify({
          system: FINANCE_SYSTEM_PROMPT,
          prompt,
          tools: material.tools,
        }),
        'utf8',
      ),
      model.contextWindow,
    );
    const workspace = await createWorkspace(this.options.workspaceRoot, {
      tenant_id: material.tenant_id,
      owner_id: material.owner_id,
      run_id: input.run_id,
      lease_epoch: input.lease_epoch,
    });
    await mkdir(workspace.home, { mode: 0o700 });
    const queue = new EventQueue();
    const token = randomBytes(32).toString('hex');
    const pending = new Set<string>();
    let modelCalls = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let suspended = false;
    let bridgeFailed = false;
    const server = createServer((request, response) => {
      void (async () => {
        if (
          request.method !== 'POST' ||
          request.headers.authorization !== `Bearer ${token}`
        ) {
          response.writeHead(403).end();
          return;
        }
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 131072) {
            response.writeHead(413).end();
            return;
          }
        }
        const data = JSON.parse(body || '{}') as Record<string, any>;
        await input.assert_model_slot?.();
        await material.validateContext?.();
        if (request.url === '/model') {
          assertRuntimeContextBudget(data.input_bytes, model.contextWindow);
          if (suspended)
            throw new AppError(
              'INVALID_STATE',
              '任务已保存检查点，正在等待后续事件。',
            );
          if (
            modelCalls >= input.budgets.model_calls ||
            outputTokens >= input.budgets.output_tokens
          )
            throw new AppError('RATE_LIMITED', '任务已达模型预算。');
          await material.beforeModelCall?.();
          if (!material.beforeModelCall)
            queue.push({
              type: 'usage',
              input_tokens: 0,
              output_tokens: 0,
              cached_tokens: 0,
              model_calls: 1,
            });
          modelCalls++;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              max_output_tokens: Math.min(
                maxOutputTokens,
                input.budgets.output_tokens - outputTokens,
              ),
            }),
          );
          return;
        }
        if (request.url === '/event') {
          if (data.type === 'response_delta' && typeof data.text === 'string')
            queue.push({ type: 'response_delta', text: data.text });
          else if (
            data.type === 'usage' &&
            [
              'input_tokens',
              'output_tokens',
              'cached_tokens',
              'model_calls',
            ].every((k) => Number.isSafeInteger(data[k]) && data[k] >= 0)
          ) {
            outputTokens += data.output_tokens;
            queue.push(data as NormalizedRuntimeEvent);
          } else {
            response.writeHead(400).end();
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end('{}');
          return;
        }
        if (
          request.url !== '/tool' ||
          typeof data.call_id !== 'string' ||
          typeof data.name !== 'string' ||
          typeof data.version !== 'string'
        ) {
          response.writeHead(400).end();
          return;
        }
        const binding = toolsByWire.get(data.name);
        const tool =
          binding?.version === data.version
            ? material.tools.find(
                (candidate) =>
                  candidate.name === binding.name &&
                  candidate.version === binding.version,
              )
            : undefined;
        if (!tool) {
          response.writeHead(403).end();
          return;
        }
        if (toolCalls >= input.budgets.tool_calls)
          throw new AppError('RATE_LIMITED', '任务已达工具预算。');
        toolCalls++;
        const callId = `${input.run_id}:${data.call_id}`;
        pending.add(callId);
        queue.push({ type: 'tool_call', call_id: callId, name: tool.name });
        try {
          const call = {
            call_id: callId,
            name: tool.name,
            version: tool.version,
            arguments: data.arguments,
          };
          const result = await material.dispatch(call);
          let checkpoint =
            (await material.afterToolResult?.(call, result)) ?? null;
          if (!checkpoint && result.status === 'requires_confirmation') {
            const values = result.data as Record<string, unknown> | null;
            const confirmationId = values?.confirmation_id;
            if (typeof confirmationId !== 'string')
              throw new AppError(
                'INVALID_STATE',
                '确认意图缺少服务端确认标识。',
              );
            checkpoint = CheckpointSchema.parse({
              stage: 'waiting_confirmation',
              pending_confirmation_id: confirmationId,
              completed_call_ids: [callId],
              action_ids: result.action_id ? [result.action_id] : [],
            });
          }
          if (!checkpoint && result.status === 'requires_input')
            checkpoint = CheckpointSchema.parse({
              stage: 'waiting_user',
              pending_input_schema:
                typeof result.data === 'object' &&
                result.data !== null &&
                (result.data as Record<string, unknown>).input_schema
                  ? (result.data as Record<string, unknown>).input_schema
                  : {},
              completed_call_ids: [callId],
            });
          if (!checkpoint && result.status === 'unknown')
            checkpoint = CheckpointSchema.parse({
              stage: 'reconciling',
              recovery_mode: 'receipt_only',
              completed_call_ids: [callId],
              action_ids: result.action_id ? [result.action_id] : [],
            });
          if (checkpoint) {
            suspended = true;
            queue.push({
              type: 'checkpoint',
              checkpoint: CheckpointSchema.parse(checkpoint),
            });
          }
          const output = JSON.stringify(result);
          if (Buffer.byteLength(output) > 131072)
            throw new AppError('INVALID_STATE', '工具结果超出大小限制。');
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({ result, suspend: Boolean(checkpoint) }),
          );
        } finally {
          pending.delete(callId);
        }
      })().catch((error: unknown) => {
        if (!bridgeFailed) {
          bridgeFailed = true;
          queue.push({
            type: 'error',
            code:
              error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
            message:
              error instanceof AppError && error.code === 'RATE_LIMITED'
                ? '任务已达到模型或上下文预算，请缩小处理范围。'
                : '运行上下文或工具依赖不可用。',
          });
        }
        if (!response.headersSent) response.writeHead(503);
        response.end('{"error":"DEPENDENCY_UNAVAILABLE"}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new AppError('DEPENDENCY_UNAVAILABLE', '工具桥启动失败。');
    const pluginPath = join(workspace.path, 'finance-bridge.mjs');
    await writeFile(pluginPath, bridgeSource, { mode: 0o600 });
    const disabled = [
      'persistent-bash',
      'persistent-pwsh',
      'tool-fs',
      'tool-working-directory',
      'image-offload',
      'compaction-basic',
      'llm-deepseek',
    ];
    const patches: unknown[] = [
      ...disabled.map((id) => ({ id, disabled: true })),
      { id: 'session-title', disabled: true },
      { id: 'llm-retry', disabled: true },
      {
        insert: [
          {
            id: 'finance-gateway-model',
            name: '@deepseek-ai/dsh-llm-pi-ai',
            config: {
              providers: {
                'finance-gateway': {
                  api: model.protocol,
                  apiKeyEnv: 'DSH_API_KEY',
                  baseURL: model.baseURL,
                  defaultContextWindow: model.contextWindow,
                  defaultMaxTokens: maxOutputTokens,
                  retryPolicy: { mode: 'normal', maxRetries: 0 },
                  models: [
                    {
                      id: model.model,
                      name: model.model,
                      contextWindow: model.contextWindow,
                      maxTokens: maxOutputTokens,
                      reasoningEfforts: false,
                    },
                  ],
                },
              },
            },
          },
          {
            id: 'finance-tool-bridge',
            name: pluginPath,
            config: {
              endpoint: `http://127.0.0.1:${address.port}`,
              token,
              tools: wireTools,
            },
          },
        ],
      },
    ];
    const patchPath = join(workspace.path, 'finance-profile.json');
    await writeFile(patchPath, JSON.stringify(patches), { mode: 0o600 });
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patchPath],
      dshHome: workspace.home,
      processCwd: workspace.path,
      cwd: workspace.path,
      provider: 'finance-gateway',
      model: model.model,
      maxTokens: maxOutputTokens,
      requestTimeoutMs: 90000,
      initializeTimeoutMs: 20000,
      disposeEofGraceMs: 2000,
      disposeGraceMs: 1000,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: 'zh_CN.UTF-8',
        DSH_API_KEY: model.apiKey,
        DSH_SYSTEM_PROMPT: FINANCE_SYSTEM_PROMPT,
      },
    });
    const instanceId = randomUUID();
    const sessionId = randomUUID();
    const instance: Instance = {
      harness,
      queue,
      server,
      pending,
      settled: false,
    };
    this.instances.set(instanceId, instance);
    try {
      await harness.start();
    } catch {
      await this.closeInstance(instance).catch(() => {});
      this.instances.delete(instanceId);
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '模型运行服务启动失败，请检查模型和 dsh 配置。',
      );
    }
    void harness
      .run(prompt, { sessionId })
      .then(async (result) => {
        if (suspended || bridgeFailed) return;
        await input.assert_model_slot?.();
        await material.validateContext?.();
        if (
          result.finishReason === 'error' ||
          result.finishReason === 'aborted'
        )
          queue.push({
            type: 'error',
            code: 'DEPENDENCY_UNAVAILABLE',
            message: '模型请求失败或中断。',
          });
        else if (result.finalResponse) {
          queue.push({
            type: 'response_complete',
            text: result.finalResponse,
            message_id: `assistant:${input.run_id}`,
          });
          queue.push({ type: 'idle' });
        } else
          queue.push({
            type: 'error',
            code: 'DEPENDENCY_UNAVAILABLE',
            message: '模型未返回可用结果。',
          });
      })
      .catch(
        (error) =>
          !suspended &&
          !bridgeFailed &&
          queue.push({
            type: 'error',
            code:
              error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
            message:
              error instanceof AppError &&
              error.code === 'REVALIDATION_REQUIRED'
                ? '上下文已变化，本次旧生成已停止。'
                : '模型请求失败或中断。',
          }),
      )
      .finally(() => {
        instance.settled = true;
        queue.end();
      });
    return {
      runtime_instance_id: instanceId,
      runtime_session_id: sessionId,
      events: queue,
    };
  }
  async continue(input: RuntimeContinue): Promise<RuntimeHandle> {
    return this.start(input);
  }
  private async closeInstance(instance: Instance) {
    instance.close ??= (async () => {
      try {
        await instance.harness.close();
      } finally {
        instance.queue.end();
        instance.server.closeAllConnections();
        await new Promise<void>((resolve) =>
          instance.server.close(() => resolve()),
        );
      }
    })();
    return instance.close;
  }
  async stop(handle: RuntimeHandle, _reason: StopReason): Promise<StopResult> {
    const instance = this.instances.get(handle.runtime_instance_id);
    if (!instance)
      return {
        process_stopped: true,
        pending_call_ids: [],
        persistence_state: 'uncertain',
      };
    const pending = [...instance.pending];
    try {
      await this.closeInstance(instance);
      return {
        process_stopped: true,
        pending_call_ids: pending,
        persistence_state: 'uncertain',
      };
    } catch {
      return {
        process_stopped: false,
        pending_call_ids: pending,
        persistence_state: 'uncertain',
      };
    }
  }
  async dispose(handle: RuntimeHandle): Promise<void> {
    const instance = this.instances.get(handle.runtime_instance_id);
    if (instance) {
      await this.closeInstance(instance);
      this.instances.delete(handle.runtime_instance_id);
    }
  }
}
