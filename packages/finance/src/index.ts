import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActorContext,
  ActionReceipt,
  ResourceRef,
} from '@caixiaozhi/contracts/common';
import type { KnowledgeSearch } from '@caixiaozhi/contracts/knowledge';
import type { StartPreauditCommand } from '@caixiaozhi/contracts/preaudit';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { createDurableQueue, type DurableJob } from '@caixiaozhi/jobs/queue';
import type {
  ActionHandler,
  ActionContext,
  ConfirmedAction,
} from '@caixiaozhi/business-adapters/ports';
import { KnowledgeService } from './knowledge.js';
import { RuleService } from './rules.js';
import { RuleTestService } from './rule-tests.js';
import { MappingService } from './mapping-service.js';
import { MappingPublishArgsSchema } from '@caixiaozhi/contracts/mappings';
import { PreauditService } from './preaudit.js';
import type { FinanceOptions } from './ports.js';
import { BASELINE_RULES, personalMealsDsl } from './rule-seeds.js';
import { canonicalHash } from './hash.js';
import { json, rows } from './database.js';
export * from './ports.js';
export * from './hash.js';
export * from './evaluator.js';
export * from './knowledge.js';
export * from './rules.js';
export * from './rule-tests.js';
export * from './mapping-service.js';
export * from './preaudit.js';

