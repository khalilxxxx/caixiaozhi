import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import type { DurableJob } from '@caixiaozhi/jobs/queue';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import type { DocumentService, ProposalMaterial } from './documents.js';
import { rows } from './store.js';
export async function assertProposalLease(
  db: DatabaseExecutor,
  job: DurableJob,
) {
  const active = await rows(
    db,
    sql`SELECT j.id FROM durable_jobs j JOIN identity_environments e ON e.tenant_id=j.tenant_id WHERE j.id=${job.id} AND j.tenant_id=${job.tenant_id} AND j.lease_owner=${job.lease_owner} AND j.lease_epoch=${job.lease_epoch} AND j.status='running' AND j.generation=e.generation AND j.generation=${job.generation} AND j.lease_until>clock_timestamp() FOR SHARE OF j`,
  );
  if (!active[0])
    throw new AppError('INVALID_STATE', '差异提议任务租约已失效。', {
      details: { reason: 'LEASE_LOST' },
    });
}
export async function readMaterials(
  service: DocumentService,
  actor: ActorContext,
  refs: Array<{ id: string; version: number; purpose?: string }>,
): Promise<ProposalMaterial[]> {
  if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
    throw new AppError('VALIDATION_ERROR', '本轮材料选择不能重复。');
  if (refs.length && !service.options.readProposalMaterial)
    throw new AppError('DEPENDENCY_UNAVAILABLE', '材料只读授权服务尚未配置。');
  const result: ProposalMaterial[] = [];
  for (const ref of refs) {
    const material = await service.options.readProposalMaterial!(actor, ref);
    if (
      material.id !== ref.id ||
      material.version !== ref.version ||
      !/^[a-f0-9]{64}$/.test(material.sha256)
    )
      throw new AppError('REVALIDATION_REQUIRED', '本轮材料版本或摘要已变化。');
    result.push(material);
  }
  return result;
}
export const materialGuards = (materials: ProposalMaterial[]) =>
  materials.map(({ id, version, sha256 }) => ({ id, version, sha256 }));
export function assertEvidence(
  operations: Array<{ evidence_refs: string[] }>,
  materials: ProposalMaterial[],
  invoiceRefs: Array<{ id: string; version: number }> = [],
) {
  const prefixes = [
    ...materials.map((ref) => `${ref.id}@${ref.version}`),
    ...invoiceRefs.map((ref) => `${ref.id}@${ref.version}`),
  ];
  for (const operation of operations)
    for (const evidence of operation.evidence_refs)
      if (
        !prefixes.some(
          (prefix) => evidence === prefix || evidence.startsWith(`${prefix}#`),
        )
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '差异来源不属于本轮明确选择的材料或票据。',
        );
}
export function assertDependencySnapshot(actual: unknown, expected: unknown) {
  if (canonicalHash(actual) !== canonicalHash(expected))
    throw new AppError(
      'REVALIDATION_REQUIRED',
      '提议所用材料或票据已变化，请重新生成建议。',
    );
}
