import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ActorContext, ActionReceipt } from '@caixiaozhi/contracts';
import {
  SkillManifestSchema,
  SkillGrantSchema,
  RequestedSkillScopeSchema,
  SelectionPlanSchema,
  type SkillManifest,
  type SkillGrant,
  type RequestedSkillScope,
  type FrozenSkill,
  type SelectionPlan,
} from '@caixiaozhi/contracts/skills';
import type {
  CapabilityDefinition,
  ExecutionContext,
} from '@caixiaozhi/contracts/integrations';
import type { DependencyRef } from '@caixiaozhi/contracts/actions';
import type { Database, DatabaseExecutor } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  canonicalJson,
  hashPayload,
  type ActionService,
} from '@caixiaozhi/action-service';
import {
  assertJob,
  claimInsightJob,
  enqueueJob,
  finishJob,
  json,
  startJobHeartbeat,
  writeCommand,
  type Row,
} from './shared.js';
const validatorVersion = 'skill-validator-v1';
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  validateFormats: false,
});
const sections = [
  '任务目标',
  '适用范围',
  '工作步骤',
  '需要询问的情况',
  '输出要求',
  '禁止事项',
];
type ValidationCheck = {
  name: string;
  status: 'passed' | 'failed' | 'blocked';
  path?: string;
  message?: string;
};
export type SkillServiceOptions = {
  freshActor(actor: ActorContext): Promise<ActorContext>;
  isGroupMember(
    actor: ActorContext,
    groupId: string,
    userId: string,
  ): Promise<boolean>;
  assertGroupExists?: (actor: ActorContext, groupId: string) => Promise<void>;
  assertReviewerExists?: (actor: ActorContext, userId: string) => Promise<void>;
  assertManageScope?: (
    actor: ActorContext,
    scope: RequestedSkillScope,
  ) => Promise<void>;
  assertCapabilityReference?: (
    actor: ActorContext,
    definition: CapabilityDefinition,
  ) => Promise<void>;
  validateExamples?: (
    actor: ActorContext,
    skill: FrozenSkill,
  ) => Promise<{ checks: ValidationCheck[]; test_run_ids: string[] }>;
  validateModel?: (
    actor: ActorContext,
    skill: FrozenSkill,
  ) => Promise<{ passed: boolean; test_run_ids: string[] }>;
  profileVersion?: string;
  actions?: ActionService;
};
function staticContent(
  manifestInput: unknown,
  markdown: string,
): SkillManifest {
  const manifest = SkillManifestSchema.parse(manifestInput);
  if (
    Buffer.byteLength(canonicalJson(manifest)) > 128 * 1024 ||
    Buffer.byteLength(markdown) > 64 * 1024
  )
    throw new AppError('VALIDATION_ERROR', '能力配置或说明超过大小上限。');
  if (
    sections.some(
      (s) => !new RegExp(`^#{1,6}\\s+${s}\\s*$`, 'm').test(markdown),
    )
  )
    throw new AppError('VALIDATION_ERROR', '工作说明缺少必备章节。', {
      details: { path: 'markdown' },
    });
  if (
    /<\/?[a-z][^>]*>|!\[[^\]]*\]\([^)]*\)|\]\(\s*(?:javascript|data|https?):|```\s*(?:js|javascript|python|bash|sh|shell)|\b(?:exec|spawn|subprocess|npm install|pip install|curl\s+https?:)\b/i.test(
      markdown,
    ) ||
    /(?:sk-[a-zA-Z0-9]{20,}|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[a-zA-Z0-9._-]{20,})/.test(
      markdown + canonicalJson(manifest),
    )
  )
    throw new AppError(
      'VALIDATION_ERROR',
      '能力只接受声明式说明，不能包含脚本、外部资源或凭据。',
    );
  const reserved = new Set([
    'actor',
    'tenant_id',
    'authz_version',
    'token',
    'confirmation_token',
    'base_url',
    'permission_override',
  ]);
  const inspect = (schema: unknown, depth = 0) => {
    if (depth > 8)
      throw new AppError('VALIDATION_ERROR', 'JSON Schema 嵌套超过 8 层。');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
    const s = schema as Record<string, unknown>;
    if (typeof s.$ref === 'string' && !s.$ref.startsWith('#/'))
      throw new AppError('VALIDATION_ERROR', '禁止引用外部 JSON Schema。');
    if (s.type === 'object' && s.additionalProperties !== false)
      throw new AppError('VALIDATION_ERROR', '输入输出对象必须拒绝未知字段。');
    if (
      s.type === 'array' &&
      (!Number.isInteger(s.maxItems) || Number(s.maxItems) > 1000)
    )
      throw new AppError('VALIDATION_ERROR', '数组必须限制最大项数。');
    if (
      s.type === 'string' &&
      (!Number.isInteger(s.maxLength) || Number(s.maxLength) > 64000)
    )
      throw new AppError('VALIDATION_ERROR', '字符串必须限制最大长度。');
    if (s.properties && typeof s.properties === 'object')
      for (const [key, value] of Object.entries(s.properties)) {
        if (reserved.has(key))
          throw new AppError(
            'VALIDATION_ERROR',
            '能力字段不能声明身份或执行凭据。',
          );
        if (key === 'amount_minor' && (value as Row).type !== 'string')
          throw new AppError(
            'VALIDATION_ERROR',
            '金额分必须使用十进制字符串。',
          );
        inspect(value, depth + 1);
      }
    if (s.items) inspect(s.items, depth + 1);
    for (const key of ['allOf', 'anyOf', 'oneOf'])
      if (Array.isArray(s[key]))
        for (const v of s[key] as unknown[]) inspect(v, depth + 1);
    if (s.$defs && typeof s.$defs === 'object')
      for (const v of Object.values(s.$defs)) inspect(v, depth + 1);
  };
  inspect(manifest.input_schema);
  inspect(manifest.output_schema);
  try {
    const input = ajv.compile(manifest.input_schema),
      output = ajv.compile(manifest.output_schema);
    for (const example of manifest.examples)
      if (!input(example.input) || !output(example.expected))
        throw new Error('example');
  } catch {
    throw new AppError(
      'VALIDATION_ERROR',
      '输入输出 Schema 或示例未通过校验。',
    );
  }
  if (
    new Set(manifest.tools.map((t) => t.capability_version_id)).size !==
    manifest.tools.length
  )
    throw new AppError('VALIDATION_ERROR', '工具不能重复。');
  if (
    new Set(manifest.examples.map((example) => example.name)).size !==
    manifest.examples.length
  )
    throw new AppError('VALIDATION_ERROR', '测试样例名称不能重复。');
  return manifest;
}
export function createSkillService(
  database: Database,
  options: SkillServiceOptions,
) {
  const profile = options.profileVersion ?? 'finance-sdk-v1';
  async function fresh(actor: ActorContext, manage = false) {
    const a = await options.freshActor(actor);
    if (
      a.tenant_id !== actor.tenant_id ||
      a.user_id !== actor.user_id ||
      !a.permissions.includes(manage ? 'skill.manage' : 'skill.use')
    )
      throw new AppError(
        'FORBIDDEN',
        manage ? '无能力维护权限。' : '无能力使用权限。',
      );
    return a;
  }
  async function skillRow(
    actor: ActorContext,
    id: string,
    tx: DatabaseExecutor = database,
  ) {
    const row = (
      await tx.execute(
        sql`SELECT * FROM skills WHERE tenant_id=${actor.tenant_id} AND id=${id}`,
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '能力不存在或无权访问。');
    return row;
  }
  async function can(
    actor: ActorContext,
    skill: Row,
    action: SkillGrant['action'],
    tx: DatabaseExecutor = database,
    includeReview = true,
  ) {
    if (skill.owner_id === actor.user_id) return true;
    const rows = (
      await tx.execute(
        sql`SELECT * FROM skill_grants WHERE tenant_id=${actor.tenant_id} AND skill_id=${skill.id as string} AND action=${action} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND ((subject_type='user' AND subject_id=${actor.user_id}) OR (subject_type='tenant' AND subject_id=${actor.tenant_id}) OR subject_type='group')`,
      )
    ).rows;
    for (const grant of rows)
      if (
        grant.subject_type !== 'group' ||
        (await options.isGroupMember(
          actor,
          String(grant.subject_id),
          actor.user_id,
        ))
      )
        return true;
    if (action === 'source_read' && includeReview) {
      const review = (
        await tx.execute(
          sql`SELECT id FROM skill_reviews WHERE tenant_id=${actor.tenant_id} AND reviewer_id=${actor.user_id} AND status='review_pending' AND skill_version_id IN(SELECT id FROM skill_versions WHERE tenant_id=${actor.tenant_id} AND skill_id=${skill.id as string}) LIMIT 1`,
        )
      ).rows[0];
      if (review) return true;
    }
    return false;
  }
  async function requireAction(
    actor: ActorContext,
    id: string,
    action: SkillGrant['action'],
    tx: DatabaseExecutor = database,
  ) {
    const a = await fresh(
        actor,
        ['maintain', 'review', 'publish'].includes(action),
      ),
      s = await skillRow(a, id, tx);
    if (!(await can(a, s, action, tx)))
      throw new AppError('NOT_FOUND', '能力不存在或无权访问。');
    return { actor: a, skill: s };
  }
  async function version(
    actor: ActorContext,
    skillId: string,
    id: string,
    tx: DatabaseExecutor = database,
  ) {
    const row = (
      await tx.execute(
        sql`SELECT * FROM skill_versions WHERE tenant_id=${actor.tenant_id} AND skill_id=${skillId} AND id=${id}`,
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '能力版本不存在。');
    return row;
  }
  const frozen = (s: Row, v: Row): FrozenSkill => ({
    skill_id: String(s.id),
    skill_version_id: String(v.id),
    version_number: Number(v.version_number),
    content_hash: String(v.content_hash),
    markdown: String(v.markdown),
    manifest: v.manifest_json as SkillManifest,
    capability_versions: (v.manifest_json as SkillManifest).tools.map(
      (t) => t.capability_version_id,
    ),
    revocation_epoch: Number(s.revocation_epoch),
  });
  async function audit(
    actor: ActorContext,
    id: string,
    operation: string,
    details: unknown = {},
    versionId: string | null = null,
    tx: DatabaseExecutor = database,
  ) {
    await tx.execute(
      sql`INSERT INTO skill_audit_events(tenant_id,id,skill_id,skill_version_id,actor_id,operation,details) VALUES(${actor.tenant_id},${randomUUID()},${id},${versionId},${actor.user_id},${operation},${json(details)})`,
    );
  }
  async function capability(
    actor: ActorContext,
    id: string,
    tx: DatabaseExecutor = database,
  ) {
    const r = (
      await tx.execute(
        sql`SELECT v.definition FROM integration_capability_versions v JOIN integration_capabilities c ON c.tenant_id=v.tenant_id AND c.id=v.capability_id JOIN integration_connectors con ON con.tenant_id=v.tenant_id AND (con.id=v.definition->>'connector_id' OR con.id=v.tenant_id||':'||(v.definition->>'connector_id')) WHERE v.tenant_id=${actor.tenant_id} AND (v.id=${id} OR v.definition->>'id'=${id}) AND c.status='published' AND con.status='enabled' AND v.published_at IS NOT NULL`,
      )
    ).rows[0];
    if (!r)
      throw new AppError('REVALIDATION_REQUIRED', '依赖工具未发布或已停用。');
    const d = r.definition as CapabilityDefinition;
    if (d.effect === 'write')
      throw new AppError('VALIDATION_ERROR', 'Skill 不能直接调用写处理器。');
    if (options.assertCapabilityReference)
      await options.assertCapabilityReference(actor, d);
    return d;
  }
  async function checkDependencies(
    actor: ActorContext,
    manifest: SkillManifest,
    requiredPermission = true,
    tx: DatabaseExecutor = database,
  ) {
    const names: string[] = [];
    for (const tool of manifest.tools) {
      const d = await capability(actor, tool.capability_version_id, tx);
      names.push(d.name);
      if (
        requiredPermission &&
        tool.required &&
        d.required_permissions.some(
          (p) => !actor.permissions.includes(p as never),
        )
      )
        throw new AppError('FORBIDDEN', '缺少所需工具的业务权限。');
    }
    if (
      names.includes('finance.action.prepare') &&
      !manifest.allowed_action_operations.length
    )
      throw new AppError(
        'VALIDATION_ERROR',
        '动作准备工具必须列出允许的操作。',
      );
    if (
      manifest.scope_policy.department_ids?.some(
        (id) => !actor.department_ids.includes(id),
      )
    )
      throw new AppError('FORBIDDEN', '能力范围不能扩大当前授权部门。');
    for (const example of manifest.examples)
      if (example.expected_tool_names.some((name) => !names.includes(name)))
        throw new AppError('VALIDATION_ERROR', '示例引用了未声明工具。');
    return names;
  }
  async function listVisibleSkills(actor: ActorContext, input: unknown = {}) {
    const a = await fresh(actor),
      q = z
        .strictObject({
          q: z.string().max(100).optional(),
          scope: z.enum(['personal', 'group', 'tenant']).optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(input);
    const grants = (
      await database.execute(
        sql`SELECT skill_id,subject_type,subject_id FROM skill_grants WHERE tenant_id=${a.tenant_id} AND action='use' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND ((subject_type='user' AND subject_id=${a.user_id}) OR (subject_type='tenant' AND subject_id=${a.tenant_id}) OR subject_type='group')`,
      )
    ).rows;
    const ids: string[] = [];
    for (const g of grants)
      if (
        g.subject_type !== 'group' ||
        (await options.isGroupMember(a, String(g.subject_id), a.user_id))
      )
        ids.push(String(g.skill_id));
    const rows = (
      await database.execute(
        sql`SELECT id,owner_id,title,summary,scope,state,published_version_id,version,revocation_epoch FROM skills WHERE tenant_id=${a.tenant_id} AND (owner_id=${a.user_id} OR id IN(SELECT jsonb_array_elements_text(${json(ids)}))) AND state<>'archived' AND (state='enabled' OR owner_id=${a.user_id}) ${q.scope ? sql`AND scope=${q.scope}` : sql``} ${q.q ? sql`AND (strpos(title,${q.q})>0 OR strpos(summary,${q.q})>0)` : sql``} ${q.cursor ? sql`AND id>${q.cursor}` : sql``} ORDER BY id LIMIT ${q.limit + 1}`,
      )
    ).rows;
    const items = await Promise.all(
      rows.slice(0, q.limit).map(async (r) => {
        const detail = await getSkill(a, String(r.id));
        return {
          id: String(r.id),
          owner_id: String(r.owner_id),
          title: String(r.title),
          summary: String(r.summary),
          scope: String(r.scope),
          state: String(r.state),
          version: Number(r.version),
          published_version_id: r.published_version_id as string | null,
          revocation_epoch: Number(r.revocation_epoch),
          status: detail.status,
          usable: detail.usable,
        };
      }),
    );
    return {
      items,
      next_cursor: rows.length > q.limit ? String(rows[q.limit - 1]!.id) : null,
    };
  }
  async function getSkill(actor: ActorContext, id: string, versionId?: string) {
    const { actor: a, skill: s } = await requireAction(actor, id, 'use');
    const activation = (
      await database.execute(
        sql`SELECT active_version_id,selection_policy FROM skill_activations WHERE tenant_id=${a.tenant_id} AND user_id=${a.user_id} AND skill_id=${id}`,
      )
    ).rows[0];
    const maintain = await can(a, s, 'maintain');
    const versions = (
      await database.execute(
        sql`SELECT id,version_number,status,version FROM skill_versions WHERE tenant_id=${a.tenant_id} AND skill_id=${id} ${maintain ? sql`` : sql`AND status='published'`} ORDER BY version_number DESC`,
      )
    ).rows;
    const reviews = maintain
      ? (
          await database.execute(
            sql`SELECT id,skill_version_id,status,reviewer_id,requested_scope,version,decision_reason FROM skill_reviews WHERE tenant_id=${a.tenant_id} AND skill_version_id IN(SELECT id FROM skill_versions WHERE tenant_id=${a.tenant_id} AND skill_id=${id}) ORDER BY created_at DESC`,
          )
        ).rows
      : [];
    const chosen =
      versionId ??
      (activation?.selection_policy === 'pin'
        ? activation.active_version_id
        : (s.published_version_id ??
          activation?.active_version_id ??
          (maintain ? versions[0]?.id : null)));
    if (!chosen)
      return {
        id,
        owner_id: String(s.owner_id),
        can_maintain: maintain,
        can_source_read: await can(a, s, 'source_read'),
        title: String(s.title),
        summary: String(s.summary),
        scope: String(s.scope),
        state: String(s.state),
        version: Number(s.version),
        status: 'pending_validation',
        usable: false,
      };
    const v = await version(a, id, String(chosen));
    if (v.status !== 'published' && s.owner_id !== a.user_id)
      throw new AppError('NOT_FOUND', '此版本尚未发布。');
    const m = v.manifest_json as SkillManifest;
    let usable =
      s.state === 'enabled' &&
      (v.status === 'published' ||
        (v.status === 'validated' &&
          s.owner_id === a.user_id &&
          activation?.active_version_id === v.id));
    try {
      await checkDependencies(a, m);
      await validVersion(a, s, v);
    } catch {
      usable = false;
    }
    return {
      id,
      owner_id: String(s.owner_id),
      can_maintain: maintain,
      can_source_read: await can(a, s, 'source_read'),
      title: m.title,
      summary: m.summary,
      scope: String(s.scope),
      state: String(s.state),
      version: Number(s.version),
      version_id: String(v.id),
      version_number: Number(v.version_number),
      version_state_version: Number(v.version),
      status: String(v.status),
      usable,
      input_schema: m.input_schema,
      output_schema: m.output_schema,
      tools: m.tools,
      scope_policy: m.scope_policy,
      versions,
      reviews,
    };
  }
  async function getSkillSource(
    actor: ActorContext,
    id: string,
    versionId: string,
  ) {
    const { actor: a, skill: s } = await requireAction(
      actor,
      id,
      'source_read',
    );
    if (!(await can(a, s, 'source_read', database, false))) {
      const assigned = (
        await database.execute(
          sql`SELECT id FROM skill_reviews WHERE tenant_id=${a.tenant_id} AND reviewer_id=${a.user_id} AND skill_version_id=${versionId} AND status='review_pending'`,
        )
      ).rows[0];
      if (!assigned) throw new AppError('NOT_FOUND', '此候选版本未授权读取。');
    }
    const v = await version(a, id, versionId);
    await audit(a, id, 'source_read', {}, versionId);
    return {
      id: versionId,
      manifest: v.manifest_json as SkillManifest,
      markdown: String(v.markdown),
      content_hash: String(v.content_hash),
      status: String(v.status),
      version: Number(v.version),
    };
  }
  async function createSkill(actor: ActorContext, input: unknown, key: string) {
    const a = await fresh(actor, true),
      d = z
        .strictObject({
          slug: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
          title: z.string().min(1).max(32),
          summary: z.string().min(1).max(120),
        })
        .parse(input);
    return writeCommand(database, a, 'skill.create', key, d, async (tx) => {
      const id = randomUUID();
      await tx.execute(
        sql`INSERT INTO skills(tenant_id,id,owner_id,slug,title,summary) VALUES(${a.tenant_id},${id},${a.user_id},${d.slug},${d.title},${d.summary})`,
      );
      await audit(a, id, 'created', {}, null, tx);
      return { id, version: 1 };
    });
  }
  async function saveVersion(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    const { actor: a } = await requireAction(actor, id, 'maintain'),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          base_version_id: z.string().optional(),
          manifest: z.unknown(),
          markdown: z.string(),
        })
        .parse(input),
      manifest = staticContent(d.manifest, d.markdown);
    return writeCommand(
      database,
      a,
      'skill.version.save',
      key,
      { id, ...d },
      async (tx) => {
        await tx.execute(
          sql`SELECT id FROM skills WHERE tenant_id=${a.tenant_id} AND id=${id} FOR UPDATE`,
        );
        const s = await skillRow(a, id, tx);
        if (s.version !== d.expected_version)
          throw new AppError('VERSION_CONFLICT', '能力档案已更新。');
        if (d.base_version_id) await version(a, id, d.base_version_id, tx);
        const max = (
            await tx.execute(
              sql`SELECT COALESCE(max(version_number),0)::int AS value FROM skill_versions WHERE tenant_id=${a.tenant_id} AND skill_id=${id}`,
            )
          ).rows[0]!,
          versionId = randomUUID(),
          number = Number(max.value) + 1,
          hash = hashPayload({ manifest, markdown: d.markdown });
        await tx.execute(
          sql`INSERT INTO skill_versions(tenant_id,id,skill_id,version_number,manifest_json,markdown,content_hash,base_version_id) VALUES(${a.tenant_id},${versionId},${id},${number},${json(manifest)},${d.markdown},${hash},${d.base_version_id ?? null})`,
        );
        await tx.execute(
          sql`UPDATE skills SET version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${id}`,
        );
        await audit(
          a,
          id,
          'version_created',
          { content_hash: hash },
          versionId,
          tx,
        );
        return {
          id: versionId,
          skill_id: id,
          version: 1,
          version_number: number,
          content_hash: hash,
        };
      },
    );
  }
  async function validateVersion(
    actor: ActorContext,
    id: string,
    versionId: string,
    input: unknown,
    key: string,
  ) {
    const { actor: a } = await requireAction(actor, id, 'maintain'),
      d = z
        .strictObject({ expected_version: z.number().int().positive() })
        .parse(input);
    return writeCommand(
      database,
      a,
      'skill.validate',
      key,
      { id, versionId, ...d },
      async (tx) => {
        const s = await skillRow(a, id, tx),
          v = await version(a, id, versionId, tx);
        if (v.version !== d.expected_version)
          throw new AppError('VERSION_CONFLICT', '能力版本状态已变化。');
        const prior = (
          await tx.execute(
            sql`SELECT id,job_id,status FROM skill_validation_runs WHERE tenant_id=${a.tenant_id} AND skill_version_id=${versionId} AND content_hash=${v.content_hash as string} AND validator_version=${validatorVersion} AND profile_version=${profile} AND status IN('queued','running','passed') ORDER BY created_at DESC LIMIT 1`,
          )
        ).rows[0];
        if (prior)
          return {
            validation_id: String(prior.id),
            job_id: String(prior.job_id),
            status: String(prior.status),
          };
        const validationId = randomUUID(),
          jobId = await enqueueJob(tx, a, 'skills.validate', validationId),
          snapshot = (v.manifest_json as SkillManifest).tools.map(
            (t) => t.capability_version_id,
          );
        await tx.execute(
          sql`INSERT INTO skill_validation_runs(tenant_id,id,skill_version_id,content_hash,validator_version,profile_version,capability_snapshot,status,job_id,checks) VALUES(${a.tenant_id},${validationId},${versionId},${v.content_hash as string},${validatorVersion},${profile},${json(snapshot)},'queued',${jobId},${json([{ name: 'actor', status: 'passed', actor: a }])})`,
        );
        await tx.execute(
          sql`UPDATE skill_versions SET status='validating',validation_id=${validationId},version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${versionId}`,
        );
        await audit(a, String(s.id), 'validation_queued', {}, versionId, tx);
        return { validation_id: validationId, job_id: jobId, status: 'queued' };
      },
    );
  }
  async function processValidationJob(
    jobId: string,
    workerId = 'skill-validation-worker',
  ) {
    const job = await claimInsightJob(database, jobId, workerId);
    if (!job) return false;
    if (job.kind !== 'skills.validate')
      throw new AppError('INVALID_STATE', '不是能力验证任务。');
    const stopHeartbeat = startJobHeartbeat(database, job);
    try {
      const validation = (
        await database.execute(
          sql`SELECT * FROM skill_validation_runs WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string}`,
        )
      ).rows[0]!;
      const v = (
          await database.execute(
            sql`SELECT * FROM skill_versions WHERE tenant_id=${job.tenant_id as string} AND id=${validation.skill_version_id as string}`,
          )
        ).rows[0]!,
        s = (
          await database.execute(
            sql`SELECT * FROM skills WHERE tenant_id=${job.tenant_id as string} AND id=${v.skill_id as string}`,
          )
        ).rows[0]!;
      const stored = (
        validation.checks as Array<{ actor?: ActorContext }>
      ).find((c) => c.actor)?.actor;
      let status: 'passed' | 'failed' | 'blocked' = 'failed',
        code: string | null = null,
        checks: ValidationCheck[] = [],
        testRuns: string[] = [];
      try {
        if (!stored) throw new AppError('INVALID_STATE', '验证身份缺失。');
        const actor = await fresh(stored, true),
          f = frozen(s, v);
        staticContent(f.manifest, f.markdown);
        checks.push({ name: 'static', status: 'passed' });
        await checkDependencies(actor, f.manifest, false);
        checks.push({ name: 'capabilities', status: 'passed' });
        if (!options.validateExamples || !options.validateModel) {
          status = 'blocked';
          code = 'DEPENDENCY_UNAVAILABLE';
          checks.push({
            name: !options.validateExamples ? 'examples' : 'model',
            status: 'blocked',
            message: '受控示例或真实模型验证尚未配置。',
          });
        } else {
          const examples = await options.validateExamples(actor, f);
          checks.push(...examples.checks);
          testRuns.push(...examples.test_run_ids);
          if (examples.checks.some((c) => c.status !== 'passed'))
            throw new AppError('VALIDATION_ERROR', '示例执行未通过。');
          const model = await options.validateModel(actor, f);
          testRuns.push(...model.test_run_ids);
          if (!model.passed || !model.test_run_ids.length)
            throw new AppError('VALIDATION_ERROR', '真实模型验证未通过。');
          checks.push({ name: 'model', status: 'passed' });
          status = 'passed';
        }
      } catch (error) {
        code =
          error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE';
        status =
          code === 'DEPENDENCY_UNAVAILABLE' || code === 'RATE_LIMITED'
            ? 'blocked'
            : 'failed';
        checks.push({
          name: 'validation',
          status: status === 'blocked' ? 'blocked' : 'failed',
          message:
            status === 'blocked'
              ? '真实模型、隔离夹具或受控试运行暂不可用，可修复后重试。'
              : '内容、依赖或试运行检查未通过。',
        });
      }
      await database.transaction(async (tx) => {
        await assertJob(tx, job);
        await tx.execute(
          sql`UPDATE skill_validation_runs SET status=${status},checks=${json(checks)},test_run_ids=${json(testRuns)},error_code=${code},version=version+1,updated_at=now() WHERE tenant_id=${job.tenant_id as string} AND id=${validation.id as string}`,
        );
        await tx.execute(
          sql`UPDATE skill_versions SET status=${status === 'passed' ? 'validated' : 'draft'},version=version+1,updated_at=now() WHERE tenant_id=${job.tenant_id as string} AND id=${v.id as string} AND content_hash=${validation.content_hash as string}`,
        );
        await finishJob(
          tx,
          job,
          status === 'passed' ? 'succeeded' : 'failed',
          code,
        );
      });
      return true;
    } finally {
      stopHeartbeat();
    }
  }
  async function getValidation(
    actor: ActorContext,
    id: string,
    validationId: string,
  ) {
    const { actor: a } = await requireAction(actor, id, 'maintain');
    const row = (
      await database.execute(
        sql`SELECT r.* FROM skill_validation_runs r JOIN skill_versions v ON v.tenant_id=r.tenant_id AND v.id=r.skill_version_id WHERE r.tenant_id=${a.tenant_id} AND r.id=${validationId} AND v.skill_id=${id}`,
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '验证任务不存在。');
    return {
      validation_id: validationId,
      status: String(row.status),
      checks: (row.checks as Row[]).map(({ actor: _actor, ...check }) => check),
      test_run_ids: row.test_run_ids,
      error_code: row.error_code,
      synthetic: row.synthetic,
      version: Number(row.version),
    };
  }
  async function validVersion(
    actor: ActorContext,
    s: Row,
    v: Row,
    tx: DatabaseExecutor = database,
  ) {
    const validation = (
      await tx.execute(
        sql`SELECT * FROM skill_validation_runs WHERE tenant_id=${actor.tenant_id} AND id=${(v.validation_id as string) ?? ''} AND skill_version_id=${v.id as string} AND content_hash=${v.content_hash as string} AND validator_version=${validatorVersion} AND profile_version=${profile} AND status='passed' AND synthetic=false`,
      )
    ).rows[0];
    if (!validation)
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '能力尚未通过当前内容和依赖的真实验证。',
      );
    await checkDependencies(actor, v.manifest_json as SkillManifest, false, tx);
    return frozen(s, v);
  }
  async function activatePersonalVersion(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    const { actor: a, skill: s } = await requireAction(actor, id, 'use'),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          version_id: z.string(),
          selection_policy: z.enum(['pin', 'follow_published']),
        })
        .parse(input);
    return writeCommand(
      database,
      a,
      'skill.activate',
      key,
      { id, ...d },
      async (tx) => {
        const v = await version(a, id, d.version_id, tx);
        await validVersion(a, s, v, tx);
        if (s.version !== d.expected_version)
          throw new AppError('VERSION_CONFLICT', '能力档案已变化。');
        if (s.owner_id !== a.user_id && v.status !== 'published')
          throw new AppError('NOT_FOUND', '此版本尚不可用。');
        if (s.state !== 'enabled')
          throw new AppError('INVALID_STATE', '能力已停用。');
        await checkDependencies(a, v.manifest_json as SkillManifest, true, tx);
        await tx.execute(
          sql`INSERT INTO skill_activations(tenant_id,user_id,skill_id,active_version_id,selection_policy) VALUES(${a.tenant_id},${a.user_id},${id},${d.version_id},${d.selection_policy}) ON CONFLICT(tenant_id,user_id,skill_id) DO UPDATE SET active_version_id=excluded.active_version_id,selection_policy=excluded.selection_policy,version=skill_activations.version+1,updated_at=now()`,
        );
        await audit(a, id, 'activated', {}, d.version_id, tx);
        return {
          id,
          version_id: d.version_id,
          selection_policy: d.selection_policy,
        };
      },
    );
  }
  async function requestReview(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    const { actor: a, skill: s } = await requireAction(actor, id, 'maintain'),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          version_id: z.string(),
          requested_scope: RequestedSkillScopeSchema,
          grants: z.array(SkillGrantSchema).min(1).max(100),
          reviewer_id: z.string().min(1),
        })
        .parse(input);
    if (!options.assertManageScope)
      throw new AppError('FORBIDDEN', '共享范围管理授权尚未配置。');
    await options.assertManageScope(a, d.requested_scope);
    if (d.reviewer_id === a.user_id)
      throw new AppError('FORBIDDEN', '作者不能审查自己的共享版本。');
    await options.assertReviewerExists?.(a, d.reviewer_id);
    for (const group of d.requested_scope.group_ids ?? [])
      await options.assertGroupExists?.(a, group);
    if (
      d.requested_scope.scope === 'group' &&
      (!d.requested_scope.group_ids?.length ||
        d.grants.some(
          (g) =>
            g.subject_type !== 'group' ||
            !d.requested_scope.group_ids!.includes(g.subject_id),
        ))
    )
      throw new AppError('VALIDATION_ERROR', '共享授权超出审查目标组。');
    if (
      d.requested_scope.scope === 'tenant' &&
      d.grants.some(
        (g) => g.subject_type === 'tenant' && g.subject_id !== a.tenant_id,
      )
    )
      throw new AppError('VALIDATION_ERROR', '不能跨租户授权。');
    return writeCommand(
      database,
      a,
      'skill.review.request',
      key,
      { id, ...d },
      async (tx) => {
        const v = await version(a, id, d.version_id, tx);
        await validVersion(a, s, v, tx);
        if (s.version !== d.expected_version)
          throw new AppError('VERSION_CONFLICT', '能力档案已变化。');
        const examples = (v.manifest_json as SkillManifest).examples;
        if (
          ['success', 'clarify', 'deny'].some(
            (e) => !examples.some((x) => x.expectation === e),
          )
        )
          throw new AppError(
            'VALIDATION_ERROR',
            '共享版本需要成功、澄清与越权拒绝三类样例。',
          );
        const reviewId = randomUUID();
        await tx.execute(
          sql`INSERT INTO skill_reviews(tenant_id,id,skill_version_id,author_id,requested_scope,requested_grants,reviewer_id,reviewed_hash) VALUES(${a.tenant_id},${reviewId},${d.version_id},${a.user_id},${json(d.requested_scope)},${json(d.grants)},${d.reviewer_id},${v.content_hash as string})`,
        );
        await tx.execute(
          sql`UPDATE skill_versions SET status='review_pending',version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${d.version_id}`,
        );
        await audit(a, id, 'review_requested', {}, d.version_id, tx);
        return { review_id: reviewId, version: 1, status: 'review_pending' };
      },
    );
  }
  async function decideReview(
    actor: ActorContext,
    id: string,
    reviewId: string,
    input: unknown,
    key: string,
  ) {
    const a = await fresh(actor),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          decision: z.enum(['approved', 'rejected']),
          reason: z.string().min(1).max(1000),
        })
        .parse(input);
    return writeCommand(
      database,
      a,
      'skill.review.decide',
      key,
      { id, reviewId, ...d },
      async (tx) => {
        const r = (
          await tx.execute(
            sql`SELECT r.* FROM skill_reviews r JOIN skill_versions v ON v.tenant_id=r.tenant_id AND v.id=r.skill_version_id WHERE r.tenant_id=${a.tenant_id} AND r.id=${reviewId} AND v.skill_id=${id} FOR UPDATE OF r`,
          )
        ).rows[0];
        if (!r) throw new AppError('NOT_FOUND', '审查任务不存在。');
        if (r.author_id === a.user_id || r.reviewer_id !== a.user_id)
          throw new AppError('FORBIDDEN', '只能由指定的独立审查人处理。');
        if (r.version !== d.expected_version || r.status !== 'review_pending')
          throw new AppError('VERSION_CONFLICT', '审查版本或状态已变化。');
        const v = await version(a, id, String(r.skill_version_id), tx);
        if (v.content_hash !== r.reviewed_hash)
          throw new AppError('REVALIDATION_REQUIRED', '审查内容已变化。');
        if (d.decision === 'approved')
          await validVersion(a, await skillRow(a, id, tx), v, tx);
        await tx.execute(
          sql`UPDATE skill_reviews SET status=${d.decision},decision_reason=${d.reason},decided_at=now(),version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${reviewId}`,
        );
        await tx.execute(
          sql`UPDATE skill_versions SET status=${d.decision},version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${v.id as string}`,
        );
        await audit(
          a,
          id,
          'review_decided',
          { decision: d.decision },
          String(v.id),
          tx,
        );
        return {
          review_id: reviewId,
          status: d.decision,
          version: d.expected_version + 1,
        };
      },
    );
  }
  async function publicationValidation(
    actor: ActorContext,
    args: unknown,
    tx: DatabaseExecutor = database,
  ) {
    const d = z
        .strictObject({
          skill_id: z.string(),
          version_id: z.string(),
          review_id: z.string(),
          expected_version: z.number().int().positive(),
        })
        .parse(args),
      { actor: a, skill: s } = await requireAction(
        actor,
        d.skill_id,
        'publish',
        tx,
      ),
      v = await version(a, d.skill_id, d.version_id, tx);
    await validVersion(a, s, v, tx);
    const r = (
      await tx.execute(
        sql`SELECT * FROM skill_reviews WHERE tenant_id=${a.tenant_id} AND id=${d.review_id} AND skill_version_id=${d.version_id}`,
      )
    ).rows[0];
    if (!r || r.status !== 'approved' || r.reviewed_hash !== v.content_hash)
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '共享审查尚未批准或内容已变化。',
      );
    if (s.version !== d.expected_version)
      throw new AppError('VERSION_CONFLICT', '发布指针已变化。');
    if (!options.assertManageScope)
      throw new AppError('FORBIDDEN', '发布范围授权尚未配置。');
    await options.assertManageScope(
      a,
      r.requested_scope as RequestedSkillScope,
    );
    for (const group of (r.requested_scope as RequestedSkillScope).group_ids ??
      [])
      await options.assertGroupExists?.(a, group);
    await options.assertReviewerExists?.(a, String(r.reviewer_id));
    return { d, a, s, v, r };
  }
  if (options.actions)
    options.actions.registerHandler('skill.publish', {
      async validate(actor, args, refs, tx) {
        const { d, s, v, r } = await publicationValidation(actor, args, tx);
        if (
          refs.length !== 1 ||
          refs[0]?.type !== 'skill' ||
          refs[0].id !== d.skill_id ||
          refs[0].version !== d.expected_version
        )
          throw new AppError('VALIDATION_ERROR', '发布资源版本不匹配。');
        return {
          args: d,
          summary: {
            title: '发布共享能力',
            skill_title: s.title,
            version_number: v.version_number,
            scope: r.requested_scope,
            tools: (v.manifest_json as SkillManifest).tools,
          },
          items: [{ resource_ref: refs[0] }],
          extra_guards: {
            content_hash: v.content_hash,
            review_id: r.id,
            scope_hash: hashPayload({
              scope: r.requested_scope,
              grants: r.requested_grants,
            }),
          },
        };
      },
      async execute(ctx, tx, action) {
        const { d, a, s, r } = await publicationValidation(
          ctx.actor,
          action.args,
          tx!,
        );
        const updated = await tx!.execute(
          sql`UPDATE skills SET published_version_id=${d.version_id},scope=${(r.requested_scope as RequestedSkillScope).scope},scope_snapshot=${json(r.requested_scope)},version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${d.skill_id} AND version=${d.expected_version} RETURNING id`,
        );
        if (!updated.rows.length)
          throw new AppError('VERSION_CONFLICT', '发布指针已变化。');
        await tx!.execute(
          sql`UPDATE skill_versions SET status='published',version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${d.version_id}`,
        );
        await tx!.execute(
          sql`INSERT INTO skill_publications(tenant_id,id,skill_id,skill_version_id,previous_version_id,scope_snapshot,confirmation_id,action_id,published_by) VALUES(${a.tenant_id},${randomUUID()},${d.skill_id},${d.version_id},${s.published_version_id as string | null},${json(r.requested_scope)},${action.confirmation.id},${ctx.action_id},${a.user_id})`,
        );
        for (const grant of r.requested_grants as SkillGrant[])
          await tx!.execute(
            sql`INSERT INTO skill_grants(tenant_id,id,skill_id,subject_type,subject_id,action,expires_at) VALUES(${a.tenant_id},${randomUUID()},${d.skill_id},${grant.subject_type},${grant.subject_id},${grant.action},${grant.expires_at ? new Date(grant.expires_at) : null}) ON CONFLICT(tenant_id,skill_id,subject_type,subject_id,action) WHERE revoked_at IS NULL DO NOTHING`,
          );
        await audit(
          a,
          d.skill_id,
          'published',
          { action_id: ctx.action_id },
          d.version_id,
          tx!,
        );
        await tx!.execute(
          sql`INSERT INTO outbox_events(id,tenant_id,event_type,schema_version,resource_type,resource_id,resource_version,occurred_at,payload) VALUES(${randomUUID()},${a.tenant_id},'skill.published',1,'skill',${d.skill_id},${d.expected_version + 1},now(),${json({ skill_id: d.skill_id, skill_version_id: d.version_id, action_id: ctx.action_id })})`,
        );
        return {
          id: randomUUID(),
          action_id: ctx.action_id,
          idempotency_key: ctx.idempotency_key,
          outcome: 'succeeded',
          resource: {
            type: 'skill',
            id: d.skill_id,
            version: d.expected_version + 1,
          },
          external_receipt_id: null,
          occurred_at: new Date().toISOString(),
          data_mode: 'demo',
          error_code: null,
        } satisfies ActionReceipt;
      },
      async queryOutcome(ctx) {
        return {
          id: randomUUID(),
          action_id: ctx.action_id,
          idempotency_key: ctx.idempotency_key,
          outcome: 'unknown',
          resource: null,
          external_receipt_id: null,
          occurred_at: new Date().toISOString(),
          data_mode: 'demo',
          error_code: 'OUTCOME_UNKNOWN',
        };
      },
    });
  async function preparePublication(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    if (!options.actions)
      throw new AppError('INVALID_STATE', '统一动作服务尚未接入。');
    const d = z
      .strictObject({
        expected_version: z.number().int().positive(),
        version_id: z.string(),
        review_id: z.string(),
      })
      .parse(input);
    return options.actions.prepareAction(actor, {
      action: 'skill.publish',
      resource_refs: [{ type: 'skill', id, version: d.expected_version }],
      args: { skill_id: id, ...d },
      idempotency_key: key,
    });
  }
  async function stateChange(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
    state: 'enabled' | 'disabled' | 'archived',
  ) {
    const a = await fresh(actor, true),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          reason: z.string().min(1).max(1000),
        })
        .parse(input),
      s = await skillRow(a, id);
    if (
      !(await can(a, s, 'maintain')) &&
      !(
        a.roles.includes('platform_admin') &&
        a.permissions.includes('integration.manage') &&
        state === 'disabled'
      )
    )
      throw new AppError('NOT_FOUND', '能力不存在或无权维护。');
    return writeCommand(
      database,
      a,
      `skill.${state}`,
      key,
      { id, ...d },
      async (tx) => {
        if (state === 'enabled') {
          const activation = (
            await tx.execute(
              sql`SELECT active_version_id FROM skill_activations WHERE tenant_id=${a.tenant_id} AND user_id=${a.user_id} AND skill_id=${id}`,
            )
          ).rows[0];
          const v = await version(
            a,
            id,
            String(
              s.published_version_id ?? activation?.active_version_id ?? '',
            ),
            tx,
          );
          await validVersion(a, s, v, tx);
        }
        const result = await tx.execute(
          sql`UPDATE skills SET state=${state},revocation_epoch=revocation_epoch+1,archived_at=CASE WHEN ${state}='archived' THEN now() ELSE archived_at END,version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${id} AND version=${d.expected_version} RETURNING version,revocation_epoch`,
        );
        if (!result.rows[0])
          throw new AppError('VERSION_CONFLICT', '能力状态已变化。');
        await audit(a, id, state, { reason: d.reason }, null, tx);
        await tx.execute(
          sql`INSERT INTO outbox_events(id,tenant_id,event_type,schema_version,resource_type,resource_id,resource_version,occurred_at,payload) VALUES(${randomUUID()},${a.tenant_id},'skill.invalidated',1,'skill',${id},${d.expected_version + 1},now(),${json({ skill_id: id, state })})`,
        );
        return {
          id,
          state,
          version: Number(result.rows[0].version),
          revocation_epoch: Number(result.rows[0].revocation_epoch),
        };
      },
    );
  }
  async function resolve(
    actor: ActorContext,
    input: unknown,
  ): Promise<SelectionPlan> {
    const a = await fresh(actor),
      d = z
        .strictObject({
          message: z.string().max(10000),
          explicit_version_id: z.string().optional(),
          resource_refs: z.array(z.unknown()).optional(),
        })
        .parse(input);
    if (d.explicit_version_id) {
      const v = (
        await database.execute(
          sql`SELECT skill_id FROM skill_versions WHERE tenant_id=${a.tenant_id} AND id=${d.explicit_version_id}`,
        )
      ).rows[0];
      if (!v) throw new AppError('NOT_FOUND', '能力版本不可用。');
      const s = await getSkill(a, String(v.skill_id), d.explicit_version_id);
      if (!s.usable || !('version_number' in s))
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '此能力版本尚未验证或不可用。',
        );
      return {
        selection: 'selected',
        skill_id: s.id,
        skill_version_id: d.explicit_version_id,
        title: s.title,
        version_number: s.version_number!,
        selected_by: 'explicit',
        reason: '用户明确选择此能力。',
      };
    }
    const list = await listVisibleSkills(a, { limit: 100 }),
      candidates = [];
    for (const s of list.items) {
      if (!s.usable) continue;
      const detail = await getSkill(a, String(s.id));
      if (
        detail.usable &&
        'version_id' in detail &&
        (d.message.includes(String(s.title)) ||
          String(s.summary)
            .split(/[，。\s]/)
            .some((w) => w.length > 2 && d.message.includes(w)))
      )
        candidates.push({
          skill_id: String(s.id),
          skill_version_id: detail.version_id!,
          title: String(s.title),
          reason: '任务与此能力公开用途相符。',
        });
    }
    if (!candidates.length)
      return {
        selection: 'none',
        reason: '未匹配到已授权且可用的能力，可使用基础助手。',
      };
    if (candidates.length > 1)
      return {
        selection: 'clarify',
        candidates: candidates.slice(0, 3),
        question: '请选择最符合本次任务的能力。',
      };
    const c = candidates[0]!,
      v = await version(a, c.skill_id, c.skill_version_id);
    return {
      ...c,
      selection: 'selected',
      version_number: Number(v.version_number),
      selected_by: 'automatic',
    };
  }
  async function loadFrozen(
    actor: ActorContext,
    versionId: string,
    tx: DatabaseExecutor = database,
    allowHistorical = false,
  ) {
    const row = (
      await tx.execute(
        sql`SELECT skill_id FROM skill_versions WHERE tenant_id=${actor.tenant_id} AND id=${versionId}`,
      )
    ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '能力版本不可用。');
    const { actor: a, skill: s } = await requireAction(
        actor,
        String(row.skill_id),
        'use',
        tx,
      ),
      v = await version(a, String(row.skill_id), versionId, tx);
    if (s.state !== 'enabled')
      throw new AppError('REVALIDATION_REQUIRED', '能力已停用。', {
        details: { reason: 'SKILL_DISABLED' },
      });
    const activated = (
      await tx.execute(
        sql`SELECT active_version_id FROM skill_activations WHERE tenant_id=${a.tenant_id} AND user_id=${a.user_id} AND skill_id=${s.id as string}`,
      )
    ).rows[0];
    if (
      v.status !== 'published' &&
      !(
        s.owner_id === a.user_id &&
        v.status === 'validated' &&
        (allowHistorical || activated?.active_version_id === v.id)
      )
    )
      throw new AppError('REVALIDATION_REQUIRED', '此版本未发布或未激活。');
    await validVersion(a, s, v, tx);
    await checkDependencies(a, v.manifest_json as SkillManifest, true, tx);
    return frozen(s, v);
  }
  async function freezeForRun(
    actor: ActorContext,
    runId: string,
    selection: SelectionPlan,
    tx?: DatabaseExecutor,
  ) {
    const parsed = SelectionPlanSchema.parse(selection);
    if (parsed.selection !== 'selected')
      throw new AppError('VALIDATION_ERROR', '尚未选定能力。');
    const a = await fresh(actor);
    const work = async (executor: DatabaseExecutor) => {
      const f = await loadFrozen(a, parsed.skill_version_id, executor);
      if (f.skill_id !== parsed.skill_id)
        throw new AppError('VALIDATION_ERROR', '能力选择不匹配。');
      const prior = (
        await executor.execute(
          sql`SELECT * FROM skill_invocations WHERE tenant_id=${a.tenant_id} AND run_id=${runId}`,
        )
      ).rows[0];
      if (prior) {
        if (
          prior.skill_version_id !== f.skill_version_id ||
          prior.actor_id !== a.user_id
        )
          throw new AppError('INVALID_STATE', '活动任务不能更换能力或身份。');
        return f;
      }
      await executor.execute(
        sql`INSERT INTO skill_invocations(tenant_id,run_id,actor_id,skill_version_id,content_hash,selected_by,selection_reason,scope_snapshot,revocation_epoch,status) VALUES(${a.tenant_id},${runId},${a.user_id},${f.skill_version_id},${f.content_hash},${parsed.selected_by},${parsed.reason},${json(f.manifest.scope_policy)},${f.revocation_epoch},'active')`,
      );
      await audit(
        a,
        f.skill_id,
        'frozen',
        { run_id: runId },
        f.skill_version_id,
        executor,
      );
      return f;
    };
    return tx ? work(tx) : database.transaction(work);
  }
  /** 仅服务端订阅校验端口；复用use授权与版本验证，不赋予source_read或返回源码。 */
  async function validateForSubscription(
    actor: ActorContext,
    versionId: string,
  ) {
    const current = await fresh(actor),
      skill = await loadFrozen(current, versionId);
    const tools = await Promise.all(
      skill.manifest.tools.map(async (tool) => ({
        effect: (await capability(current, tool.capability_version_id)).effect,
      })),
    );
    if (tools.some((tool) => tool.effect !== 'read'))
      throw new AppError(
        'FORBIDDEN',
        '后台摘要只能使用全部为只读能力的 Skill。',
      );
    return { tools };
  }
  async function assertUsable(ctx: ExecutionContext, frozenSkill: FrozenSkill) {
    const a = await fresh(ctx.actor),
      current = await loadFrozen(
        a,
        frozenSkill.skill_version_id,
        database,
        true,
      );
    if (
      current.content_hash !== frozenSkill.content_hash ||
      current.revocation_epoch !== frozenSkill.revocation_epoch
    )
      throw new AppError('REVALIDATION_REQUIRED', '能力授权或版本状态已变化。');
    if (ctx.selected_skill_version_id !== frozenSkill.skill_version_id)
      throw new AppError('FORBIDDEN', '运行能力不匹配。');
  }
  async function resolveSkillCapabilities(ctx: ExecutionContext) {
    if (!ctx.selected_skill_version_id) return [];
    const invocation = (
      await database.execute(
        sql`SELECT * FROM skill_invocations WHERE tenant_id=${ctx.actor.tenant_id} AND actor_id=${ctx.actor.user_id} AND run_id=${ctx.run_id} AND skill_version_id=${ctx.selected_skill_version_id}`,
      )
    ).rows[0];
    if (!invocation) throw new AppError('FORBIDDEN', '运行没有冻结此能力。');
    const f = await loadFrozen(
      ctx.actor,
      ctx.selected_skill_version_id,
      database,
      true,
    );
    await assertUsable(ctx, {
      ...f,
      content_hash: String(invocation.content_hash),
      revocation_epoch: Number(invocation.revocation_epoch),
    });
    return f.capability_versions;
  }
  async function getFrozenForRun(
    actor: ActorContext,
    runId: string,
  ): Promise<FrozenSkill | null> {
    const a = await fresh(actor),
      invocation = (
        await database.execute(
          sql`SELECT * FROM skill_invocations WHERE tenant_id=${a.tenant_id} AND actor_id=${a.user_id} AND run_id=${runId}`,
        )
      ).rows[0];
    if (!invocation) return null;
    const current = await loadFrozen(
      a,
      String(invocation.skill_version_id),
      database,
      true,
    );
    if (
      current.content_hash !== invocation.content_hash ||
      current.revocation_epoch !== Number(invocation.revocation_epoch)
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '固定能力的内容或授权版本已变化。',
      );
    return {
      ...current,
      content_hash: String(invocation.content_hash),
      revocation_epoch: Number(invocation.revocation_epoch),
    };
  }
  async function assertActionAllowed(ctx: ExecutionContext, operation: string) {
    await resolveSkillCapabilities(ctx);
    const f = await loadFrozen(
      ctx.actor,
      ctx.selected_skill_version_id!,
      database,
      true,
    );
    if (!f.manifest.allowed_action_operations.includes(operation as never))
      throw new AppError('FORBIDDEN', '所选能力不允许此业务操作。');
  }
  async function assertDependencyRefs(
    actor: ActorContext,
    refs: DependencyRef[],
    tx?: DatabaseExecutor,
  ) {
    for (const dep of refs)
      if (dep.type === 'skill') {
        const f = await loadFrozen(actor, dep.id, tx ?? database, true);
        if (String(dep.version) !== String(f.version_number))
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '确认绑定的能力版本已失效。',
          );
      }
  }
  async function patchGrants(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    const { actor: a } = await requireAction(actor, id, 'maintain'),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          add: z.array(SkillGrantSchema).max(100).default([]),
          remove: z.array(z.string().min(1)).max(100).default([]),
        })
        .parse(input);
    if (d.add.length)
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '新增共享授权必须重新审查并通过统一发布确认。',
      );
    return writeCommand(
      database,
      a,
      'skill.grants.revoke',
      key,
      { id, ...d },
      async (tx) => {
        const result = await tx.execute(
          sql`UPDATE skills SET version=version+1,revocation_epoch=revocation_epoch+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${id} AND version=${d.expected_version} RETURNING revocation_epoch`,
        );
        if (!result.rows.length)
          throw new AppError('VERSION_CONFLICT', '授权版本已变化。');
        await tx.execute(
          sql`UPDATE skill_grants SET revoked_at=now(),version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND skill_id=${id} AND id IN(SELECT jsonb_array_elements_text(${json(d.remove)})) AND revoked_at IS NULL`,
        );
        await audit(a, id, 'grants_revoked', { grant_ids: d.remove }, null, tx);
        return {
          id,
          version: d.expected_version + 1,
          revocation_epoch: Number(result.rows[0]!.revocation_epoch),
        };
      },
    );
  }
  async function listInvocations(actor: ActorContext, id: string) {
    const a = await fresh(actor),
      s = await skillRow(a, id),
      author = await can(a, s, 'maintain');
    if (!author && !(await can(a, s, 'use')))
      throw new AppError('NOT_FOUND', '能力不可访问。');
    return (
      await database.execute(
        sql`SELECT i.run_id,i.skill_version_id,i.selected_by,i.selection_reason,i.status,i.created_at FROM skill_invocations i JOIN skill_versions v ON v.tenant_id=i.tenant_id AND v.id=i.skill_version_id WHERE i.tenant_id=${a.tenant_id} AND v.skill_id=${id} ${author ? sql`` : sql`AND i.actor_id=${a.user_id}`} ORDER BY i.created_at DESC LIMIT 100`,
      )
    ).rows;
  }
  async function listReviewTasks(actor: ActorContext) {
    const a = await fresh(actor);
    return {
      items: (
        await database.execute(
          sql`SELECT r.id AS review_id,r.skill_version_id,r.status,r.version,r.requested_scope,r.reviewed_hash,s.id AS skill_id,s.title,s.summary FROM skill_reviews r JOIN skill_versions v ON v.tenant_id=r.tenant_id AND v.id=r.skill_version_id JOIN skills s ON s.tenant_id=v.tenant_id AND s.id=v.skill_id WHERE r.tenant_id=${a.tenant_id} AND r.reviewer_id=${a.user_id} AND r.status='review_pending' ORDER BY r.created_at,r.id`,
        )
      ).rows,
    };
  }
  async function seedBuiltinSkills(
    tenantId: string,
    input: {
      owner_id: string;
      reviewer_id: string;
      finance_group_id: string;
      private_owner_id?: string;
    },
  ) {
    const specs: [string, string, string[], string[]][] = [
      [
        'skill-preaudit',
        '待办预审',
        [
          'finance.todo.list',
          'finance.document.get',
          'finance.preaudit.start',
          'finance.preaudit.get',
          'finance.action.prepare',
          'finance.action.status',
        ],
        ['approval.approve', 'approval.return', 'approval.batch_approve'],
      ],
      [
        'skill-rules',
        '规则助手',
        [
          'finance.rules.propose',
          'finance.rules.test',
          'finance.knowledge.search',
          'finance.action.prepare',
          'finance.action.status',
        ],
        ['rule.enable', 'rule.publish'],
      ],
      [
        'skill-travel',
        '差旅填单',
        [
          'finance.document.get',
          'finance.travel.propose_patch',
          'finance.knowledge.search',
          'finance.action.prepare',
          'finance.action.status',
        ],
        ['travel.submit', 'travel.resubmit', 'travel.withdraw'],
      ],
      [
        'skill-analytics',
        '费用分析',
        [
          'finance.analytics.query',
          'finance.report.create',
          'finance.action.status',
        ],
        [],
      ],
      ['skill-knowledge', '制度问答', ['finance.knowledge.search'], []],
      [
        'skill-finance-private',
        '财务专用分析',
        ['finance.analytics.query'],
        [],
      ],
    ];
    await database.transaction(async (tx) => {
      for (const [id, title, tools, operations] of specs) {
        const shape = {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: { type: 'string', minLength: 1, maxLength: 2000 },
            },
            required: ['question'],
          },
          output = {
            type: 'object',
            additionalProperties: false,
            properties: {
              answer: { type: 'string', maxLength: 4000 },
              evidence_refs: {
                type: 'array',
                maxItems: 20,
                items: { type: 'string', maxLength: 200 },
              },
            },
            required: ['answer', 'evidence_refs'],
          };
        const manifest: SkillManifest = {
          manifest_schema_version: 1,
          title,
          summary: `${title}：使用已授权业务工具处理任务，所有写入仍需本人确认。`,
          intent_examples: [`使用${title}`],
          input_schema: shape,
          output_schema: output,
          tools: tools.map((name) => ({
            // 新种子显式固定到已发布契约；既有Skill版本仍由下方ON CONFLICT保留原内容。
            capability_version_id: `${name}@${name === 'finance.action.status' ? '1.1.0' : '1.0.0'}`,
            required: true,
          })),
          scope_policy: {
            preset:
              id === 'skill-travel'
                ? 'self'
                : id === 'skill-knowledge'
                  ? 'self'
                  : 'authorized_departments',
          },
          allowed_action_operations:
            operations as SkillManifest['allowed_action_operations'],
          output_card_types: [
            id === 'skill-analytics'
              ? 'analysis_result'
              : id === 'skill-knowledge'
                ? 'policy_answer'
                : 'skill_result',
          ],
          examples: [
            {
              name: '合成成功基准',
              input: { question: `使用${title}` },
              expected: {
                answer: '基于真实工具结果生成说明。',
                evidence_refs: [],
              },
              expected_tool_names: tools.slice(0, 1),
              expectation: 'success',
            },
            {
              name: '缺字段澄清',
              input: { question: '请帮我处理' },
              expected: {
                answer: '请补充本次任务对象和范围。',
                evidence_refs: [],
              },
              expected_tool_names: [],
              expectation: 'clarify',
            },
            {
              name: '越权拒绝',
              input: { question: '读取未授权部门' },
              expected: { answer: '当前范围没有此项授权。', evidence_refs: [] },
              expected_tool_names: [],
              expectation: 'deny',
            },
          ],
        };
        const markdown = sections
          .map(
            (section) =>
              `## ${section}\n${section === '禁止事项' ? '不得执行代码、扩大权限、自动确认或编造工具事实。' : section === '适用范围' ? '仅使用当前用户实时业务授权。' : section === '需要询问的情况' ? '任务对象、日期或范围不明确时先澄清。' : section === '工作步骤' ? '读取最新业务对象，使用登记工具，将写入意图交统一确认。' : section === '输出要求' ? '数据结论附来源，未知项明确说明。' : `协助用户完成${title}。`}`,
          )
          .join('\n\n');
        staticContent(manifest, markdown);
        const versionId = `${id}-v1`,
          validationId = `${id}-synthetic-validation`,
          hash = hashPayload({ manifest, markdown }),
          isPrivate = id === 'skill-finance-private',
          scope = isPrivate ? 'group' : 'tenant',
          ownerId = isPrivate
            ? (input.private_owner_id ?? input.owner_id)
            : input.owner_id;
        await tx.execute(
          sql`INSERT INTO skills(tenant_id,id,owner_id,slug,title,summary,scope,scope_snapshot) VALUES(${tenantId},${id},${ownerId},${id},${title},${manifest.summary},${scope},${json(scope === 'group' ? { scope, group_ids: [input.finance_group_id] } : { scope })}) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO skill_versions(tenant_id,id,skill_id,version_number,manifest_json,markdown,content_hash,status,validation_id) VALUES(${tenantId},${versionId},${id},1,${json(manifest)},${markdown},${hash},'draft',${validationId}) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO skill_validation_runs(tenant_id,id,skill_version_id,content_hash,validator_version,profile_version,capability_snapshot,status,checks,error_code,synthetic) VALUES(${tenantId},${validationId},${versionId},${hash},${validatorVersion},${profile},${json(manifest.tools.map((t) => t.capability_version_id))},'blocked',${json(
            [
              {
                name: 'synthetic_manifest',
                status: 'passed',
                message: '合成基准，未替代真实模型验证。',
              },
              {
                name: 'model',
                status: 'blocked',
                message: '等待真实受控试运行。',
              },
            ],
          )},'DEPENDENCY_UNAVAILABLE',true) ON CONFLICT DO NOTHING`,
        );
        if (!isPrivate)
          await tx.execute(
            sql`INSERT INTO skill_reviews(tenant_id,id,skill_version_id,author_id,requested_scope,requested_grants,reviewer_id,status,decision_reason,reviewed_hash) VALUES(${tenantId},${`${id}-synthetic-review`},${versionId},${ownerId},${json({ scope })},${json([{ subject_type: 'tenant', subject_id: tenantId, action: 'use' }])},${input.reviewer_id},'review_pending','合成基准，等待独立审查与真实模型验证。',${hash}) ON CONFLICT DO NOTHING`,
          );
        await tx.execute(
          sql`INSERT INTO skill_grants(tenant_id,id,skill_id,subject_type,subject_id,action) VALUES(${tenantId},${`${id}-use-grant`},${id},${scope === 'group' ? 'group' : 'tenant'},${scope === 'group' ? input.finance_group_id : tenantId},'use') ON CONFLICT DO NOTHING`,
        );
      }
    });
  }
  return {
    listVisibleSkills,
    getSkill,
    getSkillSource,
    createSkill,
    saveVersion,
    validateVersion,
    processValidationJob,
    getValidation,
    activatePersonalVersion,
    requestReview,
    decideReview,
    preparePublication,
    disable: (a: ActorContext, id: string, input: unknown, key: string) =>
      stateChange(a, id, input, key, 'disabled'),
    enable: (a: ActorContext, id: string, input: unknown, key: string) =>
      stateChange(a, id, input, key, 'enabled'),
    archive: (a: ActorContext, id: string, input: unknown, key: string) =>
      stateChange(a, id, input, key, 'archived'),
    resolve,
    freezeForRun,
    validateForSubscription,
    assertUsable,
    resolveSkillCapabilities,
    getFrozenForRun,
    assertActionAllowed,
    assertDependencyRefs,
    patchGrants,
    listInvocations,
    listReviewTasks,
    seedBuiltinSkills,
  };
}
export type SkillService = ReturnType<typeof createSkillService>;
