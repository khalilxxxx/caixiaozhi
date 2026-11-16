import type { ActorContext } from '@caixiaozhi/contracts';
import type { RuntimeMaterial, RuntimeTool } from '@caixiaozhi/agent-runtime';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';

/** 旧正文只能沿调用发生时的不可变授权快照重放；当前 run 的新权限不能为旧数据自证。 */
export async function loadCompletedToolResults(
  database: DatabaseConnection,
  actor: ActorContext,
  runId: string,
  tools: RuntimeTool[],
): Promise<NonNullable<RuntimeMaterial['completed_tools']>> {
  const result = await database.pool.query(
    "SELECT i.call_id,v.definition->>'name' as name,v.definition->>'version' as version,i.result FROM integration_invocations i JOIN integration_capability_versions v ON v.id=i.capability_version_id WHERE i.tenant_id=$1 AND i.run_id=$2 AND i.actor_id=$3 AND i.authz_version=$4 AND i.result IS NOT NULL ORDER BY i.created_at",
    [actor.tenant_id, runId, actor.user_id, actor.authz_version],
  );
  return (
    result.rows
      .filter((row) =>
        tools.some(
          (tool) => tool.name === row.name && tool.version === row.version,
        ),
      )
      // 后续恢复只携带已执行状态与原action编号。业务正文必须走当前领域读取重新鉴权，
      // 资源可见性变化未必提升用户授权epoch，不能仅凭epoch复用原正文。
      .map(({ call_id, name, result }) => ({
        call_id,
        name,
        result: { ...result, data: null, evidence_refs: [] },
      }))
  );
}