export class FinanceService {
  readonly knowledge: KnowledgeService;
  readonly rules: RuleService;
  readonly ruleTests: RuleTestService;
  readonly mappings: MappingService;
  readonly preaudit: PreauditService;
  readonly preauditEligibility: { check: PreauditService['check'] };
  readonly options: FinanceOptions;
  constructor(
    readonly database: DatabaseConnection,
    options: FinanceOptions,
  ) {
    this.options = {
      ...options,
      jobs: options.jobs ?? createDurableQueue(database),
    };
    this.knowledge = new KnowledgeService(database, this.options);
    this.rules = new RuleService(database, this.options, this.knowledge);
    this.ruleTests = new RuleTestService(database, this.options, this.rules);
    this.mappings = new MappingService(database, this.options.identity);
    this.preaudit = new PreauditService(database, this.options, this.rules);
    this.preauditEligibility = {
      check: this.preaudit.check.bind(this.preaudit),
    };
  }
  startPreaudit(
    ctx: ActorContext,
    input: StartPreauditCommand,
    key: string,
    originRunId: string | null = null,
  ) {
    return this.preaudit.startPreaudit(ctx, input, key, originRunId);
  }
  getTask(ctx: ActorContext, id: string) {
    return this.preaudit.getTask(ctx, id);
  }
  getResult(ctx: ActorContext, id: string) {
    return this.preaudit.getResult(ctx, id);
  }
  searchAuthorized(ctx: ActorContext, input: KnowledgeSearch) {
    return this.knowledge.searchAuthorized(ctx, input);
  }
  async handleJob(job: DurableJob): Promise<void> {
    if (!job.lease_owner)
      throw new AppError('INVALID_STATE', '领域任务没有有效执行租约。', {
        details: { reason: 'LEASE_LOST' },
      });
    await this.options.jobs!.heartbeat(
      job.id,
      job.lease_owner,
      job.lease_epoch,
    );
    if (job.kind === 'preaudit.item')
      await this.preaudit.processItem(job.tenant_id, job.payload_ref, job);
    else if (job.kind === 'knowledge.import')
      await this.knowledge.processImport(job.tenant_id, job.payload_ref, job);
    else if (job.kind === 'rules.test') await this.ruleTests.processJob(job);
    else throw new AppError('INVALID_STATE', '未知财务领域任务。');
  }
  async processNextJob(
    workerId: string,
    scope: { tenant_id?: string } = {},
  ): Promise<boolean> {
    const job = await this.options.jobs!.claim(
      workerId,
      ['preaudit.item', 'knowledge.import', 'rules.test'],
      undefined,
      scope,
    );
    if (!job) return false;
    const heartbeat = setInterval(() => {
      void this.options
        .jobs!.heartbeat(job.id, workerId, job.lease_epoch)
        .catch(() => {});
    }, 10_000);
    try {
      await this.handleJob(job);
      await this.options.jobs!.finish(
        job.id,
        workerId,
        job.lease_epoch,
        'succeeded',
      );
    } catch (error) {
      await this.options.jobs!.finish(
        job.id,
        workerId,
        job.lease_epoch,
        'failed',
        error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
  async seedDemo(ctx: ActorContext): Promise<void> {
    if (this.options.identity.options.appMode !== 'demo')
      throw new AppError('FORBIDDEN', '只有演示环境可以加载财务种子。');
    if (!this.options.files)
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '种子需要真实私有文件服务。',
      );
    const existing = await rows(
      this.database.db,
      sql`SELECT id FROM rule_definitions WHERE tenant_id=${ctx.tenant_id} AND id='rule-personal-meals'`,
    );
    if (existing.length) return;
    const source = Buffer.from(
      '# 差旅报销演示制度\n合成演示材料，不是公司现行制度。\n\n## 住宿标准\n住宿演示标准为每间夜800元。\n\n## 票据核验\n每张关联票据必须通过核验；核验事实不可用时需要补充材料。\n\n## 业务招待\n餐饮报销必须关联已批准的同部门业务招待申请。\n',
    );
    const upload = await this.options.files.registerUpload(
      ctx,
      {
        filename: '演示制度.md',
        mime_type: 'text/markdown',
        size_bytes: source.length,
        profile: 'policy-text-v1',
      },
      'finance-seed-policy-upload',
    );
    const uploaded = await this.options.files.upload(
      ctx,
      upload.file.id,
      source,
      {
        uploadToken: upload.upload_target.headers['x-upload-token'],
        expectedVersion: upload.file.version,
      },
    );
    const hash = (await import('node:crypto'))
      .createHash('sha256')
      .update(source)
      .digest('hex');
    await this.options.files.finalizeUpload(
      ctx,
      upload.file.id,
      { expected_version: uploaded.version, sha256: hash },
      'finance-seed-policy-finalize',
    );
    const draft = await this.knowledge.createPolicyDraft(
      ctx,
      {
        policy_id: 'pol-expense',
        policy_code: 'DEMO-EXPENSE',
        title: '公司演示报销制度',
        source_file_id: upload.file.id,
        organization_ids: [
          'dept-sales',
          'dept-tech',
          'dept-finance',
          'dept-it',
        ],
        effective_from: '2026-01-01',
        effective_to: null,
        topic_tags: ['住宿', '票据', '招待'],
        supersedes_version_id: null,
      },
      'finance-seed-policy-draft',
    );
    await this.knowledge.processImport(ctx.tenant_id, draft.import_id);
    await this.database.db.transaction((tx) =>
      this.knowledge.publishPolicy(
        ctx,
        {
          policy_id: 'pol-expense',
          version_id: draft.version_id,
          expected_version: 1,
        },
        tx,
      ),
    );
    const citations = new Map<string, string>();
    for (const [key, query] of [
      ['lodging', '住宿标准'],
      ['invoice', '票据核验'],
      ['meals', '业务招待'],
    ]) {
      const hit = await this.knowledge.searchAuthorized(ctx, {
        query: query!,
        business_date: '2026-11-05',
        top_k: 1,
      });
      if (!hit.hits[0])
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '演示制度未成功建立可检索来源。',
        );
      citations.set(key!, hit.hits[0].citation_id);
    }
    await this.database.db.transaction(async (tx) => {
      for (const seed of BASELINE_RULES) {
        await tx.execute(
          sql`INSERT INTO rule_definitions(tenant_id,id,owner_id,level,category,name,lifecycle,active_version_id) VALUES(${ctx.tenant_id},${seed.id},${ctx.user_id},'company',${seed.category},${seed.name},'active',${seed.versionId}) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO rule_versions(tenant_id,id,rule_id,version_number,display_name,category,dsl_json,content_hash,source_kind,source_citation_ids,explanation,publication_state) VALUES(${ctx.tenant_id},${seed.versionId},${seed.id},1,${seed.name},${seed.category},${json(seed.dsl)}::jsonb,${canonicalHash(seed.dsl)},'policy',${json([citations.get(seed.category)])}::jsonb,'已确认演示制度规则；不自动审批。','published') ON CONFLICT DO NOTHING`,
        );
      }
      const personal = personalMealsDsl();
      await tx.execute(
        sql`INSERT INTO rule_definitions(tenant_id,id,owner_id,level,category,name,lifecycle,active_version_id) VALUES(${ctx.tenant_id},'rule-personal-meals','u-zhang','personal','meals','每单餐饮超过1000元提醒','active','rv-personal-meals-1') ON CONFLICT DO NOTHING`,
      );
      await tx.execute(
        sql`INSERT INTO rule_versions(tenant_id,id,rule_id,version_number,display_name,category,dsl_json,content_hash,source_kind,source_citation_ids,explanation,publication_state) VALUES(${ctx.tenant_id},'rv-personal-meals-1','rule-personal-meals',1,'每单餐饮超过1000元提醒','meals',${json(personal)}::jsonb,${canonicalHash(personal)},'personal','[]'::jsonb,'本人销售主管审核时，每单餐饮合计严格大于1000元提醒。','published') ON CONFLICT DO NOTHING`,
      );
      const mapping = {
        provider: 'demo-expenses',
        source_schema_version: 'expense-v1',
        module: 'expense_claim',
        field_catalog_version: 1,
        transforms: [
          'identity',
          'trim_string',
          'date_iso',
          'decimal_yuan_to_minor',
          'enum_lookup',
        ],
        enum_lookup: { office: 'general', other: 'general' },
        coverage_manifest: {
          module: 'expense_claim',
          complete: true,
          required_rule_ids: BASELINE_RULES.map((r) => r.id),
        },
      };
      await tx.execute(
        sql`INSERT INTO field_mapping_versions(tenant_id,id,mapping_id,version_number,mapping_json,content_hash,confirmed_by) VALUES(${ctx.tenant_id},'map-expense-v1','map-expense-v1',1,${json(mapping)}::jsonb,${canonicalHash(mapping)},${ctx.user_id}) ON CONFLICT DO NOTHING`,
      );
    });
  }
}
export function createFinanceService(
  database: DatabaseConnection,
  options: FinanceOptions,
) {
  return new FinanceService(database, options);
}
function receipt(
  ctx: ActionContext,
  action: ConfirmedAction,
  ref: ResourceRef | null,
): ActionReceipt {
  return {
    id: randomUUID(),
    action_id: ctx.action_id,
    idempotency_key: ctx.idempotency_key,
    outcome: 'succeeded',
    resource: ref,
    external_receipt_id: null,
    occurred_at: new Date().toISOString(),
    data_mode: 'demo',
    error_code: null,
  };
}
export function createFinanceActionHandlers(
  finance: FinanceService,
): Record<string, ActionHandler> {
  const RuleActivationArgs = z.strictObject({
    rule_id: z.string().min(1),
    expected_version: z.number().int().positive(),
    draft_hash: z.string().min(1),
    test_run_id: z.string().min(1),
  });
  const ruleArgs = (input: unknown) => {
    const parsed = RuleActivationArgs.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        'VALIDATION_ERROR',
        '规则启用或发布参数无效；不接受停用标志或未定义字段。',
      );
    return parsed.data;
  };
  const rule: ActionHandler<any> = {
    mode: 'local',
    async validate(actor, args, refs, tx) {
      const parsed = ruleArgs(args);
      if (
        refs.length !== 1 ||
        refs[0]?.type !== 'rule' ||
        refs[0].id !== parsed.rule_id ||
        refs[0].version !== parsed.expected_version
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '规则启用或发布必须绑定同一规则及精确版本。',
        );
      const current = await finance.rules.getRule(actor, parsed.rule_id, tx);
      const draft = current.versions.find(
        (v: any) => v.id === current.draft_version_id,
      );
      if (!draft)
        throw new AppError('INVALID_STATE', '请先保存和测试规则草稿。');
      const proof = await finance.rules.assertActivationProof(
        actor,
        parsed,
        tx,
      );
      return {
        summary: {
          title: '启用确定性规则',
          rule_name: current.name,
          level: current.level,
          draft_hash: parsed.draft_hash,
          test_run_id: parsed.test_run_id,
          impact:
            current.level === 'personal'
              ? '仅提醒，不改变公司规则或自动审批。'
              : '变更后续必查规则。',
        },
        args: parsed,
        extra_guards: proof,
      };
    },
    async execute(ctx, tx, action) {
      if (!tx) throw new AppError('INVALID_STATE', '规则启用需要本地事务。');
      const result = await finance.rules.activateRule(
        ctx.actor,
        ruleArgs(action.args),
        tx,
      );
      return receipt(ctx, action, result.rule_ref);
    },
    async queryOutcome() {
      throw new AppError('INVALID_STATE', '本地规则动作由统一动作账本核实。');
    },
  };
  const policy = (withdraw: boolean): ActionHandler<any> => ({
    mode: 'local',
    async validate(actor, args) {
      const versions = await finance.knowledge.listPolicies(actor);
      const p = versions.items.find((p) => p.id === args.policy_id);
      const version = p?.versions.find((v) => v.id === args.version_id);
      if (!p || !version) throw new AppError('NOT_FOUND', '制度版本不存在。');
      await finance.knowledge.assertMaintain(
        actor,
        p.id,
        version.organization_ids,
      );
      return {
        summary: {
          title: withdraw ? '撤回制度版本' : '发布制度版本',
          policy_title: p.title,
          version_no: version.version_no,
          effective_from: version.effective_from,
          effective_to: version.effective_to,
          organization_ids: version.organization_ids,
        },
        args: {
          policy_id: p.id,
          version_id: version.id,
          expected_version: version.version,
          withdraw,
        },
      };
    },
    async execute(ctx, tx, action) {
      if (!tx) throw new AppError('INVALID_STATE', '制度发布需要本地事务。');
      const result = await finance.knowledge.publishPolicy(
        ctx.actor,
        action.args,
        tx,
      );
      return receipt(ctx, action, result.policy_ref);
    },
    async queryOutcome() {
      throw new AppError('INVALID_STATE', '本地制度动作由统一动作账本核实。');
    },
  });
  const disable: ActionHandler = {
    mode: 'local',
    async validate(actor, args, refs, tx) {
      const parsed = z
        .strictObject({
          rule_id: z.string().min(1),
          expected_version: z.number().int().positive(),
        })
        .safeParse(args);
      if (!parsed.success)
        throw new AppError(
          'VALIDATION_ERROR',
          '停用参数只允许规则ID和精确版本。',
        );
      if (
        refs.length !== 1 ||
        refs[0]?.type !== 'rule' ||
        refs[0].id !== parsed.data.rule_id ||
        refs[0].version !== parsed.data.expected_version
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '停用必须绑定同一规则及精确版本。',
        );
      return {
        ...(await finance.rules.prepareDisable(actor, parsed.data, tx)),
        args: parsed.data,
      };
    },
    async execute(ctx, tx, action) {
      if (!tx) throw new AppError('INVALID_STATE', '停用需要本地事务。');
      const input = z
        .strictObject({
          rule_id: z.string().min(1),
          expected_version: z.number().int().positive(),
        })
        .parse(action.args);
      await finance.rules.prepareDisable(ctx.actor, input, tx);
      const result = await finance.rules.activateRule(
        ctx.actor,
        { ...input, disable: true },
        tx,
      );
      return receipt(ctx, action, result.rule_ref);
    },
    async queryOutcome() {
      throw new AppError('INVALID_STATE', '本地停用由统一动作账本核实。');
    },
  };
  return {
    'rule.enable': rule,
    'rule.publish': rule,
    'rule.disable': disable,
    'rule.mapping.publish': {
      mode: 'local',
      async validate(actor, args, refs, tx) {
        if (refs.length)
          throw new AppError(
            'VALIDATION_ERROR',
            '字段映射通过独立版本守卫绑定，不接受伪造业务资源。',
          );
        return finance.mappings.preparePublish(
          actor,
          MappingPublishArgsSchema.parse(args),
          tx,
        );
      },
      async execute(ctx, tx, action) {
        if (!tx)
          throw new AppError('INVALID_STATE', '字段映射发布需要本地事务。');
        const result = await finance.mappings.publish(
          ctx.actor,
          MappingPublishArgsSchema.parse(action.args),
          tx,
        );
        return {
          ...receipt(ctx, action, null),
          external_receipt_id: result.version_id,
        };
      },
      async queryOutcome() {
        throw new AppError('INVALID_STATE', '本地字段映射由统一动作账本核实。');
      },
    },
    'policy.publish': policy(false),
    'policy.withdraw': policy(true),
  };
}
