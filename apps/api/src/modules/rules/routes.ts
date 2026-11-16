import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RuleDraftInputSchema,
  RuleProposalSchema,
  RuleTestSetCreateSchema,
  RuleTestStartSchema,
} from '@caixiaozhi/contracts/rules';
import type { FinanceService } from '@caixiaozhi/finance';
import { FIELD_CATALOG } from '@caixiaozhi/finance';
import {
  diffRuleVersions,
  type RuleDiffVersion,
} from '@caixiaozhi/finance/rule-diff';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  MAPPING_TARGET_FIELDS,
  MappingDraftSchema,
  MappingSaveSchema,
  MappingTestSchema,
} from '@caixiaozhi/contracts/mappings';
import { DEFAULT_SRS_MAPPING_FIELDS } from '@caixiaozhi/finance/mappings';
import type { HttpIdentity } from '../identity/routes.js';
import { dataResponse } from '../../http.js';
const id = (params: unknown) =>
  z.strictObject({ id: z.string().min(1) }).parse(params).id;
const key = (headers: Record<string, unknown>) =>
  z.string().min(1).max(200).parse(headers['idempotency-key']);
export function registerRuleRoutes(
  app: FastifyInstance,
  deps: {
    finance: FinanceService;
    identity: HttpIdentity;
    dataMode?: 'demo' | 'production';
  },
) {
  const mode = deps.dataMode ?? 'demo',
    service = deps.finance.rules;
  app.get('/api/v1/rules', async (request) =>
    dataResponse(
      request,
      await service.listRules(await deps.identity.requireActor(request)),
      mode,
    ),
  );
  app.get('/api/v1/rules/:id', async (request) =>
    dataResponse(
      request,
      await service.getRule(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/rules', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    reply.code(201);
    return dataResponse(
      request,
      await service.createDraft(
        actor,
        RuleDraftInputSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.post('/api/v1/rules/proposals', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    return dataResponse(
      request,
      await service.proposeRule(
        actor,
        RuleProposalSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.patch('/api/v1/rules/:id/draft', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const input = request.body;
    const body = z
      .object({ expected_version: z.number().int().positive() })
      .passthrough()
      .parse(input);
    const { expected_version, ...patch } = body;
    return dataResponse(
      request,
      await service.saveDraft(
        actor,
        id(request.params),
        expected_version,
        RuleDraftInputSchema.parse(patch),
        key(request.headers),
      ),
      mode,
    );
  });
  app.post('/api/v1/rules/:id/test-sets', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const result = await deps.finance.ruleTests.createTestSet(
      actor,
      id(request.params),
      RuleTestSetCreateSchema.parse(request.body),
      key(request.headers),
    );
    reply.code(201);
    return dataResponse(request, result, mode);
  });
  app.get('/api/v1/rules/:id/test-sets', async (request) =>
    dataResponse(
      request,
      await deps.finance.ruleTests.listTestSets(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/rules/:id/tests', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const result = await deps.finance.ruleTests.start(
      actor,
      id(request.params),
      RuleTestStartSchema.parse(request.body),
      key(request.headers),
    );
    reply.code(202);
    return dataResponse(request, result, mode);
  });
  app.get('/api/v1/rules/:id/tests/:testId', async (request) => {
    const actor = await deps.identity.requireActor(request),
      params = z
        .strictObject({ id: z.string().min(1), testId: z.string().min(1) })
        .parse(request.params);
    return dataResponse(
      request,
      await deps.finance.ruleTests.get(actor, params.id, params.testId),
      mode,
    );
  });
  app.get('/api/v1/rules/:id/diff', async (request) => {
    const actor = await deps.identity.requireActor(request);
    const rule = await service.getRule(actor, id(request.params));
    const input = z
      .strictObject({
        from_version: z.coerce.number().int().positive(),
        to_version: z.coerce.number().int().positive(),
      })
      .parse(request.query);
    const fromVersion = rule.versions.find(
      (version: RuleDiffVersion) =>
        version.version_number === input.from_version,
    ) as RuleDiffVersion | undefined;
    const toVersion = rule.versions.find(
      (version: RuleDiffVersion) => version.version_number === input.to_version,
    ) as RuleDiffVersion | undefined;
    if (!fromVersion || !toVersion)
      throw new AppError('NOT_FOUND', '请求的规则版本不存在或无权查看。');
    // 每个版本分别取其真实启用证明，草稿退回到该版本自己的已完成测试。
    // 不把现行映射填入旧版本，也不读取测试样本或动作凭据。
    const bindings = await deps.finance.database.pool.query(
      `SELECT v.id,
      activation.mapping_snapshot AS activation_snapshot,activation.mapping_snapshot_hash AS activation_hash,
      tested.mapping_snapshot AS test_snapshot,tested.mapping_snapshot_hash AS test_hash
      FROM rule_versions v
      LEFT JOIN LATERAL(SELECT t.mapping_snapshot,t.mapping_snapshot_hash FROM actions a
        JOIN rule_test_tasks t ON t.tenant_id=a.tenant_id AND t.proof_id=a.args->>'test_run_id'
        JOIN rule_test_runs r ON r.tenant_id=t.tenant_id AND r.id=t.proof_id AND r.passed
        WHERE a.tenant_id=v.tenant_id AND a.state='succeeded' AND a.operation IN('rule.enable','rule.publish')
        AND a.args->>'rule_id'=v.rule_id AND t.draft_version_id=v.id AND t.draft_hash=v.content_hash AND t.status='completed'
        ORDER BY a.updated_at DESC,a.id DESC LIMIT 1) activation ON true
      LEFT JOIN LATERAL(SELECT t.mapping_snapshot,t.mapping_snapshot_hash FROM rule_test_tasks t
        WHERE t.tenant_id=v.tenant_id AND t.rule_id=v.rule_id AND t.draft_version_id=v.id
        AND t.draft_hash=v.content_hash AND t.status='completed'
        ORDER BY t.created_at DESC,t.id DESC LIMIT 1) tested ON true
      WHERE v.tenant_id=$1 AND v.rule_id=$2 AND v.id=ANY($3::text[])`,
      [actor.tenant_id, rule.id, [fromVersion.id, toVersion.id]],
    );
    const snapshotSchema = z.strictObject({
      revision: z.number().int().nonnegative(),
      field_catalog_version: z.number().int().positive(),
      mappings: z.array(
        z.strictObject({
          id: z.string().min(1),
          version_number: z.number().int().positive(),
          content_hash: z.string().min(1),
        }),
      ),
    });
    const bind = (version: RuleDiffVersion): RuleDiffVersion => {
      const row = bindings.rows.find((row) => row.id === version.id),
        raw = row?.activation_snapshot ?? row?.test_snapshot ?? null,
        hash = row?.activation_snapshot ? row.activation_hash : row?.test_hash;
      const snapshot = raw === null ? null : snapshotSchema.parse(raw);
      if (snapshot && canonicalHash(snapshot) !== hash)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '历史映射证明校验失败，请重新核查。',
        );
      return {
        ...version,
        mapping_snapshot: snapshot,
        mapping_basis: row?.activation_snapshot
          ? 'activation_proof'
          : row?.test_snapshot
            ? 'latest_completed_test'
            : 'unknown',
      };
    };
    const from = bind(fromVersion),
      to = bind(toVersion);
    return dataResponse(
      request,
      {
        rule_id: rule.id,
        from,
        to,
        ...diffRuleVersions(from, to),
      },
      mode,
    );
  });
  app.get('/api/v1/rule-mappings', async (request) => {
    const actor = await deps.identity.requireActor(request);
    return dataResponse(
      request,
      {
        field_catalog_version: 1,
        fields: [...FIELD_CATALOG],
        template_fields: [...MAPPING_TARGET_FIELDS],
        identity_fields: DEFAULT_SRS_MAPPING_FIELDS,
        ...(await deps.finance.mappings.list(actor)),
        transforms: [
          'identity',
          'trim_string',
          'date_iso',
          'decimal_yuan_to_minor',
          'enum_lookup',
        ],
      },
      mode,
    );
  });
  app.get('/api/v1/rule-mappings/:id', async (request) =>
    dataResponse(
      request,
      await deps.finance.mappings.get(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/rule-mappings', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    reply.code(201);
    return dataResponse(
      request,
      await deps.finance.mappings.createDraft(
        actor,
        MappingDraftSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.patch('/api/v1/rule-mappings/:id/draft', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    return dataResponse(
      request,
      await deps.finance.mappings.saveDraft(
        actor,
        id(request.params),
        MappingSaveSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.post('/api/v1/rule-mappings/:id/tests', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    return dataResponse(
      request,
      await deps.finance.mappings.testDraft(
        actor,
        id(request.params),
        MappingTestSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
}
