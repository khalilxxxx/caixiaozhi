import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import {
  TravelDraftSchema,
  TravelLegSchema,
  TravelProposalModelSchema,
  TravelProposalInputSchema,
  ApplyTravelProposalSchema,
  type TravelDraft,
  type TravelOperation,
} from '@caixiaozhi/contracts/travel';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalJson } from '@caixiaozhi/platform/hash';
import { enqueueInTransaction, type DurableJob } from '@caixiaozhi/jobs/queue';
import { DocumentService, BusinessDocumentSchemas } from './documents.js';
import {
  rows,
  rawDocument,
  idempotent,
  conflict,
  missing,
  validation,
} from './store.js';
import {
  assertDependencySnapshot,
  assertEvidence,
  assertProposalLease,
  materialGuards,
  readMaterials,
} from './proposal-support.js';

export function normalizeTravelOperations(
  operations: TravelOperation[],
  draft: TravelDraft,
): TravelOperation[] {
  if (new Set(operations.map((op) => op.id)).size !== operations.length)
    throw validation('差异标识重复。');
  const existing = new Set(draft.legs.map((leg) => leg.leg_id));
  const mapping = new Map<string, string>();
  for (const op of operations)
    if (op.kind === 'insert_leg') {
      if (
        existing.has(op.temporary_leg_key) ||
        mapping.has(op.temporary_leg_key)
      )
        throw validation('新增行程临时标识必须唯一。');
      mapping.set(op.temporary_leg_key, `new:${randomUUID()}`);
    }
  const legId = (id: string) => mapping.get(id) ?? id;
  return operations.map((op) =>
    op.kind === 'insert_leg'
      ? {
          ...op,
          after_leg_id:
            op.after_leg_id === null ? null : legId(op.after_leg_id),
          leg: { ...op.leg, leg_id: legId(op.temporary_leg_key) },
        }
      : op.kind === 'reorder_legs'
        ? { ...op, old: op.old.map(legId), new: op.new.map(legId) }
        : op.kind === 'replace' && op.leg_id !== null
          ? { ...op, leg_id: legId(op.leg_id) }
          : op,
  );
}
export function applyTravelOperations(
  source: TravelDraft,
  operations: TravelOperation[],
): TravelDraft {
  const draft = structuredClone(source);
  for (const op of operations) {
    if (op.kind === 'insert_leg') {
      if (draft.legs.some((leg) => leg.leg_id === op.leg.leg_id))
        throw conflict();
      const after =
        op.after_leg_id === null
          ? -1
          : draft.legs.findIndex((leg) => leg.leg_id === op.after_leg_id);
      if (op.after_leg_id !== null && after < 0)
        throw validation('新增行程依赖的前序行程未被采纳。');
      draft.legs.splice(after + 1, 0, TravelLegSchema.parse(op.leg));
    } else if (op.kind === 'delete_leg') {
      const index = draft.legs.findIndex((leg) => leg.leg_id === op.leg_id);
      if (
        index < 0 ||
        canonicalJson(draft.legs[index]) !== canonicalJson(op.old)
      )
        throw conflict();
      draft.legs.splice(index, 1);
    } else if (op.kind === 'reorder_legs') {
      if (
        canonicalJson(draft.legs.map((leg) => leg.leg_id)) !==
          canonicalJson(op.old) ||
        new Set(op.new).size !== op.new.length ||
        op.new.length !== draft.legs.length ||
        op.new.some((id) => !draft.legs.some((leg) => leg.leg_id === id))
      )
        throw validation('重排行程必须匹配当前已采纳的完整行程集合。');
      draft.legs = op.new.map((id) =>
        draft.legs.find((leg) => leg.leg_id === id)!,
      );
    } else if (op.leg_id === null) {
      if (canonicalJson(draft[op.field]) !== canonicalJson(op.old))
        throw conflict();
      Object.assign(draft, { [op.field]: op.new });
    } else {
      const leg = draft.legs.find((leg) => leg.leg_id === op.leg_id);
      if (
        !leg ||
        canonicalJson(leg[op.field as keyof typeof leg]) !==
          canonicalJson(op.old)
      )
        throw conflict();
      Object.assign(leg, { [op.field]: op.new });
    }
  }
  draft.legs = draft.legs.map((leg, index) => ({ ...leg, ordinal: index + 1 }));
  return TravelDraftSchema.parse(draft);
}
export class TravelProposalService {
  constructor(readonly documents: DocumentService) {}
  async create(actor: ActorContext, id: string, input: unknown, key: string) {
    const parsed = TravelProposalInputSchema.parse(input),
      current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertResourceAccess(
      current,
      'travel.write.own',
      { type: 'travel', id, version: parsed.expected_version },
    );
    const materials = await readMaterials(
      this.documents,
      current,
      parsed.selected_material_refs,
    );
    const generation = (await this.documents.identity.getMe(current))
      .generation;
    return idempotent(
      this.documents.database,
      current,
      'travel.propose',
      key,
      { id, ...parsed },
      async (tx) => {
        const head = await rawDocument(tx, current, 'travel', id, true);
        if (head.version !== parsed.expected_version) throw conflict();
        if (!['draft', 'returned', 'withdrawn'].includes(head.state))
          throw new AppError('INVALID_STATE', '当前单据不能生成草稿差异。');
        const source = await this.documents.project(tx, 'travel', head),
          taskId = randomUUID();
        await tx.execute(
          sql`INSERT INTO travel_proposal_tasks(tenant_id,id,owner_id,travel_id,base_version,prompt,selected_material_refs,state,actor_context,source_snapshot,dependency_snapshot) VALUES(${current.tenant_id},${taskId},${current.user_id},${id},${head.version},${parsed.prompt},${JSON.stringify(parsed.selected_material_refs)}::jsonb,'queued',${JSON.stringify(current)}::jsonb,${JSON.stringify(source)}::jsonb,${JSON.stringify({ materials: materialGuards(materials) })}::jsonb)`,
        );
        const job = await (
          this.documents.options.enqueueDomainJob ?? enqueueInTransaction
        )(tx, {
          tenant_id: current.tenant_id,
          owner_module: 'travel',
          kind: 'travel.proposal',
          payload_ref: taskId,
          dedupe_key: taskId,
          generation,
        });
        await tx.execute(
          sql`UPDATE travel_proposal_tasks SET job_id=${job.id} WHERE tenant_id=${current.tenant_id} AND id=${taskId}`,
        );
        return {
          task_id: taskId,
          proposal_id: taskId,
          job_id: job.id,
          status: 'queued',
          base_version: head.version,
        };
      },
    );
  }
  async get(actor: ActorContext, travelId: string, id: string) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.get(current, 'travel', travelId);
    const [proposal] = await rows<any>(
      this.documents.database.db,
      sql`SELECT * FROM travel_proposals WHERE tenant_id=${current.tenant_id} AND id=${id} AND travel_id=${travelId} AND owner_id=${current.user_id}`,
    );
    if (proposal)
      return {
        id: proposal.id,
        base_version: proposal.base_version,
        status: proposal.state,
        operations: proposal.operations,
        clarifications: proposal.clarifications,
        selected_material_refs: proposal.selected_material_refs,
        applied_operation_ids: proposal.applied_operation_ids,
        requires_review: true,
      };
    const [task] = await rows<any>(
      this.documents.database.db,
      sql`SELECT id,base_version,state,error_code,selected_material_refs FROM travel_proposal_tasks WHERE tenant_id=${current.tenant_id} AND id=${id} AND travel_id=${travelId} AND owner_id=${current.user_id}`,
    );
    if (!task) throw missing();
    return {
      ...task,
      status: task.state,
      operations: [],
      clarifications: [],
      requires_review: true,
    };
  }
  async processJob(job: DurableJob) {
    await assertProposalLease(this.documents.database.db, job);
    const [task] = await rows<any>(
      this.documents.database.db,
      sql`SELECT * FROM travel_proposal_tasks WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref}`,
    );
    if (!task) throw missing();
    if (task.state === 'completed') return;
    try {
      await this.documents.database.db.transaction(async (tx) => {
        await assertProposalLease(tx, job);
        await tx.execute(
          sql`UPDATE travel_proposal_tasks SET state='running',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${task.id}`,
        );
      });
      if (!this.documents.options.proposeTravel)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '差旅语义建议需要配置真实模型。',
        );
      const actor = await this.documents.identity.requireCurrentActor(
          task.actor_context,
        ),
        current = await this.documents.get(actor, 'travel', task.travel_id);
      if (current.version !== task.base_version)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '单据已更新，请基于新版本重新生成建议。',
        );
      const materials = await readMaterials(
        this.documents,
        actor,
        task.selected_material_refs,
      );
      if (task.dependency_snapshot?.materials)
        assertDependencySnapshot(
          { materials: materialGuards(materials) },
          task.dependency_snapshot,
        );
      const source = BusinessDocumentSchemas.travel.parse(
        task.source_snapshot?.legs ? task.source_snapshot : current,
      );
      const generated = TravelProposalModelSchema.parse(
        await this.documents.options.proposeTravel({
          actor,
          document: source,
          prompt: task.prompt,
          material_refs: materials,
        }),
      );
      assertEvidence(generated.operations, materials);
      const draft = TravelDraftSchema.parse(
        Object.fromEntries(
          Object.keys(TravelDraftSchema.shape).map((field) => [
            field,
            source[field as keyof typeof TravelDraftSchema.shape],
          ]),
        ),
      );
      const operations = normalizeTravelOperations(generated.operations, draft);
      applyTravelOperations(draft, operations);
      await this.documents.database.db.transaction(async (tx) => {
        await assertProposalLease(tx, job);
        const head = await rawDocument(
          tx,
          actor,
          'travel',
          task.travel_id,
          true,
        );
        const latestMaterials = await readMaterials(
          this.documents,
          actor,
          task.selected_material_refs,
        );
        const fresh =
          head.version === task.base_version &&
          canonicalJson(materialGuards(latestMaterials)) ===
            canonicalJson(materialGuards(materials));
        await tx.execute(
          sql`INSERT INTO travel_proposals(tenant_id,id,travel_id,owner_id,base_version,state,operations,clarifications,selected_material_refs,source_snapshot,dependency_snapshot) VALUES(${actor.tenant_id},${task.id},${task.travel_id},${actor.user_id},${task.base_version},${fresh ? 'proposed' : 'stale'},${JSON.stringify(operations)}::jsonb,${JSON.stringify(generated.clarifications)}::jsonb,${JSON.stringify(task.selected_material_refs)}::jsonb,${JSON.stringify(source)}::jsonb,${JSON.stringify({ materials: materialGuards(materials) })}::jsonb) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`UPDATE travel_proposal_tasks SET state='completed',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${actor.tenant_id} AND id=${task.id}`,
        );
      });
    } catch (error) {
      if (error instanceof AppError && error.details?.reason === 'LEASE_LOST')
        throw error;
      await this.documents.database.db.transaction(async (tx) => {
        await assertProposalLease(tx, job);
        await tx.execute(
          sql`UPDATE travel_proposal_tasks SET state='failed',error_code=${error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE'},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${task.id}`,
        );
      });
      throw error;
    }
  }
  async apply(
    actor: ActorContext,
    travelId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    const parsed = ApplyTravelProposalSchema.parse(input),
      current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertResourceAccess(
      current,
      'travel.write.own',
      { type: 'travel', id: travelId, version: parsed.expected_version },
    );
    return idempotent(
      this.documents.database,
      current,
      'travel.proposal.apply',
      key,
      { id, travelId, ...parsed },
      async (tx) => {
        const head = await rawDocument(tx, current, 'travel', travelId, true);
        if (head.version !== parsed.expected_version) throw conflict();
        const [proposal] = await rows<any>(
          tx,
          sql`SELECT * FROM travel_proposals WHERE tenant_id=${current.tenant_id} AND id=${id} AND travel_id=${travelId} AND owner_id=${current.user_id} FOR UPDATE`,
        );
        if (!proposal) throw missing();
        if (
          proposal.base_version !== parsed.expected_version ||
          proposal.state !== 'proposed'
        )
          throw conflict();
        const materials = await readMaterials(
          this.documents,
          current,
          proposal.selected_material_refs,
        );
        if (proposal.dependency_snapshot?.materials)
          assertDependencySnapshot(
            { materials: materialGuards(materials) },
            proposal.dependency_snapshot,
          );
        if (
          new Set(parsed.selected_operation_ids).size !==
            parsed.selected_operation_ids.length ||
          parsed.selected_operation_ids.some(
            (selected) =>
              !proposal.operations.some(
                (op: TravelOperation) => op.id === selected,
              ),
          )
        )
          throw validation('所选差异不属于本次提议或包含重复项。');
        const source = await this.documents.project(tx, 'travel', head),
          draft = TravelDraftSchema.parse(
            Object.fromEntries(
              Object.keys(TravelDraftSchema.shape).map((field) => [
                field,
                source[field as keyof typeof source],
              ]),
            ),
          );
        const combined = applyTravelOperations(
          draft,
          (proposal.operations as TravelOperation[]).filter((op) =>
            parsed.selected_operation_ids.includes(op.id),
          ),
        );
        const saved = await this.documents.saveTravel(
          current,
          travelId,
          { ...combined, expected_version: parsed.expected_version },
          key,
          tx,
        );
        await tx.execute(
          sql`UPDATE travel_proposals SET state='applied',applied_operation_ids=${JSON.stringify(parsed.selected_operation_ids)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
        );
        return saved;
      },
    );
  }
}
