import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorContext, ActionReceipt } from '@caixiaozhi/contracts';
import type {
  CapabilityDefinition,
  ConnectorView,
} from '@caixiaozhi/contracts/integrations';
import type { Database, DatabaseExecutor } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  canonicalJson,
  hashPayload,
  type ActionService,
} from '@caixiaozhi/action-service';
import { validateDefinition } from './schemas.js';
const json = (v: unknown) => sql`${canonicalJson(v)}::jsonb`;
type Row = Record<string, unknown>;
export async function installBuiltinCapabilities(
  database: Database,
  tenantId: string,
  definitions: CapabilityDefinition[],
) {
  // 仅可信服务部署/seed调用；HTTP管理路由不会暴露此入口。
  await database.transaction(async (tx) => {
    for (const input of definitions) {
      const d = validateDefinition(input);
      if (!d.connector_id.startsWith('demo-'))
        throw new AppError('INVALID_STATE', '内置安装仅接受明确 demo 连接器。');
      await tx.execute(
        sql`INSERT INTO integration_connectors(id,tenant_id,name,system_type,adapter_kind,environment,status,owner_id,timeout_ms) VALUES(${`${tenantId}:${d.connector_id}`},${tenantId},${d.connector_id},'business','demo','demo','enabled','system',${d.timeout_ms}) ON CONFLICT(id) DO NOTHING`,
      );
      const capabilityId = `${tenantId}:${d.name}`,
        versionId = `${tenantId}:${d.id}`;
      const existing = (
        await tx.execute(
          sql`SELECT checksum FROM integration_capability_versions WHERE id=${versionId}`,
        )
      ).rows[0];
      if (existing && existing.checksum !== hashPayload(d))
        throw new AppError('VERSION_CONFLICT', '已安装能力版本不可原地修改。');
      await tx.execute(
        sql`INSERT INTO integration_capabilities(id,tenant_id,name,current_version_id,status) VALUES(${capabilityId},${tenantId},${d.name},${versionId},'published') ON CONFLICT(id) DO NOTHING`,
      );
      await tx.execute(
        sql`INSERT INTO integration_capability_versions(id,tenant_id,capability_id,semver,definition,checksum,published_at) VALUES(${versionId},${tenantId},${capabilityId},${d.version},${json(d)},${hashPayload(d)},now()) ON CONFLICT(id) DO NOTHING`,
      );
    }
  });
}
const refSchema = z
  .string()
  .regex(/^(?:env:[A-Z][A-Z0-9_]*|vault:[a-zA-Z0-9_./-]+)$/)
  .nullable();
