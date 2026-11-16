import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDshNodeVersion,
  readDshModelConfig,
} from '../../packages/agent-runtime/src/dsh/driver.js';
import {
  assertWorkspaceScope,
  createWorkspace,
} from '../../packages/agent-runtime/src/workspace.js';
import { buildContext } from '../../packages/agent-runtime/src/context/builder.js';
import {
  assertRuntimeContextBudget,
  renderRuntimePrompt,
} from '../../packages/agent-runtime/src/context/prompt.js';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import { runPayloadHash } from '../../packages/agent-runtime/src/runs.js';
import type { ActorContext } from '@caixiaozhi/contracts';

const actor: ActorContext = {
  tenant_id: 'tenant-a',
  user_id: 'user-a',
  roles: ['employee'],
  department_ids: [],
  permissions: [],
  authz_version: 1,
  session_id: 'test-session',
  invocation_origin: 'interactive',
  delegation_id: null,
};
describe('运行配置与安全上下文', () => {
  it('运行prompt包含续接数据与已完成结果一次，70%边界按UTF8字节拒绝中文超额', () => {
    const prompt = renderRuntimePrompt({
      prompt: '当前问题',
      checkpoint: CheckpointSchema.parse({
        stage: 'waiting_confirmation',
        pending_confirmation_id: 'unique-checkpoint-reference',
      }),
      resume_input: { user_input: 'unique-resume-reference' },
      completed_tools: [
        {
          call_id: 'unique-completed-reference',
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
    });
    for (const marker of [
      'unique-checkpoint-reference',
      'unique-resume-reference',
      'unique-completed-reference',
    ])
      expect(prompt.split(marker)).toHaveLength(2);
    expect(() => assertRuntimeContextBudget(716, 1024)).not.toThrow();
    expect(() =>
      assertRuntimeContextBudget(
        Buffer.byteLength('字'.repeat(239), 'utf8'),
        1024,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'RATE_LIMITED',
        details: { reason: 'CONTEXT_BUDGET_EXCEEDED' },
      }),
    );
  });
  it('预留续接预算先于可选历史压缩，必要输入与外加内容共享同一70%限额', async () => {
    const reservedText = '额外上下文'.repeat(45);
    const bundle = await buildContext({
      actor,
      freshActor: async () => actor,
      contextLimit: 1500,
      reservedText,
      load: async () => [
        {
          id: 'old',
          version: 1,
          text: '历史内容'.repeat(100),
          kind: 'history',
        },
        {
          id: 'current',
          version: 1,
          text: '必须保留的问题',
          kind: 'input',
          required: true,
        },
      ],
    });
    expect(bundle.entries.map((item) => item.id)).toEqual(['current']);
    expect(bundle.prompt).toContain('必须保留的问题');
    expect(bundle.prompt).not.toContain('历史内容');
    expect(
      Buffer.byteLength(bundle.prompt + reservedText, 'utf8'),
    ).toBeLessThanOrEqual(1050);
  });
  it('模型未配置明确失败，不寻找其他provider凭据或生成固定答案', () => {
    expect(() => readDshModelConfig({ OPENAI_API_KEY: 'unrelated' })).toThrow(
      '模型服务未配置',
    );
    expect(() => assertDshNodeVersion('22.16.0')).toThrow('24.9.0');
    expect(() => assertDshNodeVersion('24.22.1')).not.toThrow();
  });
  it('网关地址不允许嵌入凭据，协议与窗口必须有效', () => {
    const env = {
      DSH_API_KEY: 'fixture-key',
      DSH_MODEL: 'fixture-model',
      DSH_BASE_URL: 'http://127.0.0.1/v1',
      DSH_CONTEXT_WINDOW: '8192',
    };
    expect(readDshModelConfig(env)).toMatchObject({
      protocol: 'openai-completions',
      contextWindow: 8192,
    });
    expect(() =>
      readDshModelConfig({
        ...env,
        DSH_BASE_URL: 'https://secret@example.com',
      }),
    ).toThrow();
    expect(() =>
      readDshModelConfig({ ...env, DSH_CONTEXT_WINDOW: '0' }),
    ).toThrow();
  });
  it('runtime_workspace_isolated：租户、用户、run和epoch均隔离，路径注入被散列', async () => {
    const root = await mkdtemp(join(tmpdir(), 'finance-runtime-'));
    try {
      const a = await createWorkspace(root, {
        tenant_id: 'tenant',
        owner_id: '../../user-a',
        run_id: 'run',
        lease_epoch: 1,
      });
      const b = await createWorkspace(root, {
        tenant_id: 'tenant',
        owner_id: 'user-b',
        run_id: 'run',
        lease_epoch: 1,
      });
      const c = await createWorkspace(root, {
        tenant_id: 'tenant',
        owner_id: '../../user-a',
        run_id: 'run',
        lease_epoch: 2,
      });
      expect(a.path).not.toEqual(b.path);
      expect(a.path).not.toEqual(c.path);
      expect(a.path).toContain(root);
      expect(() =>
        assertWorkspaceScope(
          { tenant_id: 'tenant', owner_id: 'a' },
          { tenant_id: 'tenant', owner_id: 'b' },
        ),
      ).toThrow('不存在');
      const link = join(root, 'link');
      await symlink(tmpdir(), link);
      await expect(
        createWorkspace(link, {
          tenant_id: 't',
          owner_id: 'u',
          run_id: 'r',
          lease_epoch: 1,
        }),
      ).rejects.toThrow('配置无效');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('deleted_memory_not_reinjected：每次重读记忆，压缩保留确认及结构化引用', async () => {
    let memoryVisible = true;
    let fresh = 0;
    const load = async () => [
      {
        id: 'constraint',
        version: 1,
        text: '有影响操作需确认。',
        kind: 'constraint' as const,
        required: true,
      },
      ...(memoryVisible
        ? [
            {
              id: 'memory-a',
              version: 1,
              text: '用户偏好简明回复。',
              kind: 'memory' as const,
            },
          ]
        : []),
      {
        id: 'question',
        version: 1,
        text: '请检查这张单据',
        kind: 'input' as const,
        required: true,
      },
    ];
    const checkpoint = CheckpointSchema.parse({
      stage: 'waiting_confirmation',
      pending_confirmation_id: 'confirm-1',
      action_ids: ['action-1'],
      resource_refs: [{ type: 'travel', id: 'travel-1', version: 3 }],
    });
    const options = {
      actor,
      freshActor: async () => {
        fresh++;
        return actor;
      },
      load,
      contextLimit: 8192,
      checkpoint,
    };
    expect((await buildContext(options)).prompt).toContain('用户偏好');
    memoryVisible = false;
    const context = await buildContext(options);
    expect(context.prompt).not.toContain('用户偏好');
    expect(context.prompt).toContain('confirm-1');
    expect(context.prompt).toContain('action-1');
    expect(context.prompt).toContain('travel-1');
    expect(fresh).toBe(2);
  });
  it('输入预算不足明确停止且幂等hash不受对象键顺序影响', async () => {
    expect(runPayloadHash({ b: 2, a: 1 })).toEqual(
      runPayloadHash({ a: 1, b: 2 }),
    );
    await expect(
      buildContext({
        actor,
        freshActor: async () => actor,
        contextLimit: 1024,
        load: async () => [
          {
            id: 'huge',
            version: 1,
            text: '字'.repeat(1000),
            kind: 'input',
            required: true,
          },
        ],
      }),
    ).rejects.toThrow('超出模型预算');
  });
  it('上下文预算包含标签、分隔符以及续接工具和用户补充的预留内容', async () => {
    const options = {
      actor,
      freshActor: async () => actor,
      contextLimit: 1024,
      load: async () => [
        {
          id: 'input',
          version: 1,
          text: '问题',
          kind: 'input' as const,
          required: true,
        },
      ],
      reservedText: '续接结果'.repeat(100),
    };
    await expect(buildContext(options)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    await expect(
      buildContext({
        ...options,
        reservedText: '',
        load: async () =>
          Array.from({ length: 50 }, (_, i) => ({
            id: `entry-${i}`,
            version: 1,
            text: '',
            kind: 'task' as const,
            required: true,
          })),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
