import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import {
  RuleDraftInputSchema,
  RuleProposalSchema,
  SrsInputSchema,
  type RuleDraftInput,
  type RuleDsl,
  type SrsInput,
  type ReviewerPurpose,
} from '@caixiaozhi/contracts/rules';
import type {
  DatabaseConnection,
  DatabaseExecutor,
  Transaction,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { FinanceOptions } from './ports.js';
import type { KnowledgeService } from './knowledge.js';
import { compileRule, evaluateRule, type CompiledRule } from './evaluator.js';
import { bump, command, json, outbox, revision, rows } from './database.js';
import { canonicalHash } from './hash.js';
import { personalMealsDsl } from './rule-seeds.js';
const missing = () => new AppError('NOT_FOUND', '请求的规则不存在。');
export type ResolvedRule = {
  id: string;
  version_id: string;
  version_number: number;
  name: string;
  category: string;
  compiled: CompiledRule;
  source_citation_ids: string[];
  source_review_required: boolean;
};
export type ResolvedRuleSet = {
  company: ResolvedRule[];
  personal: ResolvedRule[];
  company_revision: number;
  personal_revision: number;
  mapping_revision: number;
  hash: string;
  coverage_complete: boolean;
};
export class RuleService {
  constructor(
    readonly database: DatabaseConnection,
    readonly options: FinanceOptions,
    readonly knowledge: KnowledgeService,
  ) {}
  private async assertWrite(ctx: ActorContext, input: RuleDraftInput) {
    const current = await this.options.identity.requireCurrentActor(ctx);
    await this.options.identity.assertPermission(
      current,
      input.level === 'personal'
        ? 'rule.manage.personal'
        : 'rule.manage.company',
    );
    if (current.invocation_origin !== 'interactive')
      throw new AppError('FORBIDDEN', '后台身份不能维护规则。');
    if (input.level === 'company') {
      const scope = await this.options.identity.getResourceScope(
        current,
        'rule.manage.company',
      );
      if (
        input.dsl_json.applicability.department_ids.some(
          (id) => !scope.department_ids.includes(id),
        )
      )
        throw new AppError('FORBIDDEN', '规则组织不在当前管理授权范围内。');
    } else {
      const me = await this.options.identity.getMe(current);
      const depts = [me.department_id, ...current.department_ids];
      if (
        input.dsl_json.applicability.department_ids.some(
          (id) => !depts.includes(id),
        )
      )
        throw new AppError('FORBIDDEN', '个人规则范围超出当前授权部门。');
    }
    for (const citationId of input.source_citation_ids)
      await this.knowledge.getCitation(current, citationId);
  }
  async getRule(
    ctx: ActorContext,
    id: string,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<any> {
    const current = await this.options.identity.requireCurrentActor(ctx);
    const found = await rows<any>(
      tx,
      sql`SELECT * FROM rule_definitions WHERE tenant_id=${ctx.tenant_id} AND id=${id}`,
    );
    const definition = found[0];
    if (!definition) throw missing();
    if (
      definition.level === 'personal' &&
      definition.owner_id !== current.user_id
    )
      throw missing();
    if (!current.roles.includes('employee')) throw missing();
    const storedVersions = await rows<any>(
      tx,
      sql`SELECT * FROM rule_versions WHERE tenant_id=${ctx.tenant_id} AND rule_id=${id} ORDER BY version_number`,
    );
    const personal = definition.level === 'personal',
      organizations = personal
        ? []
        : await this.knowledge.organizationScope(current),
      managedOrganizations =
        !personal && current.permissions.includes('rule.manage.company')
          ? (
              await this.options.identity.getResourceScope(
                current,
                'rule.manage.company',
              )
            ).department_ids
          : [];
    const departments = (version: any): string[] =>
      version.dsl_json.applicability.department_ids;
    const canManage = (version: any) =>
      departments(version).length > 0 &&
      departments(version).every((department) =>
        managedOrganizations.includes(department),
      );
    const trustedMetadata = (version: any) =>
      typeof version.display_name === 'string' &&
      typeof version.category === 'string';
    const versions = storedVersions.filter(
      (version) =>
        personal ||
        canManage(version) ||
        (version.publication_state === 'published' &&
          trustedMetadata(version) &&
          departments(version).some((department) =>
            organizations.includes(department),
          )),
    );
    if (!versions.length) throw missing();
    const active = versions.find(
        (version) => version.id === definition.active_version_id,
      ),
      draft = versions.find(
        (version) => version.id === definition.draft_version_id,
      ),
      displayVersion = draft ?? active ?? versions.at(-1)!,
      headId =
        definition.draft_version_id ??
        definition.active_version_id ??
        storedVersions.at(-1)?.id,
      canReadPrivateMetadata =
        personal ||
        versions.some((version) => version.id === headId && canManage(version));
    // 旧版缺少可信名称/分类时，普通读者已在上方失败关闭。
    // 管理者只可对当前可管理指针使用定义元数据，历史缺口保留显式待修复标记。
    if (
      !trustedMetadata(displayVersion) &&
      !(canReadPrivateMetadata && displayVersion.id === headId)
    )
      throw missing();
    return {
      id: definition.id,
      tenant_id: definition.tenant_id,
      owner_id: definition.owner_id,
      name: trustedMetadata(displayVersion)
        ? displayVersion.display_name
        : definition.name,
      level: definition.level,
      category: trustedMetadata(displayVersion)
        ? displayVersion.category
        : definition.category,
      lifecycle:
        personal || draft
          ? definition.lifecycle
          : active
            ? 'active'
            : definition.lifecycle === 'disabled'
              ? 'disabled'
              : 'archived',
      version: definition.version,
      active_version_id: active?.id ?? null,
      draft_version_id: draft?.id ?? null,
      original_intent: canReadPrivateMetadata
        ? definition.original_intent
        : null,
      questions: canReadPrivateMetadata ? definition.unresolved_questions : [],
      versions: versions.map((v) => ({
        id: v.id,
        version_number: v.version_number,
        display_name: v.display_name,
        category: v.category,
        metadata_status: trustedMetadata(v) ? 'trusted' : 'unavailable',
        dsl_json: v.dsl_json,
        content_hash: v.content_hash,
        source_kind: v.source_kind,
        source_citation_ids: v.source_citation_ids,
        source_review_required: v.source_review_required,
        publication_state: v.publication_state,
        explanation: v.explanation,
      })),
      created_at: new Date(definition.created_at).toISOString(),
      updated_at: new Date(
        canReadPrivateMetadata
          ? definition.updated_at
          : displayVersion.updated_at,
      ).toISOString(),
    };
  }
  async listRules(ctx: ActorContext) {
    const current = await this.options.identity.requireCurrentActor(ctx);
    if (!current.roles.includes('employee'))
      return { items: [], next_cursor: null };
    const found = await rows<any>(
      this.database.db,
      sql`SELECT id FROM rule_definitions WHERE tenant_id=${current.tenant_id} AND (level='company' OR (level='personal' AND owner_id=${current.user_id})) ORDER BY id`,
    );
    const items = [];
    for (const row of found)
      try {
        items.push(await this.getRule(current, row.id));
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND')
          throw error;
      }
    return { items, next_cursor: null };
  }
  async createDraft(ctx: ActorContext, input: RuleDraftInput, key: string) {
    const parsed = RuleDraftInputSchema.parse(input);
    compileRule(parsed.dsl_json);
    await this.assertWrite(ctx, parsed);
    return command(
      this.database,
      ctx,
      'rule.create',
      key,
      parsed,
      async (tx) => {
        const id = randomUUID(),
          versionId = randomUUID();
        await tx.execute(
          sql`INSERT INTO rule_definitions(tenant_id,id,owner_id,level,category,name,lifecycle,draft_version_id) VALUES(${ctx.tenant_id},${id},${ctx.user_id},${parsed.level},${parsed.category},${parsed.name},'draft',${versionId})`,
        );
        await this.insertVersion(tx, ctx, id, versionId, 1, parsed);
        return this.getRule(ctx, id, tx);
      },
    );
  }
  private async insertVersion(
    tx: DatabaseExecutor,
    ctx: ActorContext,
    ruleId: string,
    versionId: string,
    number: number,
    input: RuleDraftInput,
  ) {
    await tx.execute(
      sql`INSERT INTO rule_versions(tenant_id,id,rule_id,version_number,display_name,category,dsl_json,content_hash,source_kind,source_citation_ids,explanation,publication_state) VALUES(${ctx.tenant_id},${versionId},${ruleId},${number},${input.name},${input.category},${json(input.dsl_json)}::jsonb,${canonicalHash(input.dsl_json)},${input.source_kind},${json(input.source_citation_ids)}::jsonb,${input.level === 'personal' ? '仅对本人当前用途提供提醒，不改变公司规则。' : '必须检查；不符合或无法判断分别保留。'},'draft')`,
    );
  }
  async saveDraft(
    ctx: ActorContext,
    id: string,
    expected: number,
    patch: RuleDraftInput,
    key: string,
  ) {
    const current = await this.getRule(ctx, id);
    if (current.owner_id !== ctx.user_id && current.level === 'personal')
      throw missing();
    const parsed = RuleDraftInputSchema.parse(patch);
    if (current.level !== parsed.level)
      throw new AppError('VALIDATION_ERROR', '不能改变规则层级。');
    compileRule(parsed.dsl_json);
    await this.assertWrite(ctx, parsed);
    return command(
      this.database,
      ctx,
      'rule.save',
      key,
      { id, expected, parsed },
      async (tx) => {
        const locked = await rows<any>(
          tx,
          sql`SELECT version FROM rule_definitions WHERE tenant_id=${ctx.tenant_id} AND id=${id} FOR UPDATE`,
        );
        if (locked[0]?.version !== expected)
          throw new AppError('VERSION_CONFLICT', '规则草稿已更新，请刷新。');
        const max = await rows<{ n: number }>(
          tx,
          sql`SELECT max(version_number)::int AS n FROM rule_versions WHERE tenant_id=${ctx.tenant_id} AND rule_id=${id}`,
        );
        const versionId = randomUUID();
        await this.insertVersion(
          tx,
          ctx,
          id,
          versionId,
          (max[0]?.n ?? 0) + 1,
          parsed,
        );
        await tx.execute(
          sql`UPDATE rule_definitions SET name=${parsed.name},category=${parsed.category},draft_version_id=${versionId},lifecycle='draft',unresolved_questions='[]'::jsonb,version=version+1,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${id}`,
        );
        return this.getRule(ctx, id, tx);
      },
    );
  }
  async proposeRule(
    ctx: ActorContext,
    input: z.infer<typeof RuleProposalSchema>,
    key: string,
  ) {
    const parsed = RuleProposalSchema.parse(input);
    await this.options.identity.assertPermission(ctx, 'rule.manage.personal');
    if (!this.options.proposeRule)
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '规则草稿模型尚未配置，请使用结构化表单明确类别、阈值、比较边界和计量单位。',
        {
          details: { reason: 'RULE_PROPOSAL_MODEL_UNCONFIGURED' },
          retryable: false,
        },
      );
    const proposed = RuleDraftInputSchema.parse(
      await this.options.proposeRule(ctx, parsed),
    );
    if (
      proposed.level !== 'personal' ||
      proposed.dsl_json.outcome_mode !== 'attention_trigger'
    )
      throw new AppError(
        'VALIDATION_ERROR',
        '自然语言个人规则不能改变公司检查或自动执行审批。',
      );
    const draft = await this.createDraft(ctx, proposed, key);
    await this.database.db.execute(
      sql`UPDATE rule_definitions SET original_intent=${parsed.natural_language} WHERE tenant_id=${ctx.tenant_id} AND id=${draft.id}`,
    );
    return this.getRule(ctx, draft.id);
  }
  async getTestTarget(
    ctx: ActorContext,
    id: string,
    expected: number,
    tx: DatabaseExecutor = this.database.db,
  ) {
    const rule = await this.getRule(ctx, id, tx);
    if (rule.version !== expected)
      throw new AppError('VERSION_CONFLICT', '草稿已更新，请重测。');
    const draft = rule.versions.find(
      (v: any) => v.id === rule.draft_version_id,
    );
    if (!draft) throw new AppError('INVALID_STATE', '当前没有可测试草稿。');
    const parsed = RuleDraftInputSchema.parse({
      name: rule.name,
      level: rule.level,
      category: rule.category,
      dsl_json: draft.dsl_json,
      source_kind: draft.source_kind,
      source_citation_ids: draft.source_citation_ids,
    });
    await this.assertWrite(ctx, parsed);
    const locked = await rows(
      tx,
      sql`SELECT id FROM rule_definitions WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND version=${expected} FOR SHARE`,
    );
    if (!locked[0])
      throw new AppError('VERSION_CONFLICT', '草稿已更新，请重测。');
    const mapping = await revision(tx, ctx.tenant_id, 'mapping', true);
    return {
      rule,
      draft,
      parsed,
      compiled: compileRule(parsed.dsl_json),
      mapping,
    };
  }
  async getTestMappingSnapshot(
    ctx: ActorContext,
    dsl: RuleDsl,
    compiled: CompiledRule,
    mapping: number,
    tx: DatabaseExecutor = this.database.db,
  ) {
    const mappings = await rows<{
      id: string;
      version_number: number;
      content_hash: string;
    }>(
      tx,
      sql`SELECT id,version_number,content_hash FROM field_mapping_versions WHERE tenant_id=${ctx.tenant_id} AND mapping_json->>'module'=ANY(${sql.param(dsl.applicability.modules)}::text[]) ORDER BY mapping_id,version_number,id`,
    );
    return {
      revision: mapping,
      field_catalog_version: compiled.field_catalog_version,
      mappings,
    };
  }
  async assertActivationProof(
    ctx: ActorContext,
    input: {
      rule_id: string;
      expected_version: number;
      draft_hash: string;
      test_run_id: string;
    },
    tx: DatabaseExecutor = this.database.db,
  ) {
    const { draft, parsed, compiled, mapping } = await this.getTestTarget(
        ctx,
        input.rule_id,
        input.expected_version,
        tx,
      ),
      mappingHash = canonicalHash({ revision: mapping });
    const test = (
      await rows<{
        id: string;
        job_id: string | null;
        compiled_hash: string;
        mapping_hash: string;
        test_set_hash: string;
      }>(
        tx,
        sql`SELECT id,job_id,compiled_hash,mapping_hash,test_set_hash FROM rule_test_runs WHERE tenant_id=${ctx.tenant_id} AND owner_id=${ctx.user_id} AND id=${input.test_run_id} AND rule_version_id=${draft.id} AND passed`,
      )
    )[0];
    const invalid = () =>
      new AppError(
        'REVALIDATION_REQUIRED',
        '草稿、映射或测试证明已变化，请重新测试。',
      );
    if (
      draft.content_hash !== input.draft_hash ||
      !test ||
      test.compiled_hash !== compiled.compiled_hash ||
      test.mapping_hash !== mappingHash
    )
      throw invalid();
    let snapshotHash: string | null = null;
    if (test.job_id) {
      const task = (
        await rows<{
          rule_version: number;
          draft_version_id: string;
          draft_version: number;
          draft_hash: string;
          compiled_hash: string;
          mapping_hash: string;
          mapping_snapshot_hash: string;
          test_set_hash: string;
          authz_version: number;
        }>(
          tx,
          sql`SELECT rule_version,draft_version_id,draft_version,draft_hash,compiled_hash,mapping_hash,mapping_snapshot_hash,test_set_hash,authz_version FROM rule_test_tasks WHERE tenant_id=${ctx.tenant_id} AND owner_id=${ctx.user_id} AND id=${test.id} AND proof_id=${test.id} AND job_id=${test.job_id} AND status='completed' FOR SHARE`,
        )
      )[0];
      snapshotHash = canonicalHash(
        await this.getTestMappingSnapshot(
          ctx,
          parsed.dsl_json,
          compiled,
          mapping,
          tx,
        ),
      );
      if (
        !task ||
        task.rule_version !== input.expected_version ||
        task.draft_version_id !== draft.id ||
        task.draft_version !== draft.version_number ||
        task.draft_hash !== input.draft_hash ||
        task.compiled_hash !== compiled.compiled_hash ||
        task.mapping_hash !== mappingHash ||
        task.mapping_snapshot_hash !== snapshotHash ||
        task.test_set_hash !== test.test_set_hash ||
        task.authz_version !== ctx.authz_version
      )
        throw invalid();
    }
    return {
      draft_hash: input.draft_hash,
      compiled_hash: compiled.compiled_hash,
      mapping_hash: mappingHash,
      mapping_snapshot_hash: snapshotHash,
      test_set_hash: test.test_set_hash,
    };
  }
  async testRule(
    ctx: ActorContext,
    id: string,
    expected: number,
    cases: Array<{
      name: string;
      input: SrsInput;
      expected_truth: 'true' | 'false' | 'unknown';
    }>,
    key: string,
    options: { tx?: Transaction; testRunId?: string; jobId?: string } = {},
  ) {
    const checked = z
      .array(
        z.strictObject({
          name: z.string().min(1),
          input: SrsInputSchema,
          expected_truth: z.enum(['true', 'false', 'unknown']),
        }),
      )
      .min(4)
      .max(100)
      .parse(cases);
    const execute = async (tx: Transaction) => {
      const { draft, compiled, mapping } = await this.getTestTarget(
        ctx,
        id,
        expected,
        tx,
      );
      const results = checked.map((c) => ({
        name: c.name,
        expected_truth: c.expected_truth,
        ...evaluateRule(compiled, c.input),
      }));
      const testId = options.testRunId ?? randomUUID();
      const passed = results.every((r) => r.truth === r.expected_truth);
      for (const c of checked)
        await tx.execute(
          sql`INSERT INTO rule_test_cases(tenant_id,id,rule_version_id,name,input_json,expected_truth) VALUES(${ctx.tenant_id},${randomUUID()},${draft.id},${c.name},${json(c.input)}::jsonb,${c.expected_truth})`,
        );
      await tx.execute(
        sql`INSERT INTO rule_test_runs(tenant_id,id,rule_version_id,owner_id,compiled_hash,test_set_hash,mapping_hash,results,passed,finished_at,job_id) VALUES(${ctx.tenant_id},${testId},${draft.id},${ctx.user_id},${compiled.compiled_hash},${canonicalHash(checked)},${canonicalHash({ revision: mapping })},${json(results)}::jsonb,${passed},now(),${options.jobId ?? null})`,
      );
      if (passed)
        await tx.execute(
          sql`UPDATE rule_definitions SET lifecycle='ready' WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND version=${expected}`,
        );
      return {
        test_run_id: testId,
        passed,
        compiled_hash: compiled.compiled_hash,
        draft_hash: draft.content_hash,
        mapping_hash: canonicalHash({ revision: mapping }),
        test_set_hash: canonicalHash(checked),
        results,
      };
    };
    return options.tx
      ? execute(options.tx)
      : command(
          this.database,
          ctx,
          'rule.test',
          key,
          { id, expected, cases: checked },
          execute,
        );
  }
  async activateRule(
    ctx: ActorContext,
    input:
      | {
          rule_id: string;
          expected_version: number;
          draft_hash: string;
          test_run_id: string;
          disable?: false;
        }
      | { rule_id: string; expected_version: number; disable: true },
    tx: DatabaseExecutor = this.database.db,
  ) {
    const rule = await this.getRule(ctx, input.rule_id, tx);
    if (rule.version !== input.expected_version)
      throw new AppError('VERSION_CONFLICT', '规则版本已更新，请刷新。');
    const draft = rule.versions.find(
      (v: any) =>
        v.id ===
        (input.disable ? rule.active_version_id : rule.draft_version_id),
    );
    if (!draft) throw new AppError('INVALID_STATE', '没有对应的规则版本。');
    const parsed = RuleDraftInputSchema.parse({
      name: rule.name,
      level: rule.level,
      category: rule.category,
      dsl_json: draft.dsl_json,
      source_kind: draft.source_kind,
      source_citation_ids: draft.source_citation_ids,
    });
    await this.assertWrite(ctx, parsed);
    const guard =
      rule.level === 'company'
        ? 'company'
        : `personal:${ctx.user_id}:${draft.dsl_json.applicability.purposes[0]}`;
    const mapping = await revision(tx, ctx.tenant_id, 'mapping', true);
    if (!input.disable) {
      await this.assertActivationProof(ctx, input, tx);
    }
    const changed = await tx.execute(
      sql`UPDATE rule_definitions SET active_version_id=${input.disable ? null : draft.id},draft_version_id=${input.disable ? rule.draft_version_id : null},lifecycle=${input.disable ? 'disabled' : 'active'},version=version+1,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${rule.id} AND version=${input.expected_version} RETURNING id`,
    );
    if (!changed.rows.length)
      throw new AppError('VERSION_CONFLICT', '规则版本已更新，请刷新。');
    if (!input.disable)
      await tx.execute(
        sql`UPDATE rule_versions SET publication_state='published' WHERE tenant_id=${ctx.tenant_id} AND id=${draft.id}`,
      );
    const next = await bump(tx, ctx.tenant_id, guard);
    await outbox(
      tx,
      ctx,
      'ruleset.changed',
      'rule',
      rule.id,
      draft.version_number,
      {
        level: rule.level,
        owner_id: rule.owner_id,
        purposes: draft.dsl_json.applicability.purposes,
        revision: next,
      },
    );
    return {
      rule_ref: {
        type: 'rule' as const,
        id: rule.id,
        version: rule.version + 1,
      },
      revision: next,
      lifecycle: input.disable ? 'disabled' : 'active',
    };
  }
  async prepareDisable(
    ctx: ActorContext,
    input: { rule_id: string; expected_version: number },
    tx: DatabaseExecutor = this.database.db,
  ) {
    const rule = await this.getRule(ctx, input.rule_id, tx);
    if (rule.version !== input.expected_version)
      throw new AppError('VERSION_CONFLICT', '规则版本已更新，请刷新。');
    const active = rule.versions.find(
      (v: any) => v.id === rule.active_version_id,
    );
    if (!active || rule.lifecycle === 'disabled')
      throw new AppError('INVALID_STATE', '当前规则未启用。');
    const metadata = (
      await rows<{ display_name: string | null; category: string | null }>(
        tx,
        sql`SELECT display_name,category FROM rule_versions WHERE tenant_id=${ctx.tenant_id} AND id=${active.id}`,
      )
    )[0];
    if (!metadata?.display_name || !metadata.category)
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '已发布规则缺少可信历史元数据，请复制并重新发布后操作。',
      );
    await this.assertWrite(
      ctx,
      RuleDraftInputSchema.parse({
        name: metadata.display_name,
        level: rule.level,
        category: metadata.category,
        dsl_json: active.dsl_json,
        source_kind: active.source_kind,
        source_citation_ids: active.source_citation_ids,
      }),
    );
    const current = await rows<any>(
      tx,
      sql`SELECT d.id,v.category,v.dsl_json FROM rule_definitions d JOIN rule_versions v ON v.tenant_id=d.tenant_id AND v.id=d.active_version_id WHERE d.tenant_id=${ctx.tenant_id} AND d.level='company' AND d.lifecycle NOT IN('disabled','archived')`,
    );
    const required = ['invoice', 'lodging', 'meals'];
    const scopes = (
      active.dsl_json.applicability.department_ids as string[]
    ).map((department_id) => {
      const inDepartment = current.filter((row) =>
        row.dsl_json.applicability.department_ids.includes(department_id),
      );
      return {
        department_id,
        before: required.every((c) =>
          inDepartment.some((row) => row.category === c),
        ),
        after: required.every((c) =>
          inDepartment.some((row) => row.id !== rule.id && row.category === c),
        ),
      };
    });
    const guardId =
      rule.level === 'company'
        ? 'company'
        : `personal:${ctx.user_id}:${active.dsl_json.applicability.purposes[0]}`;
    return {
      summary: {
        title: '停用审核规则',
        rule_name: metadata.display_name,
        level: rule.level,
        active_version: active.version_number,
        department_ids: active.dsl_json.applicability.department_ids,
        purposes: active.dsl_json.applicability.purposes,
        coverage_before:
          rule.level === 'company' ? scopes.every((s) => s.before) : null,
        coverage_after:
          rule.level === 'company' ? scopes.every((s) => s.after) : null,
        coverage_by_department: rule.level === 'company' ? scopes : [],
        impact:
          rule.level === 'company'
            ? '停用后公司必查覆盖会重新计算；缺少必查覆盖时不得判为低风险。'
            : '停用本人提醒，不改变公司必查要求。',
      },
      extra_guards: {
        rule_version: rule.version,
        active_version_id: active.id,
        ruleset_revision: await revision(tx, ctx.tenant_id, guardId),
        mapping_revision: await revision(tx, ctx.tenant_id, 'mapping'),
      },
    };
  }
  async resolveRuleSet(
    ctx: ActorContext,
    input: SrsInput,
    purpose: ReviewerPurpose,
    basisDate: string,
    tx: DatabaseExecutor = this.database.db,
    lock = false,
  ): Promise<ResolvedRuleSet> {
    await this.options.identity.requireCurrentActor(ctx);
    const companyRevision = await revision(tx, ctx.tenant_id, 'company', lock),
      personalRevision = await revision(
        tx,
        ctx.tenant_id,
        `personal:${ctx.user_id}:${purpose}`,
        lock,
      ),
      mapping = await revision(tx, ctx.tenant_id, 'mapping', lock);
    const result = await rows<any>(
      tx,
      sql`SELECT d.*,v.id AS version_id,v.version_number,v.dsl_json,v.source_citation_ids,v.source_review_required,v.category AS published_category,v.display_name AS published_name FROM rule_definitions d JOIN rule_versions v ON v.tenant_id=d.tenant_id AND v.id=d.active_version_id WHERE d.tenant_id=${ctx.tenant_id} AND d.active_version_id IS NOT NULL AND d.lifecycle NOT IN ('disabled','archived') AND (d.level='company' OR (d.level='personal' AND d.owner_id=${ctx.user_id})) ORDER BY d.id`,
    );
    const company: ResolvedRule[] = [],
      personal: ResolvedRule[] = [];
    for (const row of result) {
      if (!row.published_category || !row.published_name) continue;
      const compiled = compileRule(row.dsl_json),
        a = compiled.dsl.applicability;
      if (
        !a.modules.includes(input.document.type) ||
        !a.department_ids.includes(input.department_id) ||
        !a.purposes.includes(purpose) ||
        basisDate < a.effective_from ||
        (a.effective_to && basisDate >= a.effective_to)
      )
        continue;
      let sourceReview = Boolean(row.source_review_required);
      for (const id of row.source_citation_ids) {
        try {
          await this.knowledge.getCitation(ctx, id);
        } catch {
          sourceReview = true;
        }
      }
      const item: ResolvedRule = {
        id: row.id,
        version_id: row.version_id,
        version_number: row.version_number,
        name: row.published_name,
        category: row.published_category,
        compiled,
        source_citation_ids: row.source_citation_ids,
        source_review_required: sourceReview,
      };
      (row.level === 'company' ? company : personal).push(item);
    }
    const complete =
      input.document.type === 'expense_claim' &&
      ['invoice', 'lodging', 'meals'].every((c) =>
        company.some((r) => r.category === c),
      );
    return {
      company,
      personal,
      company_revision: companyRevision,
      personal_revision: personalRevision,
      mapping_revision: mapping,
      hash: canonicalHash({
        company: company.map((r) => r.compiled.compiled_hash),
        personal: personal.map((r) => r.compiled.compiled_hash),
        companyRevision,
        personalRevision,
        mapping,
      }),
      coverage_complete: complete,
    };
  }
}