export const ConnectorInputSchema = z.strictObject({
  name: z.string().min(1).max(100),
  system_type: z.string().min(1).max(100),
  adapter_kind: z.enum(['demo', 'production']),
  environment: z.enum(['demo', 'production']),
  base_url_ref: refSchema,
  secret_ref: refSchema,
  timeout_ms: z.number().int().min(1).max(120000),
  max_concurrency: z.number().int().min(1).max(100),
});
export type IntegrationRegistryOptions = {
  freshActor(actor: ActorContext): Promise<ActorContext>;
  actions?: ActionService;
  testConnector?: (connector: Record<string, unknown>) => Promise<void>;
  runContractTests?: (
    actor: ActorContext,
    definition: CapabilityDefinition,
  ) => Promise<Array<{ case_kind: string; result: 'passed' | 'failed' }>>;
};
export function createIntegrationRegistry(
  database: Database,
  options: IntegrationRegistryOptions,
) {
  async function command<T>(
    actor: ActorContext,
    operation: string,
    key: string,
    input: unknown,
    execute: (tx: DatabaseExecutor) => Promise<T>,
  ): Promise<T> {
    if (!key || key.length > 200)
      throw new AppError('VALIDATION_ERROR', '管理写入需要 Idempotency-Key。');
    const hash = hashPayload(input);
    return database.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenant_id}:${actor.user_id}:${operation}:${key}`},0))`,
      );
      const prior = (
        await tx.execute(
          sql`SELECT payload_hash,result FROM integration_command_ledger WHERE tenant_id=${actor.tenant_id} AND actor_id=${actor.user_id} AND operation=${operation} AND idempotency_key=${key}`,
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '相同幂等键不能用于不同管理参数。',
          );
        return prior.result as T;
      }
      const result = await execute(tx);
      await tx.execute(
        sql`INSERT INTO integration_command_ledger(tenant_id,actor_id,operation,idempotency_key,payload_hash,result) VALUES(${actor.tenant_id},${actor.user_id},${operation},${key},${hash},${json(result)})`,
      );
      return result;
    });
  }
  async function manage(actor: ActorContext) {
    const fresh = await options.freshActor(actor);
    if (
      fresh.tenant_id !== actor.tenant_id ||
      fresh.user_id !== actor.user_id ||
      !fresh.permissions.includes('integration.manage')
    )
      throw new AppError('FORBIDDEN', '无系统接入管理权限。');
    return fresh;
  }
  function connectorView(row: Row): ConnectorView {
    return {
      id: String(row.id),
      name: String(row.name),
      system_type: String(row.system_type),
      adapter_kind: row.adapter_kind as 'demo' | 'production',
      environment: row.environment as 'demo' | 'production',
      status: row.status as ConnectorView['status'],
      config_version: Number(row.config_version),
      timeout_ms: Number(row.timeout_ms),
      max_concurrency: Number(row.max_concurrency),
      secret_configured: !!row.secret_ref,
      base_url_configured: !!row.base_url_ref,
    };
  }
  async function connector(
    actor: ActorContext,
    id: string,
    tx: DatabaseExecutor = database,
  ) {
    const row = (
      await tx.execute(
        sql`SELECT * FROM integration_connectors WHERE tenant_id=${actor.tenant_id} AND id=${id}`,
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '连接器不存在。');
    return row;
  }
  async function listConnectors(actor: ActorContext) {
    const a = await manage(actor);
    return (
      await database.execute(
        sql`SELECT * FROM integration_connectors WHERE tenant_id=${a.tenant_id} ORDER BY id`,
      )
    ).rows.map(connectorView);
  }
  async function createConnector(
    actor: ActorContext,
    input: unknown,
    idempotencyKey: string,
  ) {
    const a = await manage(actor),
      d = ConnectorInputSchema.parse(input);
    if (d.adapter_kind !== d.environment)
      throw new AppError('VALIDATION_ERROR', '适配器与环境必须一致。');
    return command(a, 'connector.create', idempotencyKey, d, async (tx) => {
      const row = (
        await tx.execute(
          sql`INSERT INTO integration_connectors(id,tenant_id,name,system_type,adapter_kind,environment,status,base_url_ref,secret_ref,owner_id,timeout_ms,max_concurrency) VALUES(${randomUUID()},${a.tenant_id},${d.name},${d.system_type},${d.adapter_kind},${d.environment},'draft',${d.base_url_ref},${d.secret_ref},${a.user_id},${d.timeout_ms},${d.max_concurrency}) RETURNING *`,
        )
      ).rows[0]!;
      return connectorView(row);
    });
  }
  async function updateConnector(
    actor: ActorContext,
    id: string,
    input: unknown,
    idempotencyKey: string,
  ) {
    const a = await manage(actor),
      d = ConnectorInputSchema.extend({
        expected_version: z.number().int().positive(),
        status: z.enum(['draft', 'disabled']),
      }).parse(input);
    await connector(a, id);
    if (d.adapter_kind !== d.environment)
      throw new AppError('VALIDATION_ERROR', '适配器与环境必须一致。');
    return command(
      a,
      'connector.update',
      idempotencyKey,
      { id, ...d },
      async (tx) => {
        const result = await tx.execute(
          sql`UPDATE integration_connectors SET name=${d.name},system_type=${d.system_type},adapter_kind=${d.adapter_kind},environment=${d.environment},status=${d.status},base_url_ref=${d.base_url_ref},secret_ref=${d.secret_ref},timeout_ms=${d.timeout_ms},max_concurrency=${d.max_concurrency},config_version=config_version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${id} AND config_version=${d.expected_version} RETURNING *`,
        );
        if (!result.rows[0])
          throw new AppError('VERSION_CONFLICT', '连接器配置已变化。');
        return connectorView(result.rows[0]);
      },
    );
  }
  async function testConnector(
    actor: ActorContext,
    id: string,
    idempotencyKey: string,
  ) {
    const a = await manage(actor),
      c = await connector(a, id);
    if (
      c.adapter_kind === 'production' &&
      (!c.secret_ref || !c.base_url_ref || !options.testConnector)
    )
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '真实连接尚未配置验证适配器或凭据。',
      );
    if (options.testConnector) await options.testConnector(c);
    return command(a, 'connector.test', idempotencyKey, { id }, async (tx) => {
      await tx.execute(
        sql`UPDATE integration_connectors SET status='enabled',config_version=config_version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${id} AND config_version=${Number(c.config_version)}`,
      );
      return { status: 'ready', data_mode: c.adapter_kind };
    });
  }
  async function listCapabilities(actor: ActorContext) {
    const a = await options.freshActor(actor),
      admin = a.permissions.includes('integration.manage');
    const rows = (
      await database.execute(
        sql`SELECT c.*,v.definition FROM integration_capabilities c LEFT JOIN integration_capability_versions v ON v.id=c.current_version_id WHERE c.tenant_id=${a.tenant_id} ORDER BY c.name`,
      )
    ).rows;
    return rows
      .filter((r) => {
        const d = r.definition as CapabilityDefinition | undefined;
        return (
          admin ||
          (r.status === 'published' &&
            d &&
            d.effect !== 'write' &&
            d.required_permissions.every((p) =>
              a.permissions.includes(p as never),
            ))
        );
      })
      .map((r) => {
        const d = r.definition as CapabilityDefinition | undefined;
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          version: r.version,
          current_version_id: r.current_version_id,
          title: d?.title ?? String(r.name),
          description: d?.description ?? '',
          effect: d?.effect ?? null,
          ...(admin ? { definition: d ?? null } : {}),
        };
      });
  }
  async function createVersion(
    actor: ActorContext,
    capabilityId: string,
    input: unknown,
    idempotencyKey: string,
  ) {
    const a = await manage(actor),
      d = validateDefinition(input);
    await connector(
      a,
      d.connector_id.startsWith('demo-')
        ? `${a.tenant_id}:${d.connector_id}`
        : d.connector_id,
    );
    return command(
      a,
      'capability.version.create',
      idempotencyKey,
      { capabilityId, definition: d },
      async (tx) => {
        const c = (
          await tx.execute(
            sql`SELECT * FROM integration_capabilities WHERE tenant_id=${a.tenant_id} AND id=${capabilityId} FOR UPDATE`,
          )
        ).rows[0];
        if (c && c.name !== d.name)
          throw new AppError('VALIDATION_ERROR', '能力名称不能变更。');
        if (!c)
          await tx.execute(
            sql`INSERT INTO integration_capabilities(id,tenant_id,name,status) VALUES(${capabilityId},${a.tenant_id},${d.name},'draft')`,
          );
        const id = `${a.tenant_id}:${d.id}`;
        const existing = (
          await tx.execute(
            sql`SELECT id FROM integration_capability_versions WHERE tenant_id=${a.tenant_id} AND (id=${id} OR (capability_id=${capabilityId} AND semver=${d.version}))`,
          )
        ).rows[0];
        if (existing)
          throw new AppError(
            'VERSION_CONFLICT',
            '此能力版本已存在，版本内容不可修改。',
          );
        await tx.execute(
          sql`INSERT INTO integration_capability_versions(id,tenant_id,capability_id,semver,definition,checksum) VALUES(${id},${a.tenant_id},${capabilityId},${d.version},${json(d)},${hashPayload(d)})`,
        );
        return { id, capability_id: capabilityId, status: 'draft' };
      },
    );
  }
  async function testVersion(
    actor: ActorContext,
    capabilityId: string,
    versionId: string,
    idempotencyKey: string,
  ) {
    const a = await manage(actor);
    const row = (
      await database.execute(
        sql`SELECT * FROM integration_capability_versions WHERE tenant_id=${a.tenant_id} AND capability_id=${capabilityId} AND id=${versionId}`,
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '能力版本不存在。');
    if (!options.runContractTests)
      throw new AppError('INVALID_STATE', '尚未登记此能力的受控契约夹具。');
    const d = validateDefinition(row.definition),
      results = await options.runContractTests(a, d);
    const required = [
      'success',
      'invalid_input',
      'unauthorized',
      'dependency_failure',
      ...(d.effect === 'write'
        ? ['stale_version', 'duplicate_key', 'lost_receipt']
        : []),
    ];
    if (
      !required.every((k) =>
        results.some((r) => r.case_kind === k && r.result === 'passed'),
      )
    )
      throw new AppError('INVALID_STATE', '能力契约样例未全部通过。');
    return command(
      a,
      'capability.test',
      idempotencyKey,
      { capabilityId, versionId },
      async (tx) => {
        for (const result of results)
          await tx.execute(
            sql`INSERT INTO integration_capability_tests(id,tenant_id,version_id,case_kind,result) VALUES(${randomUUID()},${a.tenant_id},${versionId},${result.case_kind},${result.result}) ON CONFLICT(version_id,case_kind) DO UPDATE SET result=excluded.result,tested_at=now()`,
          );
        await tx.execute(
          sql`UPDATE integration_capability_versions SET tested=true WHERE id=${versionId}`,
        );
        return { version_id: versionId, results };
      },
    );
  }
  async function listInvocations(actor: ActorContext) {
    const a = await options.freshActor(actor);
    if (!a.permissions.includes('operations.read'))
      throw new AppError('FORBIDDEN', '无调用运维元数据读取权限。');
    return (
      await database.execute(
        sql`SELECT call_id,run_id,actor_id,capability_version_id,connector_config_version,lease_epoch,args_hash,redacted_args,effect,status,action_id,duration_ms,evidence_refs,error_code,created_at FROM integration_invocations WHERE tenant_id=${a.tenant_id} ORDER BY created_at DESC,call_id LIMIT 100`,
      )
    ).rows;
  }
  if (options.actions) {
    for (const operation of [
      'integration.capability.publish',
      'integration.capability.disable',
    ] as const)
      options.actions.registerHandler(operation, {
        async validate(actor, args, _refs, tx) {
          const a = await manage(actor),
            d = z
              .strictObject({
                capability_id: z.string().min(1),
                version_id: z.string().min(1).optional(),
                expected_version: z.number().int().positive(),
                reason: z.string().min(1).max(1000).optional(),
              })
              .parse(args);
          const c = (
            await (tx ?? database).execute(
              sql`SELECT * FROM integration_capabilities WHERE tenant_id=${a.tenant_id} AND id=${d.capability_id} ${tx ? sql`FOR UPDATE` : sql``}`,
            )
          ).rows[0];
          if (!c) throw new AppError('NOT_FOUND', '能力不存在。');
          if (c.version !== d.expected_version)
            throw new AppError('VERSION_CONFLICT', '能力版本已变化。');
          if (operation.endsWith('publish')) {
            const v = (
              await (tx ?? database).execute(
                sql`SELECT * FROM integration_capability_versions WHERE tenant_id=${a.tenant_id} AND capability_id=${d.capability_id} AND id=${d.version_id ?? ''}`,
              )
            ).rows[0];
            if (!v || !v.tested)
              throw new AppError(
                'INVALID_STATE',
                '只能发布已通过完整契约测试的版本。',
              );
            const definition = validateDefinition(v.definition),
              conn = await connector(
                a,
                definition.connector_id.startsWith('demo-')
                  ? `${a.tenant_id}:${definition.connector_id}`
                  : definition.connector_id,
                tx,
              );
            if (conn.status !== 'enabled')
              throw new AppError('INVALID_STATE', '依赖连接器未启用。');
          } else if (!d.reason)
            throw new AppError('VALIDATION_ERROR', '停用能力必须填写原因。');
          return {
            summary: {
              title: operation.endsWith('publish')
                ? '发布能力版本'
                : '停用能力',
              capability_name: c.name,
              version_id: d.version_id ?? null,
              reason: d.reason ?? null,
            },
            args: d,
            items: [{ resource_ref: null }],
            extra_guards: {
              capability_id: d.capability_id,
              version: d.expected_version,
            },
          };
        },
        async execute(ctx, tx, action) {
          const args = action.args as {
            capability_id: string;
            version_id?: string;
            expected_version: number;
          };
          const status = operation.endsWith('publish')
            ? 'published'
            : 'disabled';
          const r = await tx!.execute(
            sql`UPDATE integration_capabilities SET status=${status},current_version_id=COALESCE(${args.version_id ?? null},current_version_id),version=version+1,updated_at=now() WHERE tenant_id=${ctx.actor.tenant_id} AND id=${args.capability_id} AND version=${args.expected_version} RETURNING id`,
          );
          if (!r.rows.length)
            throw new AppError('VERSION_CONFLICT', '能力版本已变化。');
          if (args.version_id)
            await tx!.execute(
              sql`UPDATE integration_capability_versions SET published_at=COALESCE(published_at,now()) WHERE id=${args.version_id}`,
            );
          return {
            id: randomUUID(),
            action_id: ctx.action_id,
            idempotency_key: ctx.idempotency_key,
            outcome: 'succeeded',
            resource: null,
            external_receipt_id: null,
            occurred_at: new Date().toISOString(),
            data_mode: 'demo',
            error_code: null,
          } satisfies ActionReceipt;
        },
        async queryOutcome(ctx) {
          return {
            id: randomUUID(),
            action_id: ctx.action_id,
            idempotency_key: ctx.idempotency_key,
            outcome: 'unknown',
            resource: null,
            external_receipt_id: null,
            occurred_at: new Date().toISOString(),
            data_mode: 'demo',
            error_code: 'OUTCOME_UNKNOWN',
          };
        },
      });
  }
  return {
    listConnectors,
    createConnector,
    updateConnector,
    testConnector,
    listCapabilities,
    createVersion,
    testVersion,
    listInvocations,
  };
}
export type IntegrationRegistry = ReturnType<typeof createIntegrationRegistry>;
