import { z } from 'zod';
import type { ActorContext, ResourceRef } from './common.js';
import type { PreauditVersionLock } from './preaudit.js';
export type PreauditEligibilityInput = {
  resource_ref: ResourceRef;
  task_ref: { id: string; version: number };
  preaudit_result_id: string;
  expected_purpose: 'manager_review' | 'finance_review';
  expected_guards?: { result_hash: string; lock_hash: string };
};
export type EligibilityProof = {
  eligible: boolean;
  result_id: string;
  reviewer_id: string;
  result_hash: string;
  lock_hash: string;
  locked_versions: PreauditVersionLock;
  checked_at: string;
  rejection_reasons: string[];
};
export const ManualReviewAckSchema = z.strictObject({
  preaudit_result_id: z.string().min(1),
  result_hash: z.string().regex(/^[a-f0-9]{64}$/),
  lock_hash: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledged_finding_ids: z.array(z.string().min(1)).max(1000),
});
export type ManualReviewAck = z.infer<typeof ManualReviewAckSchema>;
/** UnitOfWork 由实现方注入，公共合同不依赖任何数据库包。 */
export interface PreauditEligibilityPort<UnitOfWork = unknown> {
  check(
    ctx: ActorContext,
    input: PreauditEligibilityInput,
    tx?: UnitOfWork,
  ): Promise<EligibilityProof>;
}
