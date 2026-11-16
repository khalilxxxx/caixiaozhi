import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext, ToolResult } from '@caixiaozhi/contracts/common';
import {
  RuleTestStartSchema,
  RuleTestToolInputSchema,
  RuleTestProofSchema,
  RuleTestHttpProofSchema,
  RuleTestSetCreateSchema,
  RuleTestSetViewSchema,
  RuleTestSetListSchema,
  type RuleTestSetView,
  type RuleTestSetList,
  RuleTestTaskViewSchema,
  type RuleTestTaskAccepted,
  type RuleTestTaskView,
  type SrsInput,
  type Truth,
} from '@caixiaozhi/contracts/rules';
import type {
  DatabaseConnection,
  DatabaseExecutor,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { DurableJob } from '@caixiaozhi/jobs/queue';
import type { FinanceOptions } from './ports.js';
import type { RuleService } from './rules.js';
import {
  assertDomainLease,
  command,
  iso,
  json,
  outbox,
  rows,
} from './database.js';
import { canonicalHash } from './hash.js';
type TestTarget = Awaited<ReturnType<RuleService['getTestTarget']>>;
type FixtureCase = { name: string; input: SrsInput; expected_truth: Truth };
type TaskRow = {
  id: string;
  tenant_id: string;
  owner_id: string;
  actor_context: ActorContext;
  authz_version: number;
  rule_id: string;
  rule_version: number;
  draft_version_id: string;
  draft_version: number;
  draft_hash: string;
  compiled_hash: string;
  mapping_hash: string;
  mapping_snapshot_hash: string;
  test_set_hash: string;
  test_set_id: string;
  cases_json: FixtureCase[];
  status: RuleTestTaskView['status'];
  total_cases: number;
  completed_cases: number;
  job_id: string;
  origin_run_id: string | null;
  proof_id: string | null;
  error_code: string | null;
  version: number;
  created_at: Date | string;
  finished_at: Date | string | null;
};
type TestSetRow = {
  tenant_id: string;
  id: string;
  owner_id: string;
  rule_id: string;
  rule_version: number;
  draft_version_id: string;
  draft_version: number;
  draft_hash: string;
  name: string;
  cases_json: FixtureCase[];
  test_set_hash: string;
  content_hash: string;
  created_at: Date | string;
};
type ToolContext = {
  actor: ActorContext;
  run_id: string;
  call_id?: string;
  validation_trial?: string;
};

/** boundary-v1只解析受控金额比较；预期真值独立于解释器实现。 */
export function resolveRuleBoundaryCases(target: TestTarget): FixtureCase[] {
  const dsl = target.parsed.dsl_json,
    predicate = dsl.predicate;
  const unsupported = () =>
    new AppError(
      'VALIDATION_ERROR',
      'boundary-v1仅支持明确的单据金额或单类费用合计与人民币阈值比较，请为其他规则登记专用测试集。',
      { details: { reason: 'UNSUPPORTED_TEST_SET' } },
    );
  if (
    predicate.op !== 'compare' ||
    predicate.comparator === 'in' ||
    predicate.right.op !== 'literal'
  )
    throw unsupported();
  const comparator = predicate.comparator,
    value = predicate.right.value;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('amount_minor' in value) ||
    value.currency !== 'CNY'
  )
    throw unsupported();
  const left = predicate.left;
  if (left.op === 'field') {
    if (left.path !== 'total_amount') throw unsupported();
  } else if (left.op === 'sum') {
    if (
      left.collection !== 'expense_items' ||
      left.value.op !== 'field' ||
      left.value.path !== 'item.amount' ||
      left.where?.op !== 'compare' ||
      left.where.comparator !== 'eq' ||
      left.where.left.op !== 'field' ||
      left.where.left.path !== 'item.category' ||
      left.where.right.op !== 'literal' ||
      left.where.right.value !== target.parsed.category
    )
      throw unsupported();
  } else throw unsupported();
  const expected: Record<
    Exclude<typeof predicate.comparator, 'in'>,
    [Truth, Truth, Truth, Truth]
  > = {
    gt: ['false', 'false', 'true', 'unknown'],
    gte: ['false', 'true', 'true', 'unknown'],
    lt: ['true', 'false', 'false', 'unknown'],
    lte: ['true', 'true', 'false', 'unknown'],
    eq: ['false', 'true', 'false', 'unknown'],
    ne: ['true', 'false', 'true', 'unknown'],
  };
  const threshold = BigInt(value.amount_minor),
    businessDate = dsl.applicability.effective_from,
    department = dsl.applicability.department_ids[0]!;
  return [threshold - 1n, threshold, threshold + 1n, null].map(
    (minor, index) => {
      const amount =
        minor === null
          ? null
          : { amount_minor: minor.toString(), currency: 'CNY' as const };
      return {
        name: ['阈值少1分', '恰等阈值', '阈值多1分', '金额未知'][index]!,
        expected_truth: expected[comparator][index]!,
        input: {
          schema_version: 1,
          document: {
            type: dsl.applicability.modules[0]!,
            id: `synthetic-boundary-${index}`,
            version: 1,
          },
          business_date: businessDate,
          applicant_id: 'synthetic-applicant',
          department_id: department,
          total_amount: amount,
          expense_items: [
            {
              id: 'synthetic-line',
              category: target.parsed.category,
              source_expense_type: target.parsed.category,
              amount,
              invoice_refs: ['synthetic-invoice'],
              spent_on: businessDate,
              room_nights: null,
              oa_request_ref: null,
            },
          ],
          invoices: [
            {
              id: 'synthetic-invoice',
              amount,
              invoice_number: 'DEMO-SYNTHETIC',
              verified: true,
            },
          ],
          external_facts: {},
          field_states: {},
        },
      };
    },
  );
}

