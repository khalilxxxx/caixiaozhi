import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalJson, hashPayload } from '@caixiaozhi/action-service';
import type {
  AdapterContext,
  WorkflowAdapter,
  WorkflowRunRef,
  WorkflowResult,
} from '@caixiaozhi/business-adapters/ports';
import { ajv, removeCredentials } from './schemas.js';
const json = (value: unknown) => sql`${canonicalJson(value)}::jsonb`;
export type WorkflowOperation = {
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  demo_output: unknown;
};
/** 仅demo；没有真实配置时绝不冒充已经连接MaaS。 */
export class MockWorkflowAdapter implements WorkflowAdapter {
  constructor(
    private readonly database: Database,
    private readonly connectorId: string,
    private readonly operations: Record<string, WorkflowOperation>,
  ) {}
  async start(
    ctx: AdapterContext,
    operation: string,
    input: unknown,
  ): Promise<WorkflowRunRef> {
    const definition = this.operations[operation];
    if (!definition || !ajv.compile(definition.input_schema)(input))
      throw new AppError('VALIDATION_ERROR', '演示工作流操作或输入无效。');
    const output = removeCredentials(definition.demo_output);
    if (!ajv.compile(definition.output_schema)(output))
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '演示工作流输出不符合契约。',
      );
    const externalId = `demo-${randomUUID()}`;
    await this.database.execute(
      sql`INSERT INTO integration_workflow_runs(id,tenant_id,actor_id,connector_id,external_run_id,operation,state,output,data_mode) VALUES(${randomUUID()},${ctx.actor.tenant_id},${ctx.actor.user_id},${this.connectorId},${externalId},${operation},'succeeded',${json(output)},'demo')`,
    );
    return {
      external_run_id: externalId,
      connector_id: this.connectorId,
      data_mode: 'demo',
    };
  }
  async get(ctx: AdapterContext, ref: WorkflowRunRef): Promise<WorkflowResult> {
    const r = (
      await this.database.execute(
        sql`SELECT state,output FROM integration_workflow_runs WHERE tenant_id=${ctx.actor.tenant_id} AND actor_id=${ctx.actor.user_id} AND connector_id=${this.connectorId} AND external_run_id=${ref.external_run_id}`,
      )
    ).rows[0];
    if (!r) throw new AppError('NOT_FOUND', '工作流任务不存在或无权访问。');
    return {
      status: r.state as WorkflowResult['status'],
      output: r.output,
      data_mode: 'demo',
    };
  }
  async cancel(ctx: AdapterContext, ref: WorkflowRunRef) {
    const result = await this.database.execute(
      sql`UPDATE integration_workflow_runs SET state='cancelled',version=version+1,updated_at=now() WHERE tenant_id=${ctx.actor.tenant_id} AND actor_id=${ctx.actor.user_id} AND connector_id=${this.connectorId} AND external_run_id=${ref.external_run_id} AND state='running' RETURNING id`,
    );
    return { accepted: result.rows.length > 0 };
  }
}
const CallbackSchema = z.strictObject({
  external_run_id: z.string().min(1),
  event_id: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'unknown']),
  output: z.unknown(),
});
export function createWorkflowCallbacks(
  database: Database,
  options: {
    resolveSecret(connectorId: string): Promise<string>;
    resolveOutputSchema(
      connectorId: string,
      operation: string,
    ): Promise<Record<string, unknown>>;
    now?: () => Date;
  },
) {
  async function accept(
    connectorId: string,
    rawBody: string,
    headers: { timestamp: string; signature: string },
  ) {
    const now = options.now?.() ?? new Date(),
      timestamp = Number(headers.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(now.getTime() - timestamp) > 300000
    )
      throw new AppError('FORBIDDEN', '工作流回调签名时间无效。');
    const secret = await options.resolveSecret(connectorId);
    if (Buffer.byteLength(secret) < 32)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '工作流回调密钥未配置。');
    const expected = createHmac('sha256', secret)
        .update(`${headers.timestamp}.${rawBody}`)
        .digest(),
      actual = Buffer.from(headers.signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
      throw new AppError('FORBIDDEN', '工作流回调签名无效。');
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new AppError('VALIDATION_ERROR', '回调 JSON 无效。');
    }
    const body = CallbackSchema.parse(input),
      hash = hashPayload(body);
    return database.transaction(async (tx) => {
      const row = (
        await tx.execute(
          sql`SELECT * FROM integration_workflow_runs WHERE connector_id=${connectorId} AND external_run_id=${body.external_run_id} FOR UPDATE`,
        )
      ).rows[0];
      if (!row) throw new AppError('NOT_FOUND', '工作流任务不存在。');
      const previous = (
        await tx.execute(
          sql`SELECT body_hash FROM integration_workflow_callbacks WHERE connector_id=${connectorId} AND external_run_id=${body.external_run_id} AND event_id=${body.event_id}`,
        )
      ).rows[0];
      if (previous) {
        if (previous.body_hash !== hash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '相同回调事件内容不一致。',
          );
        return { accepted: true, changed: false };
      }
      const schema = await options.resolveOutputSchema(
          connectorId,
          String(row.operation),
        ),
        output = removeCredentials(body.output);
      if (body.status === 'succeeded' && !ajv.compile(schema)(output))
        throw new AppError(
          'VALIDATION_ERROR',
          '回调结果未通过工作流输出契约。',
        );
      await tx.execute(
        sql`INSERT INTO integration_workflow_callbacks(connector_id,external_run_id,event_id,body_hash) VALUES(${connectorId},${body.external_run_id},${body.event_id},${hash})`,
      );
      if (['succeeded', 'failed', 'cancelled'].includes(String(row.state)))
        return { accepted: true, changed: false };
      await tx.execute(
        sql`UPDATE integration_workflow_runs SET state=${body.status},output=${json(output)},version=version+1,updated_at=now() WHERE id=${row.id as string}`,
      );
      await tx.execute(
        sql`INSERT INTO outbox_events(id,tenant_id,event_type,schema_version,resource_type,resource_id,resource_version,occurred_at,payload) VALUES(${randomUUID()},${row.tenant_id as string},'workflow.completed',1,'workflow',${row.id as string},${Number(row.version) + 1},${now},${json({ workflow_run_id: row.id, status: body.status, data_mode: row.data_mode })})`,
      );
      return { accepted: true, changed: true };
    });
  }
  async function markUnknown(connectorId: string, externalRunId: string) {
    // 超时不启动第二次工作流，保留原external_run_id等待回调/固定地址查询。
    await database.execute(
      sql`UPDATE integration_workflow_runs SET state='unknown',version=version+1,updated_at=now() WHERE connector_id=${connectorId} AND external_run_id=${externalRunId} AND state='running'`,
    );
  }
  return { accept, markUnknown };
}
