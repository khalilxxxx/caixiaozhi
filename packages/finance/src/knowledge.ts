import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import {
  KnowledgeSearchSchema,
  GroundedAnswerModelSchema,
  PolicyDraftSchema,
  PolicyCitationSchema,
  type KnowledgeSearch,
  type PolicyDraftInput,
  type PolicyCitation,
  type PolicyView,
  type RetrievalSnapshot,
} from '@caixiaozhi/contracts/knowledge';
import type {
  DatabaseConnection,
  DatabaseExecutor,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { FinanceOptions } from './ports.js';
import type { DurableJob } from '@caixiaozhi/jobs/queue';
import { canonicalHash } from './hash.js';
import {
  assertDomainLease,
  bump,
  command,
  date,
  iso,
  json,
  outbox,
  revision,
  rows,
} from './database.js';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const absent = () => new AppError('NOT_FOUND', '请求的制度资源不存在。');
export const POLICY_PARSER_VERSION = 'text-md-v1';
export const NORMALIZATION_VERSION = 'utf8-nfc-lf-v1';
export function chineseTokens(text: string): string[] {
  const expanded = text
    .replace(/宾馆|住店|酒店/g, '住宿')
    .replace(/每晚/g, '间夜');
  const result = new Set<string>();
  for (const group of expanded.match(/[\p{Script=Han}]+|[A-Za-z0-9]+/gu) ??
    []) {
    const chars = Array.from(group);
    if (/\p{Script=Han}/u.test(group)) {
      if (chars.length === 1) result.add(group);
      for (let i = 0; i < chars.length - 1; i++)
        result.add(chars[i]! + chars[i + 1]!);
    } else result.add(group.toLowerCase());
  }
  return [...result].slice(0, 80);
}
export function parsePolicy(bytes: Uint8Array) {
  let original: string;
  try {
    original = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new AppError('VALIDATION_ERROR', '制度文件必须为UTF-8文本。', {
      details: { reason: 'INVALID_ENCODING' },
    });
  }
  if (original.includes('\0') || !original.trim())
    throw new AppError('VALIDATION_ERROR', '制度文件为空或含二进制内容。');
  const raw = original.replace(/^\uFEFF/, '');
  const normalized = raw.replace(/\r\n?/g, '\n').normalize('NFC');
  if (Array.from(normalized).length > 2_000_000)
    throw new AppError('VALIDATION_ERROR', '制度文本超过字符上限。');
  const offset_map: Array<{
    normalized_start_utf16: number;
    original_start_utf16: number;
    line: number;
  }> = [];
  let a = 0,
    b = original.startsWith('\uFEFF') ? 1 : 0;
  for (const [index, line] of raw.split(/\r\n|\r|\n/).entries()) {
    offset_map.push({
      normalized_start_utf16: a,
      original_start_utf16: b,
      line: index + 1,
    });
    a += line.normalize('NFC').length + 1;
    b +=
      line.length +
      (original.slice(b + line.length, b + line.length + 2) === '\r\n' ? 2 : 1);
  }
  return {
    normalized_text: normalized,
    original_hash: createHash('sha256').update(bytes).digest('hex'),
    offset_map,
    normalization_version: NORMALIZATION_VERSION,
  };
}
export function chunkPolicy(text: string) {
  const chunks: Array<{
    text: string;
    heading_path: string[];
    start_line: number;
    end_line: number;
    source_start_utf16: number;
    content_hash: string;
  }> = [];
  let heading: string[] = [];
  let buffer = '';
  let start = 0;
  let lineStart = 1;
  let currentLine = 1;
  let offset = 0;
  const flush = () => {
    if (buffer.trim())
      chunks.push({
        text: buffer,
        heading_path: heading.length ? [...heading] : ['正文'],
        start_line: lineStart,
        end_line: currentLine,
        source_start_utf16: start,
        content_hash: sha(buffer),
      });
    buffer = '';
  };
  for (const line of text.split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (match) {
      flush();
      heading = heading.slice(0, match[1]!.length - 1);
      heading[match[1]!.length - 1] = match[2]!;
    }
    for (const part of line.match(/[\s\S]{1,1000}/gu) ?? ['']) {
      if (buffer.length + part.length > 1200) flush();
      if (!buffer) {
        start = offset;
        lineStart = currentLine;
      }
      buffer += part;
      offset += part.length;
    }
    buffer += '\n';
    offset++;
    if (buffer.length >= 600) flush();
    currentLine++;
  }
  flush();
  return chunks;
}
export class KnowledgeService {
  constructor(
    readonly database: DatabaseConnection,
    readonly options: FinanceOptions,
  ) {
    options.files?.registerParentAuthorizer(
      'policy',
      async (ctx, ref, access) => {
        if (!access?.write) return this.assertPolicyRead(ctx, ref);
        const [version] = await rows<{
          policy_id: string;
          organization_ids: string[];
        }>(
          this.database.db,
          sql`SELECT policy_id,organization_ids FROM policy_versions WHERE tenant_id=${ctx.tenant_id} AND policy_id=${ref.id} AND version_no=${ref.version}`,
        );
        if (!version) throw absent();
        await this.assertMaintain(
          ctx,
          version.policy_id,
          version.organization_ids,
        );
      },
    );
  }
  async organizationScope(ctx: ActorContext): Promise<string[]> {
    const current = await this.options.identity.requireCurrentActor(ctx);
    const me = await this.options.identity.getMe(current);
    return current.roles.includes('employee')
      ? [...new Set([me.department_id, ...current.department_ids])]
      : [];
  }
  async assertPolicyRead(
    ctx: ActorContext,
    ref: ResourceRef,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<void> {
    const orgs = await this.organizationScope(ctx);
    const found = await rows<any>(
      tx,
      sql`SELECT v.*,p.owner_id FROM policy_versions v JOIN policies p ON p.tenant_id=v.tenant_id AND p.id=v.policy_id WHERE v.tenant_id=${ctx.tenant_id} AND v.policy_id=${ref.id} AND v.version_no=${ref.version}`,
    );
    const row = found[0];
    if (!row || row.publication_state === 'withdrawn') throw absent();
    if (row.publication_state === 'draft') {
      await this.assertMaintain(ctx, ref.id, row.organization_ids);
      return;
    }
    if (!row.organization_ids.some((id: string) => orgs.includes(id)))
      throw absent();
  }
  async assertMaintain(
    ctx: ActorContext,
    policyId: string,
    orgIds: string[],
  ): Promise<void> {
    const current = await this.options.identity.requireCurrentActor(ctx);
    await this.options.identity.assertPermission(current, 'knowledge.manage');
    if (current.invocation_origin !== 'interactive')
      throw new AppError('FORBIDDEN', '后台身份不能维护制度。');
    const grants = (await this.options.identity.listMyGrants(current)).filter(
      (g) => g.capability === 'knowledge.manage',
    );
    if (
      !grants.some(
        (g) =>
          (g.scope_type === 'named_resource' &&
            g.scope_ids.includes(policyId)) ||
          (g.scope_type === 'department' &&
            orgIds.every((id) => g.scope_ids.includes(id))),
      )
    )
      throw new AppError('FORBIDDEN', '制度不在当前维护授权范围内。');
  }
  async createPolicyDraft(
    ctx: ActorContext,
    input: PolicyDraftInput,
    key: string,
  ) {
    const parsed = PolicyDraftSchema.parse(input);
    await this.assertMaintain(ctx, parsed.policy_id, parsed.organization_ids);
    if (!this.options.files)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '私有文件服务未配置。');
    const { file, bytes } = await this.options.files.readFile(
      ctx,
      parsed.source_file_id,
    );
    if (file.profile !== 'policy-text-v1')
      throw new AppError('VALIDATION_ERROR', '请选择完成校验的制度文本文件。');
    const source = parsePolicy(bytes);
    const organizations = await this.options.identity.listDepartments(ctx, {
      limit: 100,
    });
    if (
      parsed.organization_ids.some(
        (id) => !organizations.items.some((o) => o.id === id),
      )
    )
      throw new AppError(
        'VALIDATION_ERROR',
        '制度适用部门必须来自当前组织目录。',
      );
    const generation = (await this.options.identity.getMe(ctx)).generation;
    return command(
      this.database,
      ctx,
      'policy.draft',
      key,
      parsed,
      async (tx) => {
        const existing = await rows<any>(
          tx,
          sql`SELECT * FROM policies WHERE tenant_id=${ctx.tenant_id} AND id=${parsed.policy_id} FOR UPDATE`,
        );
        if (!existing[0])
          await tx.execute(
            sql`INSERT INTO policies(tenant_id,id,policy_code,title,owner_id) VALUES(${ctx.tenant_id},${parsed.policy_id},${parsed.policy_code},${parsed.title},${ctx.user_id})`,
          );
        else if (existing[0].policy_code !== parsed.policy_code)
          throw new AppError('VALIDATION_ERROR', '制度代码与现有制度不一致。');
        const max = await rows<{ n: number }>(
          tx,
          sql`SELECT coalesce(max(version_no),0)::int AS n FROM policy_versions WHERE tenant_id=${ctx.tenant_id} AND policy_id=${parsed.policy_id}`,
        );
        const versionId = randomUUID(),
          importId = randomUUID();
        await tx.execute(
          sql`INSERT INTO policy_versions(tenant_id,id,policy_id,version_no,publication_state,source_file_id,content_hash,parser_version,normalization_version,normalized_text,offset_map,organization_ids,effective_from,effective_to,topic_tags,supersedes_version_id) VALUES(${ctx.tenant_id},${versionId},${parsed.policy_id},${max[0]!.n + 1},'draft',${file.id},${source.original_hash},${POLICY_PARSER_VERSION},${NORMALIZATION_VERSION},${source.normalized_text},${json(source.offset_map)}::jsonb,${json(parsed.organization_ids)}::jsonb,${parsed.effective_from}::date,${parsed.effective_to}::date,${json(parsed.topic_tags)}::jsonb,${parsed.supersedes_version_id})`,
        );
        await tx.execute(
          sql`INSERT INTO policy_imports(tenant_id,id,owner_id,version_id,file_hash,stage,parser_version) VALUES(${ctx.tenant_id},${importId},${ctx.user_id},${versionId},${source.original_hash},'parsing',${POLICY_PARSER_VERSION})`,
        );
        if (this.options.jobs) {
          const job = await this.options.jobs.enqueueInTransaction(tx, {
            tenant_id: ctx.tenant_id,
            owner_module: 'knowledge',
            kind: 'knowledge.import',
            payload_ref: importId,
            dedupe_key: `${versionId}:${source.original_hash}`,
            generation,
          });
          await tx.execute(
            sql`UPDATE policy_imports SET job_id=${job.id} WHERE tenant_id=${ctx.tenant_id} AND id=${importId}`,
          );
        }
        return {
          policy_id: parsed.policy_id,
          version_id: versionId,
          version_no: max[0]!.n + 1,
          import_id: importId,
          stage: 'parsing',
        };
      },
    );
  }
  async processImport(
    tenantId: string,
    importId: string,
    job?: DurableJob,
  ): Promise<void> {
    if (job) await assertDomainLease(this.database.db, job);
    const imports = await rows<any>(
      this.database.db,
      sql`SELECT i.*,v.normalized_text FROM policy_imports i JOIN policy_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id WHERE i.tenant_id=${tenantId} AND i.id=${importId}`,
    );
    const record = imports[0];
    if (!record || record.stage === 'ready') return;
    const chunks = chunkPolicy(record.normalized_text);
    if (!chunks.length)
      throw new AppError('VALIDATION_ERROR', '制度没有可解析文本。');
    await this.database.db.transaction(async (tx) => {
      if (job) await assertDomainLease(tx, job);
      await tx.execute(
        sql`SELECT id FROM policy_imports WHERE tenant_id=${tenantId} AND id=${importId} FOR UPDATE`,
      );
      const latest = await rows<{ stage: string }>(
        tx,
        sql`SELECT stage FROM policy_imports WHERE tenant_id=${tenantId} AND id=${importId}`,
      );
      if (latest[0]?.stage === 'ready') return;
      for (const [ordinal, chunk] of chunks.entries())
        await tx.execute(
          sql`INSERT INTO policy_chunks(tenant_id,id,version_id,ordinal,heading_path,text,start_line,end_line,source_start_utf16,content_hash,search_vector) VALUES(${tenantId},${randomUUID()},${record.version_id},${ordinal},${json(chunk.heading_path)}::jsonb,${chunk.text},${chunk.start_line},${chunk.end_line},${chunk.source_start_utf16},${chunk.content_hash},to_tsvector('simple',${chineseTokens(chunk.text).join(' ')})) ON CONFLICT(tenant_id,version_id,ordinal) DO NOTHING`,
        );
      await tx.execute(
        sql`UPDATE policy_versions SET parse_complete=true,updated_at=now() WHERE tenant_id=${tenantId} AND id=${record.version_id}`,
      );
      await tx.execute(
        sql`UPDATE policy_imports SET stage='ready',version=version+1,updated_at=now() WHERE tenant_id=${tenantId} AND id=${importId}`,
      );
    });
  }
  async getImport(ctx: ActorContext, id: string) {
    await this.options.identity.requireCurrentActor(ctx);
    const result = await rows<any>(
      this.database.db,
      sql`SELECT i.*,v.policy_id,v.organization_ids FROM policy_imports i JOIN policy_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id WHERE i.tenant_id=${ctx.tenant_id} AND i.id=${id}`,
    );
    const row = result[0];
    if (!row) throw absent();
    await this.assertMaintain(ctx, row.policy_id, row.organization_ids);
    return {
      id: row.id,
      version: row.version,
      policy_id: row.policy_id,
      version_id: row.version_id,
      stage: row.stage,
      job_id: row.job_id,
      origin_run_id: row.origin_run_id,
      warnings: row.warnings,
      error_location: row.error_location,
    };
  }
  async listPolicies(
    ctx: ActorContext,
  ): Promise<{ items: PolicyView[]; next_cursor: null }> {
    const orgs = await this.organizationScope(ctx);
    const grants = await this.options.identity.listMyGrants(ctx);
    const manageIds = grants
      .filter(
        (g) =>
          g.capability === 'knowledge.manage' &&
          g.scope_type === 'named_resource',
      )
      .flatMap((g) => g.scope_ids);
    const result = await rows<any>(
      this.database.db,
      sql`SELECT p.*,v.id AS version_id,v.version_no,v.version AS version_version,v.publication_state,v.source_file_id,v.content_hash,v.organization_ids,v.effective_from,v.effective_to,v.parse_complete,i.id AS import_id,i.stage AS import_stage FROM policies p JOIN policy_versions v ON v.tenant_id=p.tenant_id AND v.policy_id=p.id LEFT JOIN policy_imports i ON i.tenant_id=v.tenant_id AND i.version_id=v.id WHERE p.tenant_id=${ctx.tenant_id} AND ((v.publication_state='published' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.organization_ids) o WHERE o=ANY(${sql.param(orgs)}::text[]))) OR p.id=ANY(${sql.param(manageIds)}::text[])) ORDER BY p.id,v.version_no`,
    );
    const grouped = new Map<string, PolicyView>();
    for (const row of result) {
      let policy = grouped.get(row.id);
      if (!policy) {
        policy = {
          id: row.id,
          policy_code: row.policy_code,
          title: row.title,
          owner_id: row.owner_id,
          version: row.version,
          versions: [],
        };
        grouped.set(row.id, policy);
      }
      policy.versions.push({
        id: row.version_id,
        version_no: row.version_no,
        version: row.version_version,
        publication_state: row.publication_state,
        source_file_id: row.source_file_id,
        content_hash: row.content_hash,
        organization_ids: row.organization_ids,
        effective_from: date(row.effective_from),
        effective_to: row.effective_to ? date(row.effective_to) : null,
        parse_complete: row.parse_complete,
        import_id: row.import_id,
        import_stage: row.import_stage,
      });
    }
    return { items: [...grouped.values()], next_cursor: null };
  }
  async publishPolicy(
    ctx: ActorContext,
    input: {
      policy_id: string;
      version_id: string;
      expected_version: number;
      withdraw?: boolean;
    },
    tx: DatabaseExecutor = this.database.db,
  ) {
    const result = await rows<any>(
      tx,
      sql`SELECT * FROM policy_versions WHERE tenant_id=${ctx.tenant_id} AND id=${input.version_id} AND policy_id=${input.policy_id} FOR UPDATE`,
    );
    const row = result[0];
    if (!row) throw absent();
    await this.assertMaintain(ctx, row.policy_id, row.organization_ids);
    if (row.version !== input.expected_version)
      throw new AppError('VERSION_CONFLICT', '制度版本已更新，请刷新。');
    if (input.withdraw) {
      if (row.publication_state !== 'published')
        throw new AppError('INVALID_STATE', '只有已发布版本可以撤回。');
    } else {
      if (row.publication_state !== 'draft' || !row.parse_complete)
        throw new AppError('INVALID_STATE', '制度尚未解析完成或已发布。');
      const overlap = await rows<any>(
        tx,
        sql`SELECT id,effective_from,effective_to FROM policy_versions WHERE tenant_id=${ctx.tenant_id} AND policy_id=${row.policy_id} AND publication_state='published' AND daterange(effective_from,effective_to,'[)') && daterange(${date(row.effective_from)}::date,${row.effective_to ? date(row.effective_to) : null}::date,'[)') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(organization_ids) o WHERE o=ANY(${sql.param(row.organization_ids)}::text[])) FOR UPDATE`,
      );
      if (overlap.some((v: any) => v.id !== row.supersedes_version_id))
        throw new AppError(
          'INVALID_STATE',
          '同制度适用区间重叠，请明确替代关系。',
          { details: { reason: 'POLICY_CONFLICT' } },
        );
      if (row.supersedes_version_id)
        await tx.execute(
          sql`UPDATE policy_versions SET effective_to=${date(row.effective_from)}::date WHERE tenant_id=${ctx.tenant_id} AND id=${row.supersedes_version_id} AND effective_from<${date(row.effective_from)}::date`,
        );
    }
    await tx.execute(
      sql`UPDATE policy_versions SET publication_state=${input.withdraw ? 'withdrawn' : 'published'},version=version+1,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${row.id}`,
    );
    const ref = {
      type: 'policy' as const,
      id: row.policy_id,
      version: row.version_no,
    };
    await tx.execute(
      sql`UPDATE policies SET version=version+1,latest_published_ref=${json(ref)}::jsonb,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${row.policy_id}`,
    );
    const corpus = await bump(tx, ctx.tenant_id, 'corpus');
    await outbox(
      tx,
      ctx,
      'policy.version_changed',
      'policy',
      row.policy_id,
      row.version_no,
      {
        policy_ref: ref,
        state: input.withdraw ? 'withdrawn' : 'published',
        corpus_revision: corpus,
      },
    );
    return {
      policy_ref: ref,
      publication_state: input.withdraw ? 'withdrawn' : 'published',
      corpus_revision: corpus,
    };
  }
  private async citation(
    ctx: ActorContext,
    row: any,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<PolicyCitation> {
    const id = canonicalHash({
      tenant: ctx.tenant_id,
      chunk: row.id,
      quote: row.text,
    });
    const locator = {
      kind: 'text_lines' as const,
      source_file_id: row.source_file_id,
      normalization_version: row.normalization_version,
      source_start_utf16: row.source_start_utf16,
      start_line: row.start_line,
      end_line: row.end_line,
    };
    await tx.execute(
      sql`INSERT INTO policy_citations(tenant_id,id,version_id,chunk_id,quote,start_utf16,end_utf16,quote_hash,locator) VALUES(${ctx.tenant_id},${id},${row.version_id},${row.id},${row.text},0,${row.text.length},${sha(row.text)},${json(locator)}::jsonb) ON CONFLICT DO NOTHING`,
    );
    return PolicyCitationSchema.parse({
      citation_id: id,
      policy_ref: {
        type: 'policy',
        id: row.policy_id,
        version: row.version_no,
      },
      chunk_id: row.id,
      heading_path: row.heading_path,
      quote: row.text,
      start_utf16: 0,
      end_utf16: row.text.length,
      quote_hash: sha(row.text),
      locator,
      effective_from: date(row.effective_from),
      effective_to: row.effective_to ? date(row.effective_to) : null,
      organization_label: '当前授权组织',
    });
  }
  async searchAuthorized(
    ctx: ActorContext,
    input: KnowledgeSearch,
  ): Promise<RetrievalSnapshot> {
    const query = KnowledgeSearchSchema.parse(input),
      current = await this.options.identity.requireCurrentActor(ctx),
      orgs = await this.organizationScope(current);
    const tokens = chineseTokens(query.query);
    const tsquery = tokens.map((t) => `'${t.replace(/'/g, '')}'`).join(' | ');
    const result =
      orgs.length && tokens.length
        ? await rows<any>(
            this.database.db,
            sql`WITH authorized_versions AS (SELECT * FROM policy_versions WHERE tenant_id=${ctx.tenant_id} AND publication_state='published' AND parse_complete AND effective_from<=${query.business_date}::date AND (effective_to IS NULL OR effective_to>${query.business_date}::date) AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(organization_ids) o WHERE o=ANY(${sql.param(orgs)}::text[]))) SELECT c.*,v.policy_id,v.id AS version_id,v.version_no,v.source_file_id,v.normalization_version,v.effective_from,v.effective_to,ts_rank_cd(c.search_vector,to_tsquery('simple',${tsquery})) AS rank FROM authorized_versions v JOIN policy_chunks c ON c.tenant_id=v.tenant_id AND c.version_id=v.id WHERE c.search_vector@@to_tsquery('simple',${tsquery}) ORDER BY rank DESC,v.policy_id,v.version_no,c.ordinal LIMIT ${query.top_k}`,
          )
        : [];
    const hits: PolicyCitation[] = [];
    for (const row of result) hits.push(await this.citation(current, row));
    const conflicts: Array<{
      topic_key: string;
      citation_ids: string[];
      message: string;
    }> = [];
    if (hits.length) {
      const assertions = await rows<any>(
        this.database.db,
        sql`SELECT a.* FROM policy_assertions a JOIN policy_versions v ON v.tenant_id=a.tenant_id AND v.id=a.version_id WHERE a.tenant_id=${ctx.tenant_id} AND a.status='confirmed' AND v.publication_state='published' AND v.effective_from<=${query.business_date}::date AND (v.effective_to IS NULL OR v.effective_to>${query.business_date}::date) AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.organization_ids) o WHERE o=ANY(${sql.param(orgs)}::text[]))`,
      );
      const grouped = new Map<string, any[]>();
      for (const a of assertions) {
        const list = grouped.get(a.topic_key) ?? [];
        list.push(a);
        grouped.set(a.topic_key, list);
      }
      for (const [topic, list] of grouped)
        if (
          new Set(list.map((a) => `${a.unit}:${a.normalized_value}`)).size > 1
        )
          conflicts.push({
            topic_key: topic,
            citation_ids: hits
              .filter((h) => list.some((a) => a.chunk_id === h.chunk_id))
              .map((h) => h.citation_id),
            message: '适用制度存在已确认的标准冲突，请提交澄清。',
          });
    }
    const corpus = await revision(this.database.db, ctx.tenant_id, 'corpus'),
      id = randomUUID();
    await this.options.identity.requireCurrentActor(current);
    await this.database.db.execute(
      sql`INSERT INTO knowledge_retrieval_snapshots(tenant_id,id,owner_id,authz_version,query,business_date,context_json,scope_hash,corpus_revision,hits,conflicts) VALUES(${ctx.tenant_id},${id},${ctx.user_id},${ctx.authz_version},${query.query},${query.business_date}::date,${json(query.context ?? {})}::jsonb,${canonicalHash(orgs)},${corpus},${json(hits)}::jsonb,${json(conflicts)}::jsonb)`,
    );
    return {
      retrieval_snapshot_id: id,
      business_date: query.business_date,
      hits,
      conflicts,
      corpus_revision: corpus,
    };
  }
  async getCitation(
    ctx: ActorContext,
    id: string,
  ): Promise<PolicyCitation & { context: string; publication_state: string }> {
    const found = await rows<any>(
      this.database.db,
      sql`SELECT q.*,c.text,c.heading_path,c.source_start_utf16,c.start_line,c.end_line,v.policy_id,v.version_no,v.source_file_id,v.normalization_version,v.effective_from,v.effective_to,v.publication_state FROM policy_citations q JOIN policy_chunks c ON c.tenant_id=q.tenant_id AND c.id=q.chunk_id JOIN policy_versions v ON v.tenant_id=q.tenant_id AND v.id=q.version_id WHERE q.tenant_id=${ctx.tenant_id} AND q.id=${id}`,
    );
    const row = found[0];
    if (!row) throw absent();
    await this.assertPolicyRead(ctx, {
      type: 'policy',
      id: row.policy_id,
      version: row.version_no,
    });
    if (
      row.text.slice(row.start_utf16, row.end_utf16) !== row.quote ||
      sha(row.quote) !== row.quote_hash
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '来源内容校验失败，请重新检索。',
        { details: { reason: 'SOURCE_CHANGED' } },
      );
    return {
      ...PolicyCitationSchema.parse({
        citation_id: row.id,
        policy_ref: {
          type: 'policy',
          id: row.policy_id,
          version: row.version_no,
        },
        chunk_id: row.chunk_id,
        heading_path: row.heading_path,
        quote: row.quote,
        start_utf16: row.start_utf16,
        end_utf16: row.end_utf16,
        quote_hash: row.quote_hash,
        locator: row.locator,
        effective_from: date(row.effective_from),
        effective_to: row.effective_to ? date(row.effective_to) : null,
        organization_label: '当前授权组织',
      }),
      context: row.text,
      publication_state: row.publication_state,
    };
  }
  async question(
    ctx: ActorContext,
    input: KnowledgeSearch,
    originRunId: string | null,
    key: string,
  ) {
    if (!originRunId)
      throw new AppError('INVALID_STATE', '问答记录必须关联当前已有对话任务。');
    const current = await this.options.identity.requireCurrentActor(ctx);
    const parsed = KnowledgeSearchSchema.parse(input);
    if (this.options.authorizeOriginRun)
      await this.options.authorizeOriginRun(current, originRunId);
    else {
      const run = await rows(
        this.database.db,
        sql`SELECT id FROM agent_runs WHERE tenant_id=${ctx.tenant_id} AND owner_id=${ctx.user_id} AND id=${originRunId}`,
      );
      if (!run[0]) throw absent();
    }
    return command(
      this.database,
      ctx,
      'knowledge.question',
      key,
      { input: parsed, originRunId },
      async (tx) => {
        const snapshot = await this.searchAuthorized(current, parsed);
        let state = 'no_evidence',
          modelVersion: string | null = null;
        let blocks: Array<{
          text: string;
          citation_ids: string[];
          kind: 'source_excerpt' | 'policy_fact';
        }> = snapshot.hits.map((hit) => ({
          text: hit.quote,
          citation_ids: [hit.citation_id],
          kind: 'source_excerpt',
        }));
        if (snapshot.conflicts.length) state = 'conflict';
        else if (snapshot.hits.length) {
          state = 'degraded';
          if (
            this.options.answerKnowledge &&
            this.options.knowledgeModelVersion
          ) {
            try {
              await this.options.identity.requireCurrentActor(current);
              const rawModel = await this.options.answerKnowledge(current, {
                query: parsed.query,
                snapshot,
              });
              const model = GroundedAnswerModelSchema.parse({
                blocks: rawModel.blocks,
              });
              for (const block of model.blocks) {
                const sources = block.citation_ids.map((id) =>
                  snapshot.hits.find((hit) => hit.citation_id === id),
                );
                if (sources.some((source) => !source))
                  throw new AppError(
                    'VALIDATION_ERROR',
                    '模型引用不属于本次授权检索。',
                  );
                const evidence = sources
                  .map(
                    (source) =>
                      `${source!.quote} ${source!.effective_from} ${source!.effective_to ?? ''}`,
                  )
                  .join('\n');
                const sourceNumbers = new Set(
                  evidence.match(/\d+(?:\.\d+)?/g) ?? [],
                );
                if (
                  (block.text.match(/\d+(?:\.\d+)?/g) ?? []).some(
                    (value) => !sourceNumbers.has(value),
                  )
                )
                  throw new AppError(
                    'VALIDATION_ERROR',
                    '模型给出了无法由来源核对的数值。',
                  );
                for (const term of [
                  '每人',
                  '每天',
                  '人天',
                  '人/天',
                  '元/人',
                  '元/天',
                  '批准例外',
                  '自动批准',
                  '可以报销',
                  '无需审核',
                ])
                  if (block.text.includes(term) && !evidence.includes(term))
                    throw new AppError(
                      'VALIDATION_ERROR',
                      '模型的单位或例外条件缺少来源。',
                    );
                for (const source of sources) {
                  const live = await this.getCitation(
                    current,
                    source!.citation_id,
                  );
                  if (
                    live.effective_from > parsed.business_date ||
                    (live.effective_to &&
                      live.effective_to <= parsed.business_date)
                  )
                    throw new AppError(
                      'REVALIDATION_REQUIRED',
                      '制度适用版本已变化，请重新检索。',
                    );
                }
              }
              blocks = model.blocks.map((block) => ({
                ...block,
                kind: 'policy_fact',
              }));
              modelVersion = this.options.knowledgeModelVersion;
              state = 'answered';
            } catch (error) {
              if (
                error instanceof AppError &&
                [
                  'UNAUTHENTICATED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'REVALIDATION_REQUIRED',
                ].includes(error.code)
              )
                throw error;
              state = 'degraded';
            }
          }
        }
        await this.options.identity.requireCurrentActor(current);
        const citationIds = [
          ...new Set(blocks.flatMap((block) => block.citation_ids)),
        ];
        for (const citationId of citationIds)
          await this.getCitation(current, citationId);
        const id = randomUUID();
        await tx.execute(
          sql`INSERT INTO knowledge_questions(tenant_id,id,owner_id,origin_run_id,query,business_date,context_json,answer_state,answer_blocks,citation_ids,snapshot_id,model_version) VALUES(${ctx.tenant_id},${id},${ctx.user_id},${originRunId},${parsed.query},${parsed.business_date}::date,${json(parsed.context ?? {})}::jsonb,${state},${json(blocks)}::jsonb,${json(citationIds)}::jsonb,${snapshot.retrieval_snapshot_id},${modelVersion})`,
        );
        return {
          question_id: id,
          answer_state: state,
          answer_blocks: blocks,
          citation_ids: citationIds,
          model_version: modelVersion,
          message:
            state === 'answered'
              ? '答案已按本次授权来源校验。'
              : state === 'conflict'
                ? '适用制度存在冲突，不能据此确定唯一标准。'
                : state === 'no_evidence'
                  ? '当前授权及条件下未找到依据。'
                  : '以下为已授权来源摘录，未使用模型生成结论。',
        };
      },
    );
  }
  async getQuestion(ctx: ActorContext, id: string) {
    await this.options.identity.requireCurrentActor(ctx);
    const found = await rows<any>(
      this.database.db,
      sql`SELECT * FROM knowledge_questions WHERE tenant_id=${ctx.tenant_id} AND owner_id=${ctx.user_id} AND id=${id}`,
    );
    const row = found[0];
    if (!row) throw absent();
    for (const citationId of row.citation_ids)
      await this.getCitation(ctx, citationId);
    return {
      question_id: row.id,
      query: row.query,
      business_date: date(row.business_date),
      answer_state: row.answer_state,
      answer_blocks: row.answer_blocks,
      citation_ids: row.citation_ids,
      retrieval_snapshot_id: row.snapshot_id,
      model_version: row.model_version,
    };
  }
  async addFeedback(
    ctx: ActorContext,
    input: {
      answer_id: string;
      kind: 'helpful' | 'incorrect' | 'outdated' | 'missing_context';
      comment?: string;
      citation_id?: string;
    },
    key: string,
  ) {
    const answer = await this.getQuestion(ctx, input.answer_id);
    if (input.citation_id && !answer.citation_ids.includes(input.citation_id))
      throw new AppError('VALIDATION_ERROR', '反馈引用不属于当前答案。');
    return command(
      this.database,
      ctx,
      'knowledge.feedback',
      key,
      input,
      async (tx) => {
        const id = randomUUID();
        await tx.execute(
          sql`INSERT INTO knowledge_feedback(tenant_id,id,owner_id,answer_id,kind,comment,citation_id) VALUES(${ctx.tenant_id},${id},${ctx.user_id},${input.answer_id},${input.kind},${input.comment ?? null},${input.citation_id ?? null})`,
        );
        return { feedback_id: id, saved: true };
      },
    );
  }
  async addClarification(
    ctx: ActorContext,
    input: { question_id: string; reason: string; comment?: string },
    key: string,
  ) {
    await this.getQuestion(ctx, input.question_id);
    return command(
      this.database,
      ctx,
      'knowledge.clarification',
      key,
      input,
      async (tx) => {
        const id = randomUUID();
        await tx.execute(
          sql`INSERT INTO knowledge_clarifications(tenant_id,id,owner_id,question_id,reason,comment,status) VALUES(${ctx.tenant_id},${id},${ctx.user_id},${input.question_id},${input.reason},${input.comment ?? null},'open')`,
        );
        return {
          clarification_id: id,
          status: 'open',
          message: '澄清已保存，尚未向他人发送通知。',
        };
      },
    );
  }
}