export class RuleTestService {
  constructor(
    readonly database: DatabaseConnection,
    readonly options: FinanceOptions,
    readonly rules: RuleService,
  ) {}
  private setContentHash(set: Omit<TestSetRow, 'created_at' | 'content_hash'>) {
    return canonicalHash({
      tenant_id: set.tenant_id,
      id: set.id,
      owner_id: set.owner_id,
      rule_id: set.rule_id,
      rule_version: set.rule_version,
      draft_version_id: set.draft_version_id,
      draft_version: set.draft_version,
      draft_hash: set.draft_hash,
      name: set.name,
      cases: set.cases_json,
      test_set_hash: set.test_set_hash,
    });
  }
  private verifySet(set: TestSetRow) {
    const cases = RuleTestSetCreateSchema.shape.cases.parse(set.cases_json);
    if (
      canonicalHash(cases) !== set.test_set_hash ||
      this.setContentHash(set) !== set.content_hash
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '人工样例集合完整性校验失败，请重新登记。',
      );
    return cases;
  }
  private setView(set: TestSetRow, current: boolean): RuleTestSetView {
    return RuleTestSetViewSchema.parse({
      id: set.id,
      rule_id: set.rule_id,
      owner_id: set.owner_id,
      rule_version: set.rule_version,
      draft_version_id: set.draft_version_id,
      draft_version: set.draft_version,
      draft_hash: set.draft_hash,
      name: set.name,
      cases: this.verifySet(set),
      case_count: set.cases_json.length,
      test_set_hash: set.test_set_hash,
      content_hash: set.content_hash,
      status: current ? 'current' : 'stale',
      created_at: iso(set.created_at),
    });
  }
  async createTestSet(
    actor: ActorContext,
    ruleId: string,
    input: unknown,
    key: string,
  ): Promise<RuleTestSetView> {
    const parsed = RuleTestSetCreateSchema.parse(input),
      current = await this.options.identity.requireCurrentActor(actor);
    // 幂等重放也必须拥有当前草稿的维护权限，不能绕过已变化的授权。
    await this.rules.getTestTarget(current, ruleId, parsed.expected_version);
    return command(
      this.database,
      current,
      'rule.test-set.create',
      key,
      { rule_id: ruleId, ...parsed },
      async (tx) => {
        const target = await this.rules.getTestTarget(
            current,
            ruleId,
            parsed.expected_version,
            tx,
          ),
          snapshot = {
            tenant_id: current.tenant_id,
            id: `rts-${randomUUID()}`,
            owner_id: current.user_id,
            rule_id: ruleId,
            rule_version: parsed.expected_version,
            draft_version_id: String(target.draft.id),
            draft_version: Number(target.draft.version_number),
            draft_hash: String(target.draft.content_hash),
            name: parsed.name,
            cases_json: parsed.cases,
            test_set_hash: canonicalHash(parsed.cases),
          },
          contentHash = this.setContentHash(snapshot),
          stored = (
            await rows<TestSetRow>(
              tx,
              sql`INSERT INTO rule_test_sets(tenant_id,id,owner_id,rule_id,rule_version,draft_version_id,draft_version,draft_hash,name,cases_json,test_set_hash,content_hash) VALUES(${snapshot.tenant_id},${snapshot.id},${snapshot.owner_id},${snapshot.rule_id},${snapshot.rule_version},${snapshot.draft_version_id},${snapshot.draft_version},${snapshot.draft_hash},${snapshot.name},${json(snapshot.cases_json)}::jsonb,${snapshot.test_set_hash},${contentHash}) RETURNING *`,
            )
          )[0]!;
        return this.setView(stored, true);
      },
    );
  }
  async listTestSets(
    actor: ActorContext,
    ruleId: string,
  ): Promise<RuleTestSetList> {
    const current = await this.options.identity.requireCurrentActor(actor),
      rule = await this.rules.getRule(current, ruleId),
      personal = rule.level === 'personal';
    await this.options.identity.assertPermission(
      current,
      personal ? 'rule.manage.personal' : 'rule.manage.company',
    );
    if (current.invocation_origin !== 'interactive')
      throw new AppError('FORBIDDEN', '后台身份不能读取人工规则样例。');
    const allowed = personal
      ? [
          (await this.options.identity.getMe(current)).department_id,
          ...current.department_ids,
        ]
      : (
          await this.options.identity.getResourceScope(
            current,
            'rule.manage.company',
          )
        ).department_ids;
    const permitted = (
      version:
        | { dsl_json: { applicability: { department_ids: string[] } } }
        | undefined,
    ) =>
      !!version &&
      version.dsl_json.applicability.department_ids.length > 0 &&
      version.dsl_json.applicability.department_ids.every((department) =>
        allowed.includes(department),
      );
    const head =
      rule.versions.find(
        (version: { id: string }) =>
          version.id === (rule.draft_version_id ?? rule.active_version_id),
      ) ?? rule.versions.at(-1);
    if (!permitted(head))
      throw new AppError('FORBIDDEN', '规则组织不在当前管理授权范围内。');
    const found = await rows<TestSetRow>(
      this.database.db,
      sql`SELECT * FROM rule_test_sets WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND rule_id=${ruleId} ORDER BY created_at DESC,id DESC`,
    );
    return RuleTestSetListSchema.parse({
      items: found
        .filter((set) =>
          permitted(
            rule.versions.find(
              (version: { id: string }) => version.id === set.draft_version_id,
            ),
          ),
        )
        .map((set) =>
          this.setView(
            set,
            rule.version === set.rule_version &&
              rule.draft_version_id === set.draft_version_id &&
              Number(head.version_number) === set.draft_version &&
              head.content_hash === set.draft_hash,
          ),
        ),
      next_cursor: null,
    });
  }
  private async binding(
    actor: ActorContext,
    id: string,
    expected: number,
    tx: DatabaseExecutor,
    testSetId = 'boundary-v1',
  ) {
    const target = await this.rules.getTestTarget(actor, id, expected, tx);
    let cases: FixtureCase[];
    if (testSetId === 'boundary-v1') cases = resolveRuleBoundaryCases(target);
    else {
      const set = (
        await rows<TestSetRow>(
          tx,
          sql`SELECT * FROM rule_test_sets WHERE tenant_id=${actor.tenant_id} AND owner_id=${actor.user_id} AND rule_id=${id} AND id=${testSetId}`,
        )
      )[0];
      if (!set)
        throw new AppError('NOT_FOUND', '人工样例集合不存在或无权访问。');
      cases = this.verifySet(set);
      if (
        set.rule_version !== expected ||
        set.draft_version_id !== target.draft.id ||
        set.draft_version !== Number(target.draft.version_number) ||
        set.draft_hash !== target.draft.content_hash
      )
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '人工样例绑定的草稿已变化，请重新登记。',
        );
    }
    const mapping = await this.rules.getTestMappingSnapshot(
      actor,
      target.parsed.dsl_json,
      target.compiled,
      target.mapping,
      tx,
    );
    return {
      target,
      cases,
      mapping,
      authz_version: actor.authz_version,
      draft_version_id: String(target.draft.id),
      draft_version: Number(target.draft.version_number),
      draft_hash: String(target.draft.content_hash),
      compiled_hash: target.compiled.compiled_hash,
      mapping_hash: canonicalHash({ revision: target.mapping }),
      mapping_snapshot_hash: canonicalHash(mapping),
      test_set_hash: canonicalHash(cases),
    };
  }
  private same(
    task: TaskRow,
    binding: Awaited<ReturnType<RuleTestService['binding']>>,
  ) {
    return (
      task.authz_version === binding.authz_version &&
      task.draft_version_id === binding.draft_version_id &&
      task.draft_version === binding.draft_version &&
      task.draft_hash === binding.draft_hash &&
      task.compiled_hash === binding.compiled_hash &&
      task.mapping_hash === binding.mapping_hash &&
      task.mapping_snapshot_hash === binding.mapping_snapshot_hash &&
      task.test_set_hash === binding.test_set_hash
    );
  }
  async start(
    actor: ActorContext,
    ruleId: string,
    input: unknown,
    key: string,
    context: { origin_run_id?: string | null } = {},
  ): Promise<RuleTestTaskAccepted> {
    const commandInput = RuleTestStartSchema.parse(input),
      current = await this.options.identity.requireCurrentActor(actor),
      origin = context.origin_run_id ?? null;
    if (origin) {
      if (this.options.authorizeOriginRun)
        await this.options.authorizeOriginRun(current, origin);
      else if (
        !(
          await rows(
            this.database.db,
            sql`SELECT id FROM agent_runs WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND id=${origin}`,
          )
        )[0]
      )
        throw new AppError('NOT_FOUND', '发起规则测试的任务不存在。');
    }
    const generation = (await this.options.identity.getMe(current)).generation;
    if (!this.options.jobs)
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '持久规则测试队列尚未配置。',
      );
    await this.binding(
      current,
      ruleId,
      commandInput.expected_version,
      this.database.db,
      commandInput.test_set_id,
    );
    return command(
      this.database,
      current,
      'rule.test.start',
      key,
      { rule_id: ruleId, ...commandInput, origin_run_id: origin },
      async (tx) => {
        const binding = await this.binding(
            current,
            ruleId,
            commandInput.expected_version,
            tx,
            commandInput.test_set_id,
          ),
          dedupe = canonicalHash({
            actor: current.user_id,
            authz_version: current.authz_version,
            rule_id: ruleId,
            rule_version: commandInput.expected_version,
            test_set_id: commandInput.test_set_id,
            draft: binding.draft_version_id,
            draft_hash: binding.draft_hash,
            compiled_hash: binding.compiled_hash,
            mapping_hash: binding.mapping_hash,
            mapping_snapshot_hash: binding.mapping_snapshot_hash,
            test_set_hash: binding.test_set_hash,
          });
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${current.tenant_id}:rule-test:${dedupe}`},0))`,
        );
        const existing = (
          await rows<TaskRow>(
            tx,
            sql`SELECT * FROM rule_test_tasks WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND dedupe_key=${dedupe} AND status IN('queued','running','completed') LIMIT 1`,
          )
        )[0];
        if (existing)
          return {
            task_id: existing.id,
            test_run_id: existing.id,
            rule_id: ruleId,
            job_id: existing.job_id,
            origin_run_id: existing.origin_run_id,
            status: 'queued',
            poll_after_ms: 1000,
          };
        const taskId = randomUUID(),
          job = await this.options.jobs!.enqueueInTransaction(tx, {
            tenant_id: current.tenant_id,
            owner_module: 'rules',
            kind: 'rules.test',
            payload_ref: taskId,
            dedupe_key: taskId,
            generation,
          });
        await tx.execute(
          sql`INSERT INTO rule_test_tasks(tenant_id,id,owner_id,actor_context,authz_version,rule_id,rule_version,draft_version_id,draft_version,draft_hash,compiled_hash,mapping_hash,mapping_snapshot_hash,mapping_snapshot,test_set_id,test_set_hash,cases_json,total_cases,dedupe_key,status,job_id,origin_run_id) VALUES(${current.tenant_id},${taskId},${current.user_id},${json(current)}::jsonb,${current.authz_version},${ruleId},${commandInput.expected_version},${binding.draft_version_id},${binding.draft_version},${binding.draft_hash},${binding.compiled_hash},${binding.mapping_hash},${binding.mapping_snapshot_hash},${json(binding.mapping)}::jsonb,${commandInput.test_set_id},${binding.test_set_hash},${json(binding.cases)}::jsonb,${binding.cases.length},${dedupe},'queued',${job.id},${origin})`,
        );
        return {
          task_id: taskId,
          test_run_id: taskId,
          rule_id: ruleId,
          job_id: job.id,
          origin_run_id: origin,
          status: 'queued',
          poll_after_ms: 1000,
        };
      },
    );
  }
  async get(
    actor: ActorContext,
    ruleId: string,
    id: string,
  ): Promise<RuleTestTaskView> {
    const current = await this.options.identity.requireCurrentActor(actor),
      task = (
        await rows<TaskRow>(
          this.database.db,
          sql`SELECT * FROM rule_test_tasks WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND rule_id=${ruleId} AND id=${id}`,
        )
      )[0];
    if (!task)
      throw new AppError('NOT_FOUND', '规则测试任务不存在或无权访问。');
    let status = task.status,
      error = task.error_code;
    try {
      const binding = await this.binding(
        current,
        ruleId,
        task.rule_version,
        this.database.db,
        task.test_set_id,
      );
      if (!this.same(task, binding)) {
        status = 'stale';
        error = 'REVALIDATION_REQUIRED';
      }
    } catch (error) {
      if (
        error instanceof AppError &&
        ['VERSION_CONFLICT', 'REVALIDATION_REQUIRED', 'INVALID_STATE'].includes(
          error.code,
        )
      ) {
        status = 'stale';
      } else throw error;
    }
    if (status === 'stale') error = 'REVALIDATION_REQUIRED';
    let proof = null;
    if (status === 'completed' && task.proof_id) {
      const record = (
        await rows<{
          id: string;
          passed: boolean;
          compiled_hash: string;
          mapping_hash: string;
          test_set_hash: string;
          results: unknown;
        }>(
          this.database.db,
          sql`SELECT id,passed,compiled_hash,mapping_hash,test_set_hash,results FROM rule_test_runs WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND id=${task.proof_id} AND job_id=${task.job_id}`,
        )
      )[0];
      if (!record)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '规则测试证明尚未完整提交。',
        );
      proof = RuleTestHttpProofSchema.parse({
        test_run_id: record.id,
        passed: record.passed,
        compiled_hash: record.compiled_hash,
        mapping_hash: record.mapping_hash,
        test_set_hash: record.test_set_hash,
        draft_hash: task.draft_hash,
        results: record.results,
      });
    }
    return RuleTestTaskViewSchema.parse({
      id: task.id,
      task_id: task.id,
      test_run_id: task.id,
      rule_id: ruleId,
      job_id: task.job_id,
      origin_run_id: task.origin_run_id,
      status,
      version: task.version,
      rule_version: task.rule_version,
      draft_version_id: task.draft_version_id,
      draft_version: task.draft_version,
      draft_hash: task.draft_hash,
      compiled_hash: task.compiled_hash,
      mapping_hash: task.mapping_hash,
      test_set_hash: task.test_set_hash,
      test_set_id: task.test_set_id,
      total_cases: task.total_cases,
      completed_cases: task.completed_cases,
      cases: task.cases_json.map((c) => ({
        case_id: c.input.document.id,
        name: c.name,
        amount_minor: c.input.total_amount?.amount_minor ?? null,
        expected_truth: c.expected_truth,
      })),
      proof,
      error_code: error,
      created_at: iso(task.created_at),
      finished_at: task.finished_at ? iso(task.finished_at) : null,
    });
  }
  async processJob(job: DurableJob): Promise<void> {
    if (job.kind !== 'rules.test')
      throw new AppError('INVALID_STATE', '不是规则测试领域作业。');
    try {
      await this.database.db.transaction(async (tx) => {
        await assertDomainLease(tx, job);
        const task = (
          await rows<TaskRow>(
            tx,
            sql`SELECT * FROM rule_test_tasks WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref} AND job_id=${job.id} FOR UPDATE`,
          )
        )[0];
        if (!task) throw new AppError('NOT_FOUND', '规则测试任务不存在。');
        if (['completed', 'failed', 'stale', 'cancelled'].includes(task.status))
          return;
        const actor = await this.options.identity.requireCurrentActor(
            task.actor_context,
          ),
          binding = await this.binding(
            actor,
            task.rule_id,
            task.rule_version,
            tx,
            task.test_set_id,
          );
        if (!this.same(task, binding))
          throw new AppError('REVALIDATION_REQUIRED', '规则或映射快照已变化。');
        await tx.execute(
          sql`UPDATE rule_test_tasks SET status='running',version=version+1,updated_at=now() WHERE tenant_id=${job.tenant_id} AND id=${task.id}`,
        );
        const proof = await this.rules.testRule(
          actor,
          task.rule_id,
          task.rule_version,
          binding.cases,
          `rule-test-task:${task.id}`,
          { tx, testRunId: task.id, jobId: job.id },
        );
        if (
          proof.compiled_hash !== task.compiled_hash ||
          proof.draft_hash !== task.draft_hash ||
          proof.mapping_hash !== task.mapping_hash ||
          proof.test_set_hash !== task.test_set_hash
        )
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '测试证明与任务冻结内容不一致。',
          );
        await assertDomainLease(tx, job);
        await tx.execute(
          sql`UPDATE rule_test_tasks SET status='completed',proof_id=${proof.test_run_id},completed_cases=${binding.cases.length},error_code=NULL,finished_at=now(),version=version+1,updated_at=now() WHERE tenant_id=${job.tenant_id} AND id=${task.id}`,
        );
        await outbox(
          tx,
          actor,
          'rule.test.completed',
          'rule',
          task.rule_id,
          task.rule_version,
          {
            task_id: task.id,
            test_run_id: proof.test_run_id,
            job_id: job.id,
            passed: proof.passed,
            draft_hash: proof.draft_hash,
            compiled_hash: proof.compiled_hash,
            mapping_hash: proof.mapping_hash,
          },
        );
      });
    } catch (error) {
      if (error instanceof AppError && error.details?.reason === 'LEASE_LOST')
        throw error;
      const code =
          error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
        status = [
          'VERSION_CONFLICT',
          'REVALIDATION_REQUIRED',
          'INVALID_STATE',
        ].includes(code)
          ? 'stale'
          : 'failed';
      await this.database.db.transaction(async (tx) => {
        await assertDomainLease(tx, job);
        await tx.execute(
          sql`UPDATE rule_test_tasks SET status=${status},proof_id=NULL,error_code=${code},finished_at=now(),version=version+1,updated_at=now() WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref} AND status IN('queued','running')`,
        );
      });
      if (status === 'failed') throw error;
    }
  }
  async dispatchTool(
    input: unknown,
    context: ToolContext,
    options: { origin_run_id?: string | null } = {},
  ): Promise<ToolResult> {
    const parsed = RuleTestToolInputSchema.parse(input),
      actor = await this.options.identity.requireCurrentActor(context.actor),
      rule = await this.rules.getRule(actor, parsed.rule_id),
      draft = rule.versions.find(
        (v: { id: string }) => v.id === rule.draft_version_id,
      );
    if (!draft || Number(draft.version_number) !== parsed.draft_version)
      throw new AppError('VERSION_CONFLICT', '工具绑定的草稿内容版本已变化。');
    const origin =
      options.origin_run_id === undefined
        ? context.validation_trial
          ? null
          : context.run_id
        : options.origin_run_id;
    const accepted = await this.start(
        actor,
        rule.id,
        { expected_version: rule.version, test_set_id: parsed.test_set_id },
        canonicalHash({
          run_id: context.run_id,
          call_id: context.call_id ?? null,
          input: parsed,
        }),
        { origin_run_id: origin },
      ),
      current = await this.get(actor, rule.id, accepted.task_id);
    if (current.status === 'stale')
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '测试依赖已变化，请重新测试。',
      );
    return {
      status: 'ok',
      data:
        current.status === 'completed'
          ? RuleTestProofSchema.parse(current.proof)
          : accepted,
      evidence_refs:
        current.status === 'completed' ? [`rule-test:${accepted.task_id}`] : [],
      action_id: null,
      error_code: null,
    };
  }
}
