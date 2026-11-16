import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RunStatusSchema } from '@caixiaozhi/contracts';
import type { ConfiguredApplication } from '@caixiaozhi/application/demo';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import type { HttpIdentity } from '../identity/routes.js';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
export function registerOperationsRoutes(
  app: FastifyInstance,
  deps: {
    services: ConfiguredApplication;
    database: DatabaseConnection;
    identity: HttpIdentity;
  },
) {
  const { services, database, identity } = deps;
  app.get('/api/v1/operations/actions/reconciliation', async (request) => {
    const actor = await identity.requireActor(request);
    return dataResponse(
      request,
      await services.actions.listReconciliation(actor),
    );
  });
  app.get('/api/v1/operations/runs', async (request) => {
    const actor = await identity.requireActor(request);
    await services.identity.assertPermission(actor, 'operations.read');
    const q = z
      .strictObject({
        status: RunStatusSchema.optional(),
        user_id: z.string().min(1).optional(),
        before: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);
    const result = await database.pool.query(
      'SELECT id,owner_id,status,phase,runtime_active,origin,version,created_at,updated_at,started_at,finished_at,attempt,trace_id,error_code,usage,budgets FROM agent_runs WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR owner_id=$3) AND ($4::timestamptz IS NULL OR created_at<$4) ORDER BY created_at DESC,id DESC LIMIT $5',
      [
        actor.tenant_id,
        q.status ?? null,
        q.user_id ?? null,
        q.before ?? null,
        q.limit,
      ],
    );
    return dataResponse(request, {
      items: result.rows,
      scope: '当前租户运行元数据，不含会话正文',
    });
  });
  app.get<{ Params: { id: string } }>(
    '/api/v1/operations/runs/:id/timeline',
    async (request) => {
      const actor = await identity.requireActor(request);
      await services.identity.assertPermission(actor, 'operations.read');
      const run = await database.pool.query(
        'SELECT id,status,trace_id FROM agent_runs WHERE tenant_id=$1 AND id=$2',
        [actor.tenant_id, request.params.id],
      );
      if (!run.rowCount) throw new AppError('NOT_FOUND', '运行记录不存在。');
      const events = await database.pool.query(
        'SELECT seq,type,occurred_at FROM run_events WHERE run_id=$1 ORDER BY seq LIMIT 2000',
        [request.params.id],
      );
      const tools = await database.pool.query(
        "SELECT i.call_id,v.definition->>'name' AS name,i.effect,i.status,i.duration_ms,i.error_code,i.action_id,i.created_at FROM integration_invocations i JOIN integration_capability_versions v ON v.id=i.capability_version_id WHERE i.tenant_id=$1 AND i.run_id=$2 ORDER BY i.created_at,i.call_id",
        [actor.tenant_id, request.params.id],
      );
      return dataResponse(request, {
        run: run.rows[0],
        events: events.rows,
        tools: tools.rows,
      });
    },
  );
  app.get('/api/v1/operations/jobs', async (request) => {
    const actor = await identity.requireActor(request);
    await services.identity.assertPermission(actor, 'operations.read');
    const result = await database.pool.query(
      'SELECT id,owner_module,kind,status,attempt,generation,lease_epoch,lease_until,error_code,created_at,updated_at FROM durable_jobs WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
      [actor.tenant_id],
    );
    const slots = await database.pool.query(
      'SELECT kind,count(*)::int active FROM model_slots WHERE tenant_id=$1 AND released_at IS NULL AND lease_until>clock_timestamp() GROUP BY kind',
      [actor.tenant_id],
    );
    return dataResponse(request, {
      items: result.rows,
      model_slots: slots.rows,
      limits: { per_user: 2, per_tenant: 20 },
    });
  });
}
