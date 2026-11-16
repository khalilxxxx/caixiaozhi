import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import type {
  SrsInputSnapshot,
  RuleDraftInput,
  RuleProposalSchema,
} from '@caixiaozhi/contracts/rules';
import type { z } from 'zod';
import type { RetrievalSnapshot } from '@caixiaozhi/contracts/knowledge';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import type { IdentityService } from '@caixiaozhi/identity';
import type { FileService } from '@caixiaozhi/files';
import type { createDurableQueue } from '@caixiaozhi/jobs/queue';
export type ApprovalTaskSnapshot = {
  id: string;
  version: number;
  assigned_to: string;
  stage: 'manager' | 'finance';
  status: 'pending' | 'approved' | 'returned' | 'cancelled';
};
export interface FinanceBusinessPort {
  getPreauditInput(
    ctx: ActorContext,
    id: string,
    version: number,
    tx?: DatabaseExecutor,
  ): Promise<SrsInputSnapshot>;
  getApprovalTask(
    ctx: ActorContext,
    documentRef: ResourceRef,
    tx?: DatabaseExecutor,
  ): Promise<ApprovalTaskSnapshot | null>;
  listCurrentApprovalDocuments(ctx: ActorContext): Promise<ResourceRef[]>;
}
export type FinanceOptions = {
  identity: IdentityService;
  business: FinanceBusinessPort;
  files?: FileService;
  jobs?: ReturnType<typeof createDurableQueue>;
  proposeRule?: (
    ctx: ActorContext,
    input: z.infer<typeof RuleProposalSchema>,
  ) => Promise<RuleDraftInput>;
  answerKnowledge?: (
    ctx: ActorContext,
    input: { query: string; snapshot: RetrievalSnapshot },
  ) => Promise<{
    blocks: Array<{ text: string; citation_ids: string[] }>;
    model_version?: string;
  }>;
  knowledgeModelVersion?: string;
  authorizeOriginRun?: (ctx: ActorContext, runId: string) => Promise<void>;
};
