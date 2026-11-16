import { sql } from 'drizzle-orm';
import type {
  ActorContext,
  ResourceRef,
  ToolRequest,
  ToolResult,
} from '@caixiaozhi/contracts';
import { ToolRequestSchema, ToolResultSchema } from '@caixiaozhi/contracts';
import type {
  CapabilityDefinition,
  ExecutionContext,
  ToolDescriptor,
} from '@caixiaozhi/contracts/integrations';
import type { Database } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalJson, hashPayload } from '@caixiaozhi/action-service';
import {
  ajv,
  redactArguments,
  rejectModelCredentials,
  removeCredentials,
  validateDefinition,
} from './schemas.js';
export type ToolHandler = {
  authorize(context: ExecutionContext, args: unknown): Promise<void>;
  execute(args: unknown, context: ExecutionContext): Promise<ToolResult>;
};
export type ToolGatewayOptions = {
  freshActor(actor: ActorContext): Promise<ActorContext>;
  assertLease(context: ExecutionContext): Promise<void>;
  consumeBudget(context: ExecutionContext): Promise<void>;
  resolveSkillCapabilities(context: ExecutionContext): Promise<string[]>;
  assertResourceAccess(
    actor: ActorContext,
    operation: string,
    ref: ResourceRef,
  ): Promise<void>;
  storeOversizedOutput?: (
    context: ExecutionContext,
    output: unknown,
  ) => Promise<{ artifact_ref: string; summary: unknown }>;
  assertSkillAction?: (
    context: ExecutionContext,
    operation: string,
  ) => Promise<void>;
};
const json = (v: unknown) => sql`${canonicalJson(v)}::jsonb`;
function failure(error: unknown): ToolResult {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'DEPENDENCY_UNAVAILABLE';
  const details = error instanceof AppError ? error.details : undefined;
  const questions =
    code === 'VALIDATION_ERROR' && Array.isArray(details?.questions)
      ? details.questions
          .filter((q): q is string => typeof q === 'string' && q.length <= 1000)
          .slice(0, 10)
      : [];
  return {
    status:
      code === 'VALIDATION_ERROR'
        ? 'requires_input'
        : [
              'FORBIDDEN',
              'NOT_FOUND',
              'VERSION_CONFLICT',
              'REVALIDATION_REQUIRED',
              'INVALID_STATE',
              'CONFIRMATION_EXPIRED',
              'RATE_LIMITED',
            ].includes(code)
          ? 'rejected'
          : code === 'OUTCOME_UNKNOWN'
            ? 'unknown'
            : 'error',
    data: questions.length ? { questions } : null,
    evidence_refs: [],
    action_id:
      code === 'OUTCOME_UNKNOWN' && typeof details?.action_id === 'string'
        ? details.action_id
        : null,
    error_code: code,
  };
}
export function createToolGateway(
  database: Database,
  options: ToolGatewayOptions,
) {
  const handlers = new Map<
    string,
    { definition: CapabilityDefinition; handler: ToolHandler }
  >();
  function registerTool(input: CapabilityDefinition, handler: ToolHandler) {
    const d = validateDefinition(input);
    handlers.set(d.id, { definition: d, handler });
  }
  async function fresh(context: ExecutionContext) {
    await options.assertLease(context);
    if (
      !Number.isFinite(Date.parse(context.deadline_at)) ||
      Date.now() >= Date.parse(context.deadline_at)
    )
      throw new AppError('RATE_LIMITED', '工具执行预算已到期。');
    const actor = await options.freshActor(context.actor);
    if (
      actor.tenant_id !== context.actor.tenant_id ||
      actor.user_id !== context.actor.user_id ||
      actor.authz_version !== context.actor.authz_version
    )
      throw new AppError('REVALIDATION_REQUIRED', '运行身份或权限版本已变化。');
    return { ...context, actor };
  }
  async function allowed(context: ExecutionContext) {
    const ctx = await fresh(context);
    const skill = ctx.selected_skill_version_id
      ? new Set(await options.resolveSkillCapabilities(ctx))
      : null;
    const rows = (
      await database.execute(
        sql`SELECT v.id AS stored_version_id,v.definition,c.status,con.config_version,con.max_concurrency,con.id AS stored_connector_id FROM integration_capability_versions v JOIN integration_capabilities c ON c.current_version_id=v.id AND c.tenant_id=v.tenant_id JOIN integration_connectors con ON con.tenant_id=v.tenant_id AND (con.id=v.definition->>'connector_id' OR con.id=v.tenant_id||':'||(v.definition->>'connector_id')) WHERE v.tenant_id=${ctx.actor.tenant_id} AND c.status='published' AND con.status='enabled'`,
      )
    ).rows;
    return {
      ctx,
      rows: rows.filter((row) => {
        const d = row.definition as CapabilityDefinition;
        return (
          d.effect !== 'write' &&
          handlers.has(d.id) &&
          (ctx.allowed_capability_versions.includes(d.id) ||
            ctx.allowed_capability_versions.includes(
              String(row.stored_version_id),
            )) &&
          (!skill ||
            skill.has(d.id) ||
            skill.has(String(row.stored_version_id))) &&
          d.required_permissions.every((p) =>
            ctx.actor.permissions.includes(p as never),
          ) &&
          (ctx.actor.invocation_origin !== 'subscription' ||
            d.effect === 'read')
        );
      }),
    };
  }
  async function listAllowedTools(
    context: ExecutionContext,
  ): Promise<ToolDescriptor[]> {
    const { rows } = await allowed(context);
    return rows.map((row) => {
      const d = row.definition as CapabilityDefinition;
      return {
        name: d.name,
        version: d.version,
        description: d.description,
        input_schema: d.input_schema,
        effect: d.effect as 'read' | 'propose',
      };
    });
  }
  async function dispatchTool(
    request: ToolRequest,
    context: ExecutionContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    let claimed = false,
      ctx = context;
    try {
      const parsed = ToolRequestSchema.safeParse(request);
      if (!parsed.success)
        throw new AppError('VALIDATION_ERROR', '工具请求格式无效。');
      if (request.run_id !== context.run_id)
        throw new AppError('FORBIDDEN', '工具请求不属于当前任务。');
      rejectModelCredentials(request.arguments);
      const selection = await allowed(context);
      ctx = { ...selection.ctx, call_id: request.call_id };
      const row = selection.rows.find((r) => {
        const d = r.definition as CapabilityDefinition;
        return d.name === request.name && d.version === request.version;
      });
      if (!row)
        throw new AppError('FORBIDDEN', '此能力不在当前任务授权范围或已停用。');
      const definition = row.definition as CapabilityDefinition,
        binding = handlers.get(definition.id)!;
      if (hashPayload(definition) !== hashPayload(binding.definition))
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '运行能力版本与注册代码不一致。',
        );
      if (!ajv.compile(definition.input_schema)(request.arguments))
        throw new AppError('VALIDATION_ERROR', '工具参数未通过能力契约校验。');
      const argsHash = hashPayload({
        name: request.name,
        version: request.version,
        arguments: request.arguments,
      });
      const cached = await database.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.actor.tenant_id}:${row.stored_connector_id}`},0))`,
        );
        const prior = (
          await tx.execute(
            sql`SELECT * FROM integration_invocations WHERE tenant_id=${ctx.actor.tenant_id} AND run_id=${ctx.run_id} AND call_id=${request.call_id}`,
          )
        ).rows[0];
        if (prior) {
          if (prior.args_hash !== argsHash)
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              '同一工具调用编号不能复用不同参数。',
            );
          if (
            prior.actor_id !== ctx.actor.user_id ||
            Number(prior.authz_version) !== ctx.actor.authz_version
          )
            throw new AppError(
              'REVALIDATION_REQUIRED',
              '原工具结果的权限快照已失效，请按当前权限重新查询。',
            );
          return prior.result
            ? ToolResultSchema.parse(prior.result)
            : failure(
                new AppError('OUTCOME_UNKNOWN', '原工具调用仍在核实中。'),
              );
        }
        const active = await tx.execute(
          sql`SELECT count(*)::int AS count FROM integration_invocations WHERE tenant_id=${ctx.actor.tenant_id} AND status='running' AND capability_version_id IN(SELECT id FROM integration_capability_versions WHERE definition->>'connector_id'=${definition.connector_id})`,
        );
        if (Number(active.rows[0]?.count) >= Number(row.max_concurrency))
          throw new AppError('RATE_LIMITED', '连接器并发额度已满。');
        await options.consumeBudget(ctx);
        await tx.execute(
          sql`INSERT INTO integration_invocations(call_id,tenant_id,run_id,actor_id,authz_version,capability_version_id,connector_config_version,lease_epoch,args_hash,redacted_args,effect,status) VALUES(${request.call_id},${ctx.actor.tenant_id},${ctx.run_id},${ctx.actor.user_id},${ctx.actor.authz_version},${row.stored_version_id as string},${Number(row.config_version)},${ctx.lease_epoch},${argsHash},${json(redactArguments(request.arguments, definition.sensitive_fields))},${definition.effect},'running')`,
        );
        claimed = true;
        return null;
      });
      // 已知能力的权限拒绝同样保留调用审计；命中旧回执仍先实时重鉴权。
      await binding.handler.authorize(ctx, request.arguments);
      if (
        ctx.selected_skill_version_id &&
        request.name === 'finance.action.prepare'
      ) {
        if (!options.assertSkillAction)
          throw new AppError(
            'INVALID_STATE',
            '尚未配置能力的业务操作白名单校验。',
          );
        const operation = (request.arguments as { action?: unknown }).action;
        if (typeof operation !== 'string')
          throw new AppError('VALIDATION_ERROR', '动作名称无效。');
        await options.assertSkillAction(ctx, operation);
      }
      // 只读能力重新进入领域读取，避免同权限epoch内资源ACL变化后复用旧正文。
      // start类只读任务仍沿原run/call幂等键查询同一个任务，不创建第二个业务作业。
      if (cached && definition.effect !== 'read') return cached;
      const timeout = Math.min(
        definition.timeout_ms,
        Date.parse(ctx.deadline_at) - Date.now(),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ToolResult;
      try {
        result = ToolResultSchema.parse(
          await Promise.race([
            binding.handler.execute(request.arguments, ctx),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new AppError(
                      'DEPENDENCY_UNAVAILABLE',
                      '工具依赖调用超时。',
                    ),
                  ),
                timeout,
              );
            }),
          ]),
        );
      } finally {
        clearTimeout(timer);
      }
      await fresh(ctx);
      result = { ...result, data: removeCredentials(result.data) };
      if (
        ['ok', 'requires_confirmation'].includes(result.status) &&
        !ajv.compile(definition.output_schema)(result.data)
      )
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '工具依赖返回内容未通过输出契约校验。',
        );
      if (Buffer.byteLength(canonicalJson(result)) > 128 * 1024) {
        if (!options.storeOversizedOutput)
          throw new AppError(
            'DEPENDENCY_UNAVAILABLE',
            '工具输出超过允许范围，尚未配置私有产物存储。',
          );
        const artifact = await options.storeOversizedOutput(ctx, result.data);
        result = {
          ...result,
          data: {
            summary: artifact.summary,
            artifact_ref: artifact.artifact_ref,
          },
          evidence_refs: [...result.evidence_refs, artifact.artifact_ref],
        };
        if (Buffer.byteLength(canonicalJson(result)) > 128 * 1024)
          throw new AppError(
            'DEPENDENCY_UNAVAILABLE',
            '工具输出摘要仍超过允许范围。',
          );
      }
      await persist(request, ctx, result, start);
      return result;
    } catch (error) {
      const result = failure(error);
      if (claimed) await persist(request, ctx, result, start);
      return result;
    }
  }
  async function persist(
    request: ToolRequest,
    ctx: ExecutionContext,
    result: ToolResult,
    start: number,
  ) {
    await database.execute(
      sql`UPDATE integration_invocations SET status=${result.status},action_id=${result.action_id},duration_ms=${Date.now() - start},evidence_refs=${json(result.evidence_refs)},error_code=${result.error_code},result=${json(result)},updated_at=now() WHERE tenant_id=${ctx.actor.tenant_id} AND run_id=${ctx.run_id} AND call_id=${request.call_id} AND lease_epoch=${ctx.lease_epoch}`,
    );
  }
  return { registerTool, listAllowedTools, dispatchTool };
}
export type ToolGateway = ReturnType<typeof createToolGateway>;
