import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import {
  MappingDraftSchema,
  MappingSaveSchema,
  MappingTestSchema,
  MappingPublishArgsSchema,
  type MappingDraft,
  type MappingPublishArgs,
} from '@caixiaozhi/contracts/mappings';
import {
  SrsInputSnapshotSchema,
  type SrsInputSnapshot,
} from '@caixiaozhi/contracts/rules';
import type {
  DatabaseConnection,
  DatabaseExecutor,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { FinanceOptions } from './ports.js';
import {
  command,
  rows,
  json,
  revision,
  bump,
  outbox,
  iso,
} from './database.js';
import { canonicalHash } from './hash.js';
import {
  normalize,
  validateMappingConfig,
  expandMappingFields,
  readNormalizedField,
  providerDocumentFromSnapshot,
  type MappingVersion,
} from './mappings.js';

const missing = () =>
  new AppError('NOT_FOUND', '字段映射不存在或不在当前管理范围内。');
const stale = () =>
  new AppError(
    'REVALIDATION_REQUIRED',
    '映射草稿、授权、样例证明或现行映射已变化，请重新验证。',
  );
const liveProvider = (source: {
  provider: string;
  source_schema_version: string;
  module?: string;
}) =>
  source.provider === 'demo-expenses' &&
  source.source_schema_version === 'expense-v1' &&
  (!source.module || source.module === 'expense_claim');
export class MappingService {
  constructor(
    readonly database: DatabaseConnection,
    readonly identity: FinanceOptions['identity'],
  ) {}
  private async manage(ctx: ActorContext, departments: string[]) {
    const current = await this.identity.requireCurrentActor(ctx);
    await this.identity.assertPermission(current, 'rule.manage.company');
    if (current.invocation_origin !== 'interactive')
      throw new AppError('FORBIDDEN', '字段映射只能由本人交互维护。');
    const scope = await this.identity.getResourceScope(
      current,
      'rule.manage.company',
    );
    if (
      !departments.length ||
      departments.some((id) => !scope.department_ids.includes(id))
    )
      throw new AppError('FORBIDDEN', '字段映射组织超出当前管理授权范围。');
    return current;
  }
  private parse(input: unknown): MappingDraft {
    const parsed = MappingDraftSchema.parse(input);
    return {
      ...parsed,
      department_ids: [...new Set(parsed.department_ids)].sort(),
      mapping_json: validateMappingConfig(parsed.mapping_json),
    };
  }
  private async definition(
    ctx: ActorContext,
    id: string,
    tx: DatabaseExecutor,
    lock = false,
  ) {
    const definition = (
      await rows<any>(
        tx,
        lock
          ? sql`SELECT * FROM field_mapping_definitions WHERE tenant_id=${ctx.tenant_id} AND id=${id} FOR UPDATE`
          : sql`SELECT * FROM field_mapping_definitions WHERE tenant_id=${ctx.tenant_id} AND id=${id}`,
      )
    )[0];
    if (!definition) throw missing();
    const active = definition.current_version_id
      ? (
          await rows<any>(
            tx,
            sql`SELECT department_ids FROM field_mapping_drafts WHERE tenant_id=${ctx.tenant_id} AND mapping_id=${id} AND id=${definition.current_version_id}`,
          )
        )[0]
      : null;
    try {
      await this.manage(ctx, [
        ...new Set<string>([
          ...definition.department_ids,
          ...(active?.department_ids ?? []),
        ]),
      ]);
    } catch (error) {
      if (error instanceof AppError && error.code === 'FORBIDDEN')
        throw missing();
      throw error;
    }
    return definition;
  }
  async get(
    ctx: ActorContext,
    id: string,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<any> {
    const current = await this.identity.requireCurrentActor(ctx),
      definition = await this.definition(current, id, tx);
    const versions = await rows<any>(
      tx,
      sql`SELECT d.*,v.confirmed_by FROM field_mapping_drafts d LEFT JOIN field_mapping_versions v ON v.tenant_id=d.tenant_id AND v.id=d.id WHERE d.tenant_id=${current.tenant_id} AND d.mapping_id=${id} ORDER BY d.version_number`,
    );
    const scope = await this.identity.getResourceScope(
      current,
      'rule.manage.company',
    );
    return {
      id,
      name: definition.name,
      version: definition.version,
      department_ids: definition.department_ids,
      provider: definition.provider,
      source_schema_version: definition.source_schema_version,
      module: definition.module,
      runtime_binding: liveProvider(definition) ? 'live_demo' : 'sample_only',
      active_version_id: definition.current_version_id,
      draft_version_id: definition.draft_version_id,
      versions: versions
        .filter((v) =>
          v.department_ids.every((department: string) =>
            scope.department_ids.includes(department),
          ),
        )
        .map((v) => ({
          id: v.id,
          version_number: v.version_number,
          name: v.name,
          department_ids: v.department_ids,
          mapping_json: v.mapping_json,
          content_hash: v.content_hash,
          mapping_content_hash: canonicalHash(v.mapping_json),
          publication_state: v.confirmed_by ? 'published' : 'draft',
          created_by: v.created_by,
          created_at: iso(v.created_at),
        })),
      created_at: iso(definition.created_at),
      updated_at: iso(definition.updated_at),
    };
  }
  async list(ctx: ActorContext) {
    const current = await this.identity.requireCurrentActor(ctx);
    if (
      !current.permissions.includes('rule.manage.company') ||
      current.invocation_origin !== 'interactive'
    )
      return { items: [], next_cursor: null };
    const ids = await rows<{ id: string }>(
        this.database.db,
        sql`SELECT id FROM field_mapping_definitions WHERE tenant_id=${current.tenant_id} ORDER BY id`,
      ),
      items = [];
    for (const row of ids)
      try {
        items.push(await this.get(current, row.id));
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND')
          throw error;
      }
    return { items, next_cursor: null };
  }
  private async insertDraft(
    tx: DatabaseExecutor,
    ctx: ActorContext,
    id: string,
    number: number,
    input: MappingDraft,
  ) {
    const draftId = `fmv-${randomUUID()}`,
      hash = canonicalHash(input);
    await tx.execute(
      sql`INSERT INTO field_mapping_drafts(tenant_id,id,mapping_id,version_number,name,department_ids,mapping_json,content_hash,created_by) VALUES(${ctx.tenant_id},${draftId},${id},${number},${input.name},${json(input.department_ids)}::jsonb,${json(input.mapping_json)}::jsonb,${hash},${ctx.user_id})`,
    );
    return draftId;
  }
  async createDraft(ctx: ActorContext, input: unknown, key: string) {
    const parsed = this.parse(input),
      current = await this.manage(ctx, parsed.department_ids);
    return command(
      this.database,
      current,
      'mapping.create',
      key,
      parsed,
      async (tx) => {
        const existing = await rows(
          tx,
          sql`SELECT id FROM field_mapping_definitions WHERE tenant_id=${current.tenant_id} AND provider=${parsed.mapping_json.provider} AND source_schema_version=${parsed.mapping_json.source_schema_version} AND module=${parsed.mapping_json.module}`,
        );
        if (existing.length)
          throw new AppError(
            'VERSION_CONFLICT',
            '该提供方、来源版本与模块已有映射，请维护已有草稿。',
          );
        const id = `mapping-${randomUUID()}`;
        await tx.execute(
          sql`INSERT INTO field_mapping_definitions(tenant_id,id,owner_id,name,department_ids,provider,source_schema_version,module) VALUES(${current.tenant_id},${id},${current.user_id},${parsed.name},${json(parsed.department_ids)}::jsonb,${parsed.mapping_json.provider},${parsed.mapping_json.source_schema_version},${parsed.mapping_json.module})`,
        );
        const draft = await this.insertDraft(tx, current, id, 1, parsed);
        await tx.execute(
          sql`UPDATE field_mapping_definitions SET draft_version_id=${draft} WHERE tenant_id=${current.tenant_id} AND id=${id}`,
        );
        return this.get(current, id, tx);
      },
    );
  }
  async saveDraft(ctx: ActorContext, id: string, input: unknown, key: string) {
    const request = MappingSaveSchema.parse(input),
      { expected_version, ...fields } = request,
      parsed = this.parse(fields),
      current = await this.manage(ctx, parsed.department_ids);
    await this.definition(current, id, this.database.db);
    return command(
      this.database,
      current,
      'mapping.save',
      key,
      { id, ...request },
      async (tx) => {
        const definition = await this.definition(current, id, tx, true);
        if (definition.version !== expected_version)
          throw new AppError('VERSION_CONFLICT', '映射草稿已更新，请刷新。');
        if (
          definition.provider !== parsed.mapping_json.provider ||
          definition.source_schema_version !==
            parsed.mapping_json.source_schema_version ||
          definition.module !== parsed.mapping_json.module
        )
          throw new AppError(
            'VALIDATION_ERROR',
            '已有映射不能改变提供方、来源版本或模块。',
          );
        const latest = (
          await rows<{ n: number }>(
            tx,
            sql`SELECT max(version_number)::int AS n FROM field_mapping_drafts WHERE tenant_id=${current.tenant_id} AND mapping_id=${id}`,
          )
        )[0]!.n;
        const draft = await this.insertDraft(
          tx,
          current,
          id,
          latest + 1,
          parsed,
        );
        await tx.execute(
          sql`UPDATE field_mapping_definitions SET name=${parsed.name},department_ids=${json(parsed.department_ids)}::jsonb,draft_version_id=${draft},version=version+1,updated_at=now() WHERE tenant_id=${current.tenant_id} AND id=${id} AND version=${expected_version}`,
        );
        return this.get(current, id, tx);
      },
    );
  }
  private async target(
    ctx: ActorContext,
    id: string,
    expected: number,
    tx: DatabaseExecutor,
    lock = false,
  ) {
    const definition = await this.definition(ctx, id, tx, lock);
    if (definition.version !== expected)
      throw new AppError('VERSION_CONFLICT', '映射草稿已更新，请刷新。');
    const draft = (
      await rows<any>(
        tx,
        sql`SELECT * FROM field_mapping_drafts WHERE tenant_id=${ctx.tenant_id} AND mapping_id=${id} AND id=${definition.draft_version_id}`,
      )
    )[0];
    if (!draft) throw new AppError('INVALID_STATE', '没有待验证的映射草稿。');
    const parsed = this.parse({
      name: draft.name,
      department_ids: draft.department_ids,
      mapping_json: draft.mapping_json,
    });
    if (canonicalHash(parsed) !== draft.content_hash) throw stale();
    return { definition, draft, parsed };
  }
  private async snapshot(ctx: ActorContext, tx: DatabaseExecutor) {
    const mapping_revision = await revision(tx, ctx.tenant_id, 'mapping', true);
    const versions = await rows(
      tx,
      sql`SELECT id,version_number,content_hash FROM field_mapping_versions WHERE tenant_id=${ctx.tenant_id} ORDER BY id`,
    );
    return {
      mapping_revision,
      mapping_snapshot_hash: canonicalHash({
        field_catalog_version: 1,
        versions,
      }),
    };
  }
  async testDraft(ctx: ActorContext, id: string, input: unknown, key: string) {
    const request = MappingTestSchema.parse(input),
      current = await this.identity.requireCurrentActor(ctx);
    await this.target(current, id, request.expected_version, this.database.db);
    return command(
      this.database,
      current,
      'mapping.test',
      key,
      { id, ...request },
      async (tx) => {
        const { definition, draft, parsed } = await this.target(
            current,
            id,
            request.expected_version,
            tx,
          ),
          snapshot = await this.snapshot(current, tx);
        const mapping: MappingVersion = {
          id: draft.id,
          mapping_id: id,
          version_number: draft.version_number,
          confirmed_by: current.user_id,
          content_hash: canonicalHash(parsed.mapping_json),
          mapping_json: parsed.mapping_json,
        };
        if (
          new Set(request.cases.map((c) => c.name)).size !==
          request.cases.length
        )
          throw new AppError('VALIDATION_ERROR', '样例名称不能重复。');
        const results = request.cases.map((c) => {
          if (
            !parsed.department_ids.includes(
              c.source.snapshot.input.department_id,
            )
          )
            throw new AppError('FORBIDDEN', '样例组织不在映射管理范围内。');
          const result = normalize(c.source, mapping),
            fields = expandMappingFields(c.source, parsed.mapping_json.fields)
              .map((f) => f.target_field)
              .sort();
          const expectedPaths = c.expected.map((e) => e.target_field).sort();
          if (
            new Set(expectedPaths).size !== expectedPaths.length ||
            canonicalHash(fields) !== canonicalHash(expectedPaths)
          )
            throw new AppError(
              'VALIDATION_ERROR',
              '人工预期必须恰好覆盖本样例展开后的全部配置目标。',
            );
          const checks = c.expected.map((expected) => {
            const actual = readNormalizedField(
              result.input,
              expected.target_field,
            );
            return {
              ...expected,
              actual,
              passed:
                actual.state === expected.state &&
                (!['known', 'missing'].includes(actual.state) ||
                  canonicalHash(actual.value) ===
                    canonicalHash(expected.value)),
            };
          });
          return {
            name: c.name,
            passed: checks.every((check) => check.passed),
            checks,
            normalized: result,
            source_hash: canonicalHash(c.source),
            result_hash: canonicalHash(result.input),
          };
        });
        const idRun = `mapping-test-${randomUUID()}`,
          passed = results.every((r) => r.passed),
          test_set_hash = canonicalHash(request.cases);
        await tx.execute(
          sql`INSERT INTO field_mapping_sample_runs(tenant_id,id,mapping_id,owner_id,authz_version,definition_version,draft_id,draft_hash,base_current_version_id,mapping_revision,mapping_snapshot_hash,cases_json,test_set_hash,results,passed) VALUES(${current.tenant_id},${idRun},${id},${current.user_id},${current.authz_version},${definition.version},${draft.id},${draft.content_hash},${definition.current_version_id},${snapshot.mapping_revision},${snapshot.mapping_snapshot_hash},${json(request.cases)}::jsonb,${test_set_hash},${json(results)}::jsonb,${passed})`,
        );
        return {
          test_run_id: idRun,
          mapping_id: id,
          draft_id: draft.id,
          draft_hash: draft.content_hash,
          test_set_hash,
          passed,
          results,
          ...snapshot,
        };
      },
    );
  }
  async preparePublish(
    ctx: ActorContext,
    input: unknown,
    tx: DatabaseExecutor = this.database.db,
  ) {
    const args = MappingPublishArgsSchema.parse(input),
      current = await this.identity.requireCurrentActor(ctx);
    const { definition, draft, parsed } = await this.target(
        current,
        args.mapping_id,
        args.expected_version,
        tx,
      ),
      snapshot = await this.snapshot(current, tx);
    const proof = (
      await rows<any>(
        tx,
        sql`SELECT * FROM field_mapping_sample_runs WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND mapping_id=${args.mapping_id} AND id=${args.test_run_id} AND passed`,
      )
    )[0];
    if (
      args.draft_id !== draft.id ||
      args.draft_hash !== draft.content_hash ||
      !proof ||
      proof.authz_version !== current.authz_version ||
      proof.definition_version !== definition.version ||
      proof.draft_id !== draft.id ||
      proof.draft_hash !== draft.content_hash ||
      proof.base_current_version_id !== definition.current_version_id ||
      proof.mapping_revision !== snapshot.mapping_revision ||
      proof.mapping_snapshot_hash !== snapshot.mapping_snapshot_hash ||
      canonicalHash(proof.cases_json) !== proof.test_set_hash
    )
      throw stale();
    const extra_guards = {
      mapping_id: args.mapping_id,
      definition_version: definition.version,
      draft_id: draft.id,
      draft_hash: draft.content_hash,
      base_current_version_id: definition.current_version_id,
      test_run_id: proof.id,
      test_set_hash: proof.test_set_hash,
      authz_version: current.authz_version,
      field_catalog_version: 1,
      ...snapshot,
    };
    return {
      summary: {
        title: '发布字段映射',
        mapping_name: parsed.name,
        provider: parsed.mapping_json.provider,
        module: parsed.mapping_json.module,
        department_ids: parsed.department_ids,
        draft_hash: draft.content_hash,
        test_run_id: proof.id,
        impact: liveProvider(parsed.mapping_json)
          ? '后续授权单据按此版本归一化；旧预审和规则测试证明将失效。'
          : '来源尚未注册业务适配器；当前仅保存人工样例验证的配置，不改变现行业务输入。',
        runtime_binding: liveProvider(parsed.mapping_json)
          ? 'live_demo'
          : 'sample_only',
      },
      args,
      extra_guards,
      items: [{ resource_ref: null, args }],
    };
  }
  async publish(
    ctx: ActorContext,
    input: MappingPublishArgs,
    tx?: DatabaseExecutor,
  ): Promise<{
    mapping_id: string;
    version_id: string;
    version_number: number;
    revision: number;
  }> {
    if (!tx)
      return this.database.db.transaction((executor) =>
        this.publish(ctx, input, executor),
      );
    const args = MappingPublishArgsSchema.parse(input),
      current = await this.identity.requireCurrentActor(ctx);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${current.tenant_id}:mapping-publish`},0))`,
    );
    const { definition, draft, parsed } = await this.target(
      current,
      args.mapping_id,
      args.expected_version,
      tx,
      true,
    );
    await this.preparePublish(current, args, tx);
    await tx.execute(
      sql`INSERT INTO field_mapping_versions(tenant_id,id,mapping_id,version_number,mapping_json,content_hash,confirmed_by) VALUES(${current.tenant_id},${draft.id},${definition.id},${draft.version_number},${json(parsed.mapping_json)}::jsonb,${canonicalHash(parsed.mapping_json)},${current.user_id})`,
    );
    const updated = await tx.execute(
      sql`UPDATE field_mapping_definitions SET current_version_id=${draft.id},draft_version_id=NULL,version=version+1,updated_at=now() WHERE tenant_id=${current.tenant_id} AND id=${definition.id} AND version=${args.expected_version} AND draft_version_id=${args.draft_id}`,
    );
    if (updated.rowCount !== 1)
      throw new AppError('VERSION_CONFLICT', '映射已更新，未发布本次版本。');
    const next = await bump(tx, current.tenant_id, 'mapping');
    await outbox(
      tx,
      current,
      'mapping.changed',
      'mapping',
      definition.id,
      draft.version_number,
      {
        mapping_version_id: draft.id,
        department_ids: parsed.department_ids,
        revision: next,
      },
    );
    return {
      mapping_id: definition.id,
      version_id: draft.id,
      version_number: draft.version_number,
      revision: next,
    };
  }
  async normalizeSnapshot(
    ctx: ActorContext,
    snapshot: SrsInputSnapshot,
    source: { provider: string; source_schema_version: string },
    tx: DatabaseExecutor = this.database.db,
  ): Promise<SrsInputSnapshot> {
    const current = await this.identity.requireCurrentActor(ctx),
      checked = SrsInputSnapshotSchema.parse(snapshot);
    if (canonicalHash(checked.input) !== checked.provenance.input_hash)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '来源快照校验失败。');
    if (!liveProvider({ ...source, module: checked.input.document.type }))
      return checked;
    const selected = (
      await rows<any>(
        tx,
        sql`SELECT v.*,d.current_version_id,active.department_ids AS active_department_ids FROM field_mapping_definitions d LEFT JOIN field_mapping_versions v ON v.tenant_id=d.tenant_id AND v.id=d.current_version_id LEFT JOIN field_mapping_drafts active ON active.tenant_id=d.tenant_id AND active.mapping_id=d.id AND active.id=d.current_version_id WHERE d.tenant_id=${current.tenant_id} AND d.provider=${source.provider} AND d.source_schema_version=${source.source_schema_version} AND d.module=${checked.input.document.type}`,
      )
    )[0];
    if (!selected?.current_version_id) return checked;
    if (!selected.id || !Array.isArray(selected.active_department_ids))
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '已发布映射缺少可信版本，不能回退为现行输入已知。',
      );
    if (!selected.active_department_ids.includes(checked.input.department_id))
      return checked;
    validateMappingConfig(selected.mapping_json);
    return normalize(
      providerDocumentFromSnapshot(
        checked,
        source.provider,
        source.source_schema_version,
      ),
      {
        id: selected.id,
        mapping_id: selected.mapping_id,
        version_number: selected.version_number,
        confirmed_by: selected.confirmed_by,
        content_hash: selected.content_hash,
        mapping_json: selected.mapping_json,
      },
    );
  }
}
