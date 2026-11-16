import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  ActorContextSchema,
  type ActorContext,
  type Role,
} from '@caixiaozhi/contracts/common';
import {
  PermissionSchema,
  type Permission,
} from '@caixiaozhi/contracts/permissions';
import {
  GrantSchema,
  MeSchema,
  PersonCandidateSchema,
  DepartmentSchema,
  AuthorizationGroupSchema,
  CostCenterSchema,
  ProjectSchema,
  PlaceResolutionSchema,
  type Grant,
  type Me,
  type PersonCandidate,
  type Department,
  type AuthorizationGroup,
  type CostCenter,
  type Project,
  type PlaceResolution,
} from '@caixiaozhi/contracts/identity';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  DEMO_IDENTITIES,
  DEMO_DEPARTMENTS,
  DEMO_GROUPS,
  DEMO_SEED_VERSION,
  createDemoGrantManifest,
} from './fixtures.js';
import type {
  ActorOrigin,
  AuthorizationRef,
  DemoEnvironmentInput,
  DemoGrantChange,
  DirectoryProvider,
  IdentityProvider,
  Page,
  PageInput,
  PeopleQuery,
  ResourceMetadata,
  ResourceResolver,
  ResourceScope,
} from './ports.js';

export type IdentityOptions = {
  sessionSecret: string;
  appMode: 'demo' | 'test' | 'production';
  demoAccessEnabled: boolean;
  identityProvider?: IdentityProvider;
  sessionKeys?: Record<string, string>;
  activeSigningKeyId?: string;
};
export type SessionView = {
  session_token: string;
  csrf_token: string;
  me: Me;
  expires_at: string;
  cache_invalidated: true;
};
type Queryable = Pick<PoolClient, 'query'>;
type IdentityRow = {
  id: string;
  tenant_id: string;
  display_name: string;
  department_id: string;
  department_name: string;
  state: string;
  authz_version: number;
  generation: number;
};
type SessionRow = {
  id: string;
  tenant_id: string;
  actor_id: string;
  generation: number;
  csrf_hash: string;
  expires_at: Date;
  signature_key_id: string;
};
const READ_ONLY_SUBSCRIPTION_PERMISSIONS = new Set<Permission>([
  'travel.read.own',
  'expense.read.own',
  'oa.read.own',
  'travel.read.department',
  'expense.read.department',
  'oa.read.department',
  'analytics.query',
  'skill.use',
]);
const hash = (input: string) =>
  createHash('sha256').update(input).digest('hex');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const unique = (values: string[]) => [...new Set(values)].sort();
const unauthenticated = () =>
  new AppError('UNAUTHENTICATED', '会话已失效，请重新登录。');
const missing = () => new AppError('NOT_FOUND', '请求的资源不存在。');
const forbidden = () =>
  new AppError('FORBIDDEN', '当前身份没有执行此操作的权限。');

export class IdentityService implements DirectoryProvider {
  private readonly resolvers = new Map<string, ResourceResolver>();
  private readonly sessionKeys: Record<string, string>;
  private readonly activeKeyId: string;
  readonly options: IdentityOptions;
  constructor(
    readonly database: DatabaseConnection,
    options: IdentityOptions,
  ) {
    this.options = options;
    if (options.sessionSecret.length < 32)
      throw new Error('SESSION_SECRET 至少需要 32 个字符。');
    this.sessionKeys = options.sessionKeys ?? {
      primary: options.sessionSecret,
    };
    this.activeKeyId = options.activeSigningKeyId ?? 'primary';
    if (
      !this.sessionKeys[this.activeKeyId] ||
      Object.entries(this.sessionKeys).some(
        ([id, secret]) =>
          !/^[A-Za-z0-9_-]{1,40}$/.test(id) || secret.length < 32,
      )
    )
      throw new Error('会话签名密钥与当前 key_id 配置无效。');
    if (options.appMode === 'production' && options.demoAccessEnabled)
      throw new Error('生产环境禁止启用演示认证。');
    if (
      options.appMode === 'production' &&
      (!options.identityProvider?.ready || !options.identityProvider.issuer)
    )
      throw new Error('生产身份提供方未就绪，应用拒绝启动。');
  }

  private assertDemo() {
    if (this.options.appMode !== 'demo' || !this.options.demoAccessEnabled)
      throw missing();
  }
  private sign(value: string, keyId = this.activeKeyId) {
    const key = this.sessionKeys[keyId];
    if (!key) throw unauthenticated();
    return createHmac('sha256', key).update(value).digest('base64url');
  }
  private csrfForSession(id: string, keyId = this.activeKeyId) {
    return this.sign(`csrf.v1.${id}`, keyId);
  }
  private tokenForSession(id: string, keyId = this.activeKeyId) {
    const unsigned = `v1.${keyId}.${this.sign(`session.v1.${id}`, keyId)}`;
    return `${unsigned}.${this.sign(unsigned, keyId)}`;
  }
  private verifyToken(token: string) {
    const parts = token.split('.');
    if (
      parts.length !== 4 ||
      parts[0] !== 'v1' ||
      !this.sessionKeys[parts[1] ?? ''] ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? '')
    )
      throw unauthenticated();
    const unsigned = parts.slice(0, 3).join('.');
    if (!equal(this.sign(unsigned, parts[1]), parts[3] ?? ''))
      throw unauthenticated();
    return hash(token);
  }
  private async transact<T>(run: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.database.pool.connect();
    try {
      await tx.query('BEGIN');
      const result = await run(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
  }
  private async loadIdentity(
    tenantId: string,
    userId: string,
    tx: Queryable = this.database.pool,
  ): Promise<IdentityRow> {
    const result = await tx.query<IdentityRow>(
      `SELECT i.*,o.name AS department_name,e.generation FROM identities i JOIN organizations o ON o.tenant_id=i.tenant_id AND o.id=i.department_id JOIN identity_environments e ON e.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND i.id=$2 AND i.state='active' AND o.state='active'`,
      [tenantId, userId],
    );
    if (!result.rows[0]) throw unauthenticated();
    return result.rows[0];
  }
  private async grants(
    tenantId: string,
    userId: string,
    tx: Queryable = this.database.pool,
  ): Promise<Grant[]> {
    const result = await tx.query(
      'SELECT capability,scope_type,scope_ids,effect FROM grants WHERE tenant_id=$1 AND subject_id=$2 ORDER BY id',
      [tenantId, userId],
    );
    return z.array(GrantSchema).parse(result.rows);
  }
  private async sessionById(tenantId: string, id: string): Promise<SessionRow> {
    const result = await this.database.pool.query<SessionRow>(
      `SELECT s.* FROM identity_sessions s JOIN identity_environments e ON e.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2 AND s.generation=e.generation AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'`,
      [tenantId, id],
    );
    if (!result.rows[0]) throw unauthenticated();
    return result.rows[0];
  }
  async getActor(sessionToken: string): Promise<ActorContext> {
    const tokenHash = this.verifyToken(sessionToken);
    const result = await this.database.pool.query<SessionRow>(
      `UPDATE identity_sessions s SET last_seen_at=now(),updated_at=now() FROM identity_environments e,identities i WHERE s.token_hash=$1 AND e.tenant_id=s.tenant_id AND i.tenant_id=s.tenant_id AND i.id=s.actor_id AND i.state='active' AND e.generation=s.generation AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' RETURNING s.*`,
      [tokenHash],
    );
    const session = result.rows[0];
    if (!session) throw unauthenticated();
    return this.getCurrentActor(session.tenant_id, session.actor_id, {
      sessionId: session.id,
      invocationOrigin: 'interactive',
    });
  }
  async getCurrentActor(
    tenantId: string,
    userId: string,
    origin: ActorOrigin,
  ): Promise<ActorContext> {
    const person = await this.loadIdentity(tenantId, userId);
    let grants = await this.grants(tenantId, userId);
    if (origin.invocationOrigin === 'interactive') {
      const session = await this.sessionById(tenantId, origin.sessionId);
      if (session.actor_id !== userId) throw unauthenticated();
    } else {
      const result = await this.database.pool.query(
        `SELECT * FROM subscription_delegations WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 AND state='active' AND generation=$4`,
        [tenantId, origin.delegationId, userId, person.generation],
      );
      const delegation = result.rows[0];
      if (!delegation) throw forbidden();
      const allowed = z
        .array(PermissionSchema)
        .parse(delegation.allowed_capabilities);
      const scoped = z.array(GrantSchema).parse(delegation.scope);
      grants = grants.flatMap((grant) => {
        if (
          !READ_ONLY_SUBSCRIPTION_PERMISSIONS.has(grant.capability) ||
          !allowed.includes(grant.capability)
        )
          return [];
        const ids = grant.scope_ids.filter((id) =>
          scoped.some(
            (d) =>
              d.capability === grant.capability &&
              d.scope_type === grant.scope_type &&
              d.scope_ids.includes(id),
          ),
        );
        return ids.length ? [{ ...grant, scope_ids: ids }] : [];
      });
    }
    const roles = await this.database.pool.query<{ role: Role }>(
      `SELECT role FROM role_assignments WHERE tenant_id=$1 AND user_id=$2 AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now()) ORDER BY role`,
      [tenantId, userId],
    );
    return ActorContextSchema.parse({
      tenant_id: tenantId,
      user_id: userId,
      roles: roles.rows.map((r) => r.role),
      department_ids: unique(
        grants
          .filter(
            (g) =>
              g.scope_type === 'department' || g.scope_type === 'assigned_task',
          )
          .flatMap((g) => g.scope_ids),
      ),
      permissions: unique(grants.map((g) => g.capability)),
      authz_version: person.authz_version,
      session_id: origin.sessionId,
      invocation_origin: origin.invocationOrigin,
      delegation_id:
        origin.invocationOrigin === 'subscription' ? origin.delegationId : null,
    });
  }
  async requireCurrentActor(actor: ActorContext): Promise<ActorContext> {
    const valid = ActorContextSchema.parse(actor);
    const current = await this.getCurrentActor(
      valid.tenant_id,
      valid.user_id,
      valid.invocation_origin === 'interactive'
        ? { sessionId: valid.session_id, invocationOrigin: 'interactive' }
        : {
            sessionId: null,
            invocationOrigin: 'subscription',
            delegationId: valid.delegation_id,
          },
    );
    if (current.authz_version !== valid.authz_version)
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '权限已更新，请刷新后重新操作。',
      );
    return current;
  }
  async loginDemo(
    userId: string,
    oldToken?: string,
    environment: DemoEnvironmentInput = {},
    command?: { key: string; operation: 'login' | 'switch' },
  ): Promise<SessionView> {
    this.assertDemo();
    const tenantId = environment.tenantId ?? 't-demo';
    const environmentId = environment.environmentId ?? 'demo-default';
    const generation = environment.generation ?? 1;
    if (!DEMO_IDENTITIES.some((person) => person.id === userId))
      throw missing();
    let sessionId = randomUUID();
    let keyId = this.activeKeyId;
    let expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const commandActor = oldToken ? hash(oldToken) : `demo-selection:${userId}`;
    const payloadHash = hash(
      JSON.stringify({ userId, tenantId, environmentId, generation }),
    );
    await this.transact(async (tx) => {
      if (command) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `${tenantId}:${commandActor}:${command.operation}:${command.key}`,
        ]);
        const prior = await tx.query(
          'SELECT payload_hash,result FROM identity_command_ledger WHERE tenant_id=$1 AND actor_id=$2 AND operation=$3 AND idempotency_key=$4',
          [tenantId, commandActor, command.operation, command.key],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].payload_hash !== payloadHash)
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              '相同请求编号的身份选择已发生变化。',
            );
          sessionId = prior.rows[0].result.session_id;
          keyId = prior.rows[0].result.signature_key_id;
          expires = new Date(prior.rows[0].result.expires_at);
          return;
        }
      }
      const env = await tx.query(
        'SELECT generation FROM identity_environments WHERE tenant_id=$1 AND id=$2 FOR SHARE',
        [tenantId, environmentId],
      );
      if (env.rows[0]?.generation !== generation)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '演示环境已更新，请重新选择身份。',
        );
      const person = await this.loadIdentity(tenantId, userId, tx);
      if (oldToken) {
        const oldHash = this.verifyToken(oldToken);
        const old = await tx.query(
          'SELECT tenant_id FROM identity_sessions WHERE token_hash=$1 AND revoked_at IS NULL FOR UPDATE',
          [oldHash],
        );
        if (!old.rows[0] || old.rows[0].tenant_id !== tenantId)
          throw unauthenticated();
        await tx.query(
          'UPDATE identity_sessions SET revoked_at=now(),updated_at=now(),version=version+1 WHERE token_hash=$1',
          [oldHash],
        );
      }
      await tx.query(
        'INSERT INTO identity_sessions(tenant_id,id,actor_id,authz_version,generation,token_hash,csrf_hash,expires_at,signature_key_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          tenantId,
          sessionId,
          userId,
          person.authz_version,
          generation,
          hash(this.tokenForSession(sessionId, keyId)),
          hash(this.csrfForSession(sessionId, keyId)),
          expires,
          keyId,
        ],
      );
      if (command)
        await tx.query(
          'INSERT INTO identity_command_ledger(tenant_id,actor_id,operation,idempotency_key,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
          [
            tenantId,
            commandActor,
            command.operation,
            command.key,
            payloadHash,
            JSON.stringify({
              session_id: sessionId,
              signature_key_id: keyId,
              expires_at: expires.toISOString(),
            }),
          ],
        );
    });
    const token = this.tokenForSession(sessionId, keyId);
    const csrf = this.csrfForSession(sessionId, keyId);
    const actor = await this.getActor(token);
    return {
      session_token: token,
      csrf_token: csrf,
      me: await this.getMe(actor),
      expires_at: expires.toISOString(),
      cache_invalidated: true,
    };
  }
  async logout(token: string): Promise<void> {
    const tokenHash = this.verifyToken(token);
    await this.database.pool.query(
      'UPDATE identity_sessions SET revoked_at=coalesce(revoked_at,now()),updated_at=now() WHERE token_hash=$1',
      [tokenHash],
    );
  }
  async validateCsrf(
    token: string,
    csrf: string,
    allowRevoked = false,
  ): Promise<void> {
    const tokenHash = this.verifyToken(token);
    if (!allowRevoked) await this.getActor(token);
    const result = await this.database.pool.query(
      'SELECT csrf_hash FROM identity_sessions WHERE token_hash=$1 AND expires_at>now()',
      [tokenHash],
    );
    if (!result.rows[0] || !equal(hash(csrf), result.rows[0].csrf_hash))
      throw new AppError('FORBIDDEN', '请求校验已失效，请刷新页面后重试。');
  }
  async getMe(actor: ActorContext): Promise<Me> {
    const current = await this.requireCurrentActor(actor);
    const person = await this.loadIdentity(current.tenant_id, current.user_id);
    const session = current.session_id
      ? await this.sessionById(current.tenant_id, current.session_id)
      : null;
    return MeSchema.parse({
      actor: current,
      display_name: person.display_name,
      department_id: person.department_id,
      department_name: person.department_name,
      roles: current.roles,
      grants: await this.listMyGrants(current),
      csrf_token: session
        ? this.csrfForSession(session.id, session.signature_key_id)
        : null,
      generation: person.generation,
    });
  }
  async listMyGrants(actor: ActorContext): Promise<Grant[]> {
    const current = await this.requireCurrentActor(actor);
    const grants = await this.grants(current.tenant_id, current.user_id);
    if (current.invocation_origin === 'interactive') return grants;
    const delegation = await this.database.pool.query(
      'SELECT scope FROM subscription_delegations WHERE tenant_id=$1 AND id=$2 AND state=$3',
      [current.tenant_id, current.delegation_id, 'active'],
    );
    const scopes = z.array(GrantSchema).parse(delegation.rows[0]?.scope ?? []);
    return grants.flatMap((g) => {
      if (!current.permissions.includes(g.capability)) return [];
      const ids = g.scope_ids.filter((id) =>
        scopes.some(
          (s) =>
            s.capability === g.capability &&
            s.scope_type === g.scope_type &&
            s.scope_ids.includes(id),
        ),
      );
      return ids.length ? [{ ...g, scope_ids: ids }] : [];
    });
  }
  async assertPermission(
    actor: ActorContext,
    permission: Permission,
  ): Promise<void> {
    const current = await this.requireCurrentActor(actor);
    if (!current.permissions.includes(permission)) throw forbidden();
  }
  registerResourceResolver(type: string, resolver: ResourceResolver): void {
    if (this.resolvers.has(type))
      throw new Error(`资源授权解析器已注册：${type}`);
    this.resolvers.set(type, resolver);
  }
  async getResourceScope(
    actor: ActorContext,
    operation: string,
  ): Promise<ResourceScope> {
    const current = await this.requireCurrentActor(actor);
    const grants = (await this.listMyGrants(current)).filter(
      (g) =>
        g.capability === operation ||
        g.capability === `${operation}.own` ||
        g.capability === `${operation}.department`,
    );
    return {
      tenant_id: current.tenant_id,
      owner_ids: unique(
        grants
          .filter((g) => g.scope_type === 'self')
          .flatMap((g) => g.scope_ids)
          .filter((id) => id === current.user_id),
      ),
      department_ids: unique(
        grants
          .filter((g) => g.scope_type === 'department')
          .flatMap((g) => g.scope_ids),
      ),
      named_resource_ids: unique(
        grants
          .filter((g) => g.scope_type === 'named_resource')
          .flatMap((g) => g.scope_ids),
      ),
      operations_ids: unique(
        grants
          .filter((g) => g.scope_type === 'operations')
          .flatMap((g) => g.scope_ids),
      ),
      assigned_task_department_ids: unique(
        grants
          .filter((g) => g.scope_type === 'assigned_task')
          .flatMap((g) => g.scope_ids),
      ),
    };
  }
  private canRead(
    current: ActorContext,
    grants: Grant[],
    ref: AuthorizationRef,
    resource: ResourceMetadata,
  ): boolean {
    if (
      ['memory', 'thread', 'message', 'subscription', 'inbox'].includes(
        ref.type,
      )
    )
      return resource.owner_id === current.user_id;
    const domain =
      ref.type === 'travel'
        ? 'travel'
        : ['expense_claim', 'expense_item', 'invoice'].includes(ref.type)
          ? 'expense'
          : ref.type === 'oa_request'
            ? 'oa'
            : null;
    if (domain)
      return grants.some(
        (g) =>
          (g.capability === `${domain}.read.own` &&
            g.scope_type === 'self' &&
            resource.owner_id === current.user_id &&
            g.scope_ids.includes(current.user_id)) ||
          (g.capability === `${domain}.read.department` &&
            g.scope_type === 'department' &&
            !!resource.department_id &&
            g.scope_ids.includes(resource.department_id)),
      );
    if (ref.type === 'rule')
      return (
        resource.owner_id === current.user_id ||
        grants.some(
          (g) =>
            g.capability === 'rule.manage.company' &&
            g.scope_type === 'department' &&
            !!resource.department_id &&
            g.scope_ids.includes(resource.department_id),
        )
      );
    if (ref.type === 'skill')
      return grants.some(
        (g) =>
          g.capability === 'skill.use' &&
          g.scope_type === 'named_resource' &&
          g.scope_ids.includes(ref.id),
      );
    if (ref.type === 'analysis' || ref.type === 'report')
      return (
        resource.owner_id === current.user_id &&
        grants.some(
          (g) =>
            g.capability === 'analytics.query' &&
            (g.scope_type === 'self' ||
              (g.scope_type === 'department' &&
                !!resource.department_id &&
                g.scope_ids.includes(resource.department_id))),
        )
      );
    if (ref.type === 'policy')
      return grants.some(
        (g) =>
          g.capability === 'knowledge.manage' &&
          g.scope_type === 'named_resource' &&
          g.scope_ids.includes(ref.id),
      );
    return false;
  }
  async assertResourceAccess(
    actor: ActorContext,
    operation: string,
    ref: AuthorizationRef,
  ): Promise<void> {
    const current = await this.requireCurrentActor(actor);
    const resolver = this.resolvers.get(ref.type);
    if (!resolver) throw missing();
    const resource = await resolver(current, ref);
    const grants = await this.listMyGrants(current);
    const readable =
      !!resource &&
      resource.tenant_id === current.tenant_id &&
      this.canRead(current, grants, ref, resource);
    if (!readable) {
      await this.audit(
        current,
        ref,
        operation,
        'denied',
        '资源不存在或当前范围不匹配',
      );
      throw missing();
    }
    if (
      operation === 'read' ||
      operation === 'get' ||
      operation === 'download' ||
      operation.endsWith('.read')
    )
      return;
    const domain =
      ref.type === 'travel'
        ? 'travel'
        : ref.type === 'expense_claim'
          ? 'expense'
          : ref.type === 'oa_request'
            ? 'oa'
            : null;
    let permitted = false;
    if (
      operation === 'approve' ||
      operation === 'return' ||
      operation === 'approval.decide'
    ) {
      permitted =
        current.invocation_origin === 'interactive' &&
        resource.assigned_to === current.user_id &&
        resource.status === 'pending' &&
        ['manager', 'finance', 'pending_manager', 'pending_finance'].includes(
          resource.stage ?? '',
        ) &&
        grants.some(
          (g) =>
            g.capability === 'approval.decide' &&
            g.scope_type === 'assigned_task' &&
            !!resource.department_id &&
            g.scope_ids.includes(resource.department_id),
        );
    } else if (
      domain &&
      (operation === 'write' ||
        operation.endsWith('.write') ||
        operation.startsWith(`${domain}.`))
    ) {
      permitted =
        current.invocation_origin === 'interactive' &&
        resource.owner_id === current.user_id &&
        grants.some(
          (g) =>
            g.capability === `${domain}.write.own` &&
            g.scope_type === 'self' &&
            g.scope_ids.includes(current.user_id),
        );
    } else {
      permitted =
        current.invocation_origin === 'interactive' &&
        grants.some(
          (g) =>
            g.capability === operation &&
            ((g.scope_type === 'self' &&
              resource.owner_id === current.user_id) ||
              (g.scope_type === 'department' &&
                !!resource.department_id &&
                g.scope_ids.includes(resource.department_id)) ||
              (g.scope_type === 'named_resource' &&
                g.scope_ids.includes(ref.id))),
        );
    }
    if (!permitted) {
      await this.audit(
        current,
        ref,
        operation,
        'denied',
        '动作权限或当前节点不匹配',
      );
      throw forbidden();
    }
  }
  private async audit(
    actor: ActorContext,
    ref: AuthorizationRef,
    operation: string,
    result: string,
    reason: string,
  ) {
    await this.database.pool.query(
      'INSERT INTO authz_audit(tenant_id,id,actor_id,target_user_id,before_version,after_version,reason,trace_id,resource_type,resource_id,operation,result) VALUES($1,$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,$10)',
      [
        actor.tenant_id,
        randomUUID(),
        actor.user_id,
        actor.authz_version,
        reason,
        randomUUID(),
        ref.type,
        ref.id,
        operation,
        result,
      ],
    );
  }

  private paging(input: PageInput) {
    return {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(input.limit ?? 20),
      cursor: input.cursor ?? '',
      q: (input.q ?? '').trim(),
    };
  }
  private page<T extends { id: string }>(rows: T[], limit: number): Page<T> {
    return {
      items: rows.slice(0, limit),
      next_cursor: rows.length > limit ? rows[limit - 1]!.id : null,
    };
  }
  async searchPeople(
    actor: ActorContext,
    input: PeopleQuery = {},
  ): Promise<Page<PersonCandidate>> {
    const current = await this.requireCurrentActor(actor);
    const { limit, cursor, q } = this.paging(input);
    const result = await this.database.pool.query(
      `SELECT i.id,i.display_name,i.department_id,o.name AS department_name,i.position FROM identities i JOIN organizations o ON o.tenant_id=i.tenant_id AND o.id=i.department_id WHERE i.tenant_id=$1 AND i.state='active' AND o.state='active' AND i.id>$2 AND ($3='' OR strpos(i.display_name,$3)>0) AND ($4::text IS NULL OR i.department_id=$4) ORDER BY i.id LIMIT $5`,
      [current.tenant_id, cursor, q, input.department_id ?? null, limit + 1],
    );
    return this.page(z.array(PersonCandidateSchema).parse(result.rows), limit);
  }
  async listDepartments(
    actor: ActorContext,
    input: PageInput = {},
  ): Promise<Page<Department>> {
    const current = await this.requireCurrentActor(actor);
    const { limit, cursor } = this.paging(input);
    const result = await this.database.pool.query(
      `SELECT id,name,parent_id,manager_user_id,state,version FROM organizations WHERE tenant_id=$1 AND state='active' AND id>$2 ORDER BY id LIMIT $3`,
      [current.tenant_id, cursor, limit + 1],
    );
    return this.page(z.array(DepartmentSchema).parse(result.rows), limit);
  }
  async resolveManager(
    actor: ActorContext,
    departmentId: string,
  ): Promise<PersonCandidate> {
    const current = await this.requireCurrentActor(actor);
    const result = await this.database.pool.query(
      `SELECT i.id,i.display_name,i.department_id,d.name AS department_name,i.position FROM organizations o JOIN identities i ON i.tenant_id=o.tenant_id AND i.id=o.manager_user_id JOIN organizations d ON d.tenant_id=i.tenant_id AND d.id=i.department_id WHERE o.tenant_id=$1 AND o.id=$2 AND o.state='active' AND i.state='active'`,
      [current.tenant_id, departmentId],
    );
    if (!result.rows[0])
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '无法确认当前部门审批人，请稍后重试。',
        { retryable: true },
      );
    return PersonCandidateSchema.parse(result.rows[0]);
  }
  async listGroups(
    actor: ActorContext,
    input: PageInput = {},
  ): Promise<Page<AuthorizationGroup>> {
    const current = await this.requireCurrentActor(actor);
    const { limit, cursor, q } = this.paging(input);
    const result = await this.database.pool.query(
      `SELECT id,name,state,source,version FROM authorization_groups WHERE tenant_id=$1 AND state='active' AND id>$2 AND ($3='' OR strpos(name,$3)>0) ORDER BY id LIMIT $4`,
      [current.tenant_id, cursor, q, limit + 1],
    );
    return this.page(
      z.array(AuthorizationGroupSchema).parse(result.rows),
      limit,
    );
  }
  async assertGroupExists(actor: ActorContext, groupId: string): Promise<void> {
    const current = await this.requireCurrentActor(actor);
    const result = await this.database.pool.query(
      `SELECT id FROM authorization_groups WHERE tenant_id=$1 AND id=$2 AND state='active'`,
      [current.tenant_id, groupId],
    );
    if (!result.rows[0])
      throw new AppError('VALIDATION_ERROR', '请选择同一组织中的有效授权组。');
  }
  async isGroupMember(
    actor: ActorContext,
    groupId: string,
    userId: string,
  ): Promise<boolean> {
    const current = await this.requireCurrentActor(actor);
    const result = await this.database.pool.query(
      `SELECT m.user_id FROM group_membership m JOIN authorization_groups g ON g.tenant_id=m.tenant_id AND g.id=m.group_id JOIN identities i ON i.tenant_id=m.tenant_id AND i.id=m.user_id WHERE m.tenant_id=$1 AND m.group_id=$2 AND m.user_id=$3 AND g.state='active' AND i.state='active' AND m.valid_from<=now() AND (m.valid_to IS NULL OR m.valid_to>now())`,
      [current.tenant_id, groupId, userId],
    );
    return result.rowCount !== 0;
  }
  async listCostCenters(
    actor: ActorContext,
    businessDate: string,
  ): Promise<CostCenter[]> {
    z.iso.date().parse(businessDate);
    const current = await this.requireCurrentActor(actor);
    const person = await this.loadIdentity(current.tenant_id, current.user_id);
    const result = await this.database.pool.query(
      `SELECT id,name,department_id,to_char(valid_from,'YYYY-MM-DD') AS valid_from,to_char(valid_to,'YYYY-MM-DD') AS valid_to,state,version FROM cost_centers WHERE tenant_id=$1 AND department_id=$2 AND state='active' AND valid_from<=$3::date AND (valid_to IS NULL OR valid_to>=$3::date) ORDER BY id`,
      [current.tenant_id, person.department_id, businessDate],
    );
    return z.array(CostCenterSchema).parse(result.rows);
  }
  async validateCostCenter(
    actor: ActorContext,
    id: string,
    businessDate: string,
  ): Promise<CostCenter> {
    const item = (await this.listCostCenters(actor, businessDate)).find(
      (c) => c.id === id,
    );
    if (!item)
      throw new AppError(
        'VALIDATION_ERROR',
        '成本中心不属于当前部门或在业务日期已失效，请重新选择。',
      );
    return item;
  }
  async listProjects(
    actor: ActorContext,
    businessDate: string,
  ): Promise<Project[]> {
    z.iso.date().parse(businessDate);
    const current = await this.requireCurrentActor(actor);
    const person = await this.loadIdentity(current.tenant_id, current.user_id);
    const result = await this.database.pool.query(
      `SELECT id,name,department_id,state,version FROM projects WHERE tenant_id=$1 AND department_id=$2 AND state='active' ORDER BY id`,
      [current.tenant_id, person.department_id],
    );
    return z.array(ProjectSchema).parse(result.rows);
  }
  async validateProject(
    actor: ActorContext,
    id: string,
    businessDate: string,
  ): Promise<Project> {
    const item = (await this.listProjects(actor, businessDate)).find(
      (p) => p.id === id,
    );
    if (!item)
      throw new AppError(
        'VALIDATION_ERROR',
        '项目不属于当前部门或已失效，请重新选择。',
      );
    return item;
  }
  async createSubscriptionDelegation(
    actor: ActorContext,
    input: {
      subscriptionId: string;
      allowedCapabilities: Permission[];
      scope?: Grant[];
    },
  ): Promise<{ id: string; version: number }> {
    const current = await this.requireCurrentActor(actor);
    if (current.invocation_origin !== 'interactive') throw forbidden();
    const allowed = z
      .array(PermissionSchema)
      .min(1)
      .parse(input.allowedCapabilities);
    if (
      allowed.some(
        (capability) =>
          !READ_ONLY_SUBSCRIPTION_PERMISSIONS.has(capability) ||
          !current.permissions.includes(capability),
      )
    )
      throw forbidden();
    const currentGrants = await this.listMyGrants(current);
    const requested = input.scope
      ? z.array(GrantSchema).parse(input.scope)
      : currentGrants;
    const scope = currentGrants
      .filter((grant) => allowed.includes(grant.capability))
      .flatMap((grant) => {
        const ids = grant.scope_ids.filter((id) =>
          requested.some(
            (r) =>
              r.capability === grant.capability &&
              r.scope_type === grant.scope_type &&
              r.scope_ids.includes(id),
          ),
        );
        return ids.length ? [{ ...grant, scope_ids: ids }] : [];
      });
    if (
      allowed.some(
        (capability) => !scope.some((grant) => grant.capability === capability),
      )
    )
      throw forbidden();
    const person = await this.loadIdentity(current.tenant_id, current.user_id);
    const id = randomUUID();
    const result = await this.database.pool.query(
      `INSERT INTO subscription_delegations(tenant_id,id,owner_id,subscription_id,allowed_capabilities,scope,state,generation) VALUES($1,$2,$3,$4,$5,$6,'active',$7) ON CONFLICT(tenant_id,owner_id,subscription_id) DO UPDATE SET allowed_capabilities=excluded.allowed_capabilities,scope=excluded.scope,state='active',generation=excluded.generation,version=subscription_delegations.version+1,updated_at=now() RETURNING id,version`,
      [
        current.tenant_id,
        id,
        current.user_id,
        z.string().min(1).parse(input.subscriptionId),
        JSON.stringify(unique(allowed)),
        JSON.stringify(scope),
        person.generation,
      ],
    );
    return result.rows[0] as { id: string; version: number };
  }
  async getActorFromSubscription(
    tenantId: string,
    delegationId: string,
  ): Promise<ActorContext> {
    const result = await this.database.pool.query(
      `SELECT owner_id FROM subscription_delegations WHERE tenant_id=$1 AND id=$2 AND state='active'`,
      [tenantId, delegationId],
    );
    if (!result.rows[0]) throw forbidden();
    return this.getCurrentActor(tenantId, result.rows[0].owner_id, {
      sessionId: null,
      invocationOrigin: 'subscription',
      delegationId,
    });
  }
  async revokeSubscriptionDelegation(
    actor: ActorContext,
    delegationId: string,
  ): Promise<void> {
    const current = await this.requireCurrentActor(actor);
    if (current.invocation_origin !== 'interactive') throw forbidden();
    const result = await this.database.pool.query(
      `UPDATE subscription_delegations SET state='revoked',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND owner_id=$3 RETURNING id`,
      [current.tenant_id, delegationId, current.user_id],
    );
    if (!result.rows[0]) throw missing();
  }
  async setDemoGroupMembership(input: {
    tenantId: string;
    groupId: string;
    userId: string;
    member: boolean;
    reason: string;
    traceId: string;
  }): Promise<void> {
    this.assertDemo();
    if (!input.reason || !input.traceId)
      throw new AppError('VALIDATION_ERROR', '组成员变更需要原因和追踪编号。');
    await this.transact(async (tx) => {
      const group = await tx.query(
        `SELECT id FROM authorization_groups WHERE tenant_id=$1 AND id=$2 AND state='active' FOR UPDATE`,
        [input.tenantId, input.groupId],
      );
      if (!group.rows[0])
        throw new AppError('VALIDATION_ERROR', '授权组不存在或已停用。');
      const person = await tx.query(
        `SELECT authz_version FROM identities WHERE tenant_id=$1 AND id=$2 AND state='active' FOR UPDATE`,
        [input.tenantId, input.userId],
      );
      if (!person.rows[0])
        throw new AppError(
          'VALIDATION_ERROR',
          '组成员必须是同一租户的有效用户。',
        );
      const membership = await tx.query(
        `SELECT user_id FROM group_membership WHERE tenant_id=$1 AND group_id=$2 AND user_id=$3 AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now())`,
        [input.tenantId, input.groupId, input.userId],
      );
      if (membership.rows.length > 0 === input.member) return;
      if (input.member)
        await tx.query(
          `INSERT INTO group_membership(tenant_id,group_id,user_id,valid_from) VALUES($1,$2,$3,now()) ON CONFLICT(tenant_id,group_id,user_id) DO UPDATE SET valid_from=now(),valid_to=NULL,version=group_membership.version+1,updated_at=now()`,
          [input.tenantId, input.groupId, input.userId],
        );
      else
        await tx.query(
          'UPDATE group_membership SET valid_to=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND group_id=$2 AND user_id=$3',
          [input.tenantId, input.groupId, input.userId],
        );
      await tx.query(
        'UPDATE authorization_groups SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [input.tenantId, input.groupId],
      );
      await tx.query(
        'UPDATE identities SET authz_version=authz_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [input.tenantId, input.userId],
      );
      const before = person.rows[0].authz_version as number;
      await tx.query(
        'INSERT INTO authz_audit(tenant_id,id,actor_id,target_user_id,before_version,after_version,reason,trace_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          input.tenantId,
          randomUUID(),
          'demo-scenario',
          input.userId,
          before,
          before + 1,
          input.reason,
          input.traceId,
          'group_changed',
        ],
      );
    });
  }
  async resolvePlace(
    actor: ActorContext,
    text: string,
  ): Promise<PlaceResolution> {
    const current = await this.requireCurrentActor(actor);
    const input = z.string().min(1).max(100).parse(text.trim());
    const alias = await this.database.pool.query(
      'SELECT target_place_ids,source,mapping_version FROM place_aliases WHERE tenant_id=$1 AND alias=$2',
      [current.tenant_id, input],
    );
    const mapping = alias.rows[0];
    const result = await this.database.pool.query(
      `SELECT p.id AS place_id,p.name,p.level,p.standard_code,p.province_name,CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'name',c.name,'standard_code',c.standard_code) END AS parent_city FROM cities p LEFT JOIN cities c ON c.tenant_id=p.tenant_id AND c.id=p.parent_city_id WHERE p.tenant_id=$1 AND p.state='active' AND (($2::jsonb IS NOT NULL AND $2::jsonb ? p.id) OR ($2::jsonb IS NULL AND p.name=$3)) ORDER BY p.id`,
      [
        current.tenant_id,
        mapping ? JSON.stringify(mapping.target_place_ids) : null,
        input,
      ],
    );
    const candidates = result.rows.map((row) => ({
      ...row,
      reason: row.parent_city
        ? `行政区所属城市映射；差旅城市按${row.parent_city.name}解释`
        : '标准城市；请核对所属省市',
    }));
    return PlaceResolutionSchema.parse({
      input,
      mapping_version: mapping?.mapping_version ?? 'city-map-v1',
      requires_selection: candidates.length > 1,
      candidates,
    });
  }

  async applyDemoGrantChange(
    input: DemoGrantChange,
  ): Promise<{ authz_version: number; cache_invalidated: true }> {
    this.assertDemo();
    return this.replaceGrantsInternal('demo-scenario', input);
  }
  async replaceGrants(
    actor: ActorContext,
    input: DemoGrantChange,
  ): Promise<{ authz_version: number; cache_invalidated: true }> {
    const current = await this.requireCurrentActor(actor);
    await this.assertPermission(current, 'identity.grant.manage');
    if (
      current.invocation_origin !== 'interactive' ||
      input.tenantId !== current.tenant_id ||
      input.targetUserId === current.user_id
    )
      throw forbidden();
    // 正式授权管理动作尚未接入 M11 确认与部署管理范围，默认失败关闭。
    throw new AppError(
      'INVALID_STATE',
      '授权管理需要已配置的确认动作与可授予范围。',
    );
  }
  private async replaceGrantsInternal(
    actorId: string,
    input: DemoGrantChange,
  ): Promise<{ authz_version: number; cache_invalidated: true }> {
    const grants = z.array(GrantSchema).parse(input.grants);
    if (!input.reason.trim() || !input.traceId)
      throw new AppError('VALIDATION_ERROR', '撤权场景需要原因和追踪编号。');
    return this.transact(async (tx) => {
      const person = await tx.query(
        'SELECT authz_version FROM identities WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [input.tenantId, input.targetUserId],
      );
      if (!person.rows[0]) throw missing();
      if (person.rows[0].authz_version !== input.expectedVersion)
        throw new AppError('VERSION_CONFLICT', '权限已更新，请刷新后重试。');
      for (const grant of grants) {
        if (
          grant.scope_type === 'self' &&
          (grant.scope_ids.length !== 1 ||
            grant.scope_ids[0] !== input.targetUserId)
        )
          throw new AppError(
            'VALIDATION_ERROR',
            '本人授权范围必须匹配目标用户。',
          );
        if (
          grant.scope_type === 'department' ||
          grant.scope_type === 'assigned_task'
        ) {
          const found = await tx.query(
            `SELECT id FROM organizations WHERE tenant_id=$1 AND id=ANY($2::text[]) AND state='active'`,
            [input.tenantId, grant.scope_ids],
          );
          if (found.rows.length !== grant.scope_ids.length)
            throw new AppError(
              'VALIDATION_ERROR',
              '授权部门必须是同租户的有效组织。',
            );
        }
      }
      await tx.query(
        'DELETE FROM grants WHERE tenant_id=$1 AND subject_id=$2',
        [input.tenantId, input.targetUserId],
      );
      const next = input.expectedVersion + 1;
      for (const grant of grants)
        await tx.query(
          'INSERT INTO grants(tenant_id,id,subject_id,capability,scope_type,scope_ids,effect,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            input.tenantId,
            randomUUID(),
            input.targetUserId,
            grant.capability,
            grant.scope_type,
            JSON.stringify(grant.scope_ids),
            grant.effect,
            next,
          ],
        );
      await tx.query(
        'UPDATE identities SET authz_version=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [input.tenantId, input.targetUserId, next],
      );
      await tx.query(
        'INSERT INTO authz_audit(tenant_id,id,actor_id,target_user_id,before_version,after_version,reason,trace_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          input.tenantId,
          randomUUID(),
          actorId,
          input.targetUserId,
          input.expectedVersion,
          next,
          input.reason,
          input.traceId,
          'changed',
        ],
      );
      return { authz_version: next, cache_invalidated: true };
    });
  }
  async seedDemoIdentity(
    environment: DemoEnvironmentInput = {},
  ): Promise<void> {
    if (this.options.appMode === 'production') throw forbidden();
    const tenantId = environment.tenantId ?? 't-demo';
    const environmentId = environment.environmentId ?? 'demo-default';
    const generation = environment.generation ?? 1;
    await this.transact(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `identity-seed:${tenantId}`,
      ]);
      const existing = await tx.query(
        'SELECT id,generation FROM identity_environments WHERE tenant_id=$1',
        [tenantId],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].id !== environmentId ||
          existing.rows[0].generation !== generation
        )
          throw new AppError(
            'VERSION_CONFLICT',
            '演示环境版本不匹配，必须通过受控重置切换。',
          );
        return;
      }
      await tx.query(
        'INSERT INTO identity_environments(tenant_id,id,generation,seed_version) VALUES($1,$2,$3,$4)',
        [tenantId, environmentId, generation, DEMO_SEED_VERSION],
      );
      for (const dept of DEMO_DEPARTMENTS)
        await tx.query(
          `INSERT INTO organizations(tenant_id,id,name,manager_user_id,state) VALUES($1,$2,$3,$4,'active')`,
          [tenantId, dept.id, dept.name, dept.manager],
        );
      for (const person of DEMO_IDENTITIES) {
        await tx.query(
          `INSERT INTO identities(tenant_id,id,external_subject,display_name,department_id,position,state) VALUES($1,$2,$2,$3,$4,$5,'active')`,
          [
            tenantId,
            person.id,
            person.name,
            person.departmentId,
            person.position,
          ],
        );
        for (const role of person.roles)
          await tx.query(
            `INSERT INTO role_assignments(tenant_id,user_id,role,valid_from) VALUES($1,$2,$3,'2026-01-01T00:00:00Z')`,
            [tenantId, person.id, role],
          );
      }
      const manifest = createDemoGrantManifest(environmentId);
      for (const [userId, grants] of Object.entries(manifest))
        for (const grant of grants)
          await tx.query(
            'INSERT INTO grants(tenant_id,id,subject_id,capability,scope_type,scope_ids,effect) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              tenantId,
              randomUUID(),
              userId,
              grant.capability,
              grant.scope_type,
              JSON.stringify(grant.scope_ids),
              grant.effect,
            ],
          );
      for (const group of DEMO_GROUPS) {
        await tx.query(
          `INSERT INTO authorization_groups(tenant_id,id,name,state,source) VALUES($1,$2,$3,'active','demo-manifest')`,
          [tenantId, group.id, group.name],
        );
        for (const userId of group.members)
          await tx.query(
            `INSERT INTO group_membership(tenant_id,group_id,user_id,valid_from) VALUES($1,$2,$3,'2026-01-01T00:00:00Z')`,
            [tenantId, group.id, userId],
          );
      }
      for (const [id, name, dept] of [
        ['cc-sales', '销售成本中心', 'dept-sales'],
        ['cc-tech', '技术成本中心', 'dept-tech'],
        ['cc-finance', '财务成本中心', 'dept-finance'],
      ])
        await tx.query(
          `INSERT INTO cost_centers(tenant_id,id,name,department_id,valid_from,state) VALUES($1,$2,$3,$4,'2026-01-01','active')`,
          [tenantId, id, name, dept],
        );
      for (const [id, name, dept] of [
        ['prj-market', '市场拓展', 'dept-sales'],
        ['prj-infra', '基础设施', 'dept-tech'],
      ])
        await tx.query(
          `INSERT INTO projects(tenant_id,id,name,department_id,state) VALUES($1,$2,$3,$4,'active')`,
          [tenantId, id, name, dept],
        );
      for (const [id, code, name, level, province, parent] of [
        ['city-beijing', '110100', '北京', 'city', '北京市', null],
        ['city-shanghai', '310100', '上海', 'city', '上海市', null],
        ['city-hangzhou', '330100', '杭州', 'city', '浙江省', null],
        [
          'district-yuhang',
          '330110',
          '余杭',
          'district',
          '浙江省',
          'city-hangzhou',
        ],
        [
          'district-chaoyang-beijing',
          '110105',
          '朝阳',
          'district',
          '北京市',
          'city-beijing',
        ],
        ['city-chaoyang-liaoning', '211300', '朝阳', 'city', '辽宁省', null],
      ])
        await tx.query(
          `INSERT INTO cities(tenant_id,id,standard_code,name,level,province_name,parent_city_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'active')`,
          [tenantId, id, code, name, level, province, parent],
        );
      for (const [id, alias, targets] of [
        ['alias-yuhang', '余杭', ['district-yuhang']],
        [
          'alias-chaoyang',
          '朝阳',
          ['district-chaoyang-beijing', 'city-chaoyang-liaoning'],
        ],
      ] as const)
        await tx.query(
          `INSERT INTO place_aliases(tenant_id,id,alias,target_place_ids,source,mapping_version) VALUES($1,$2,$3,$4,'演示行政区映射','city-map-v1')`,
          [tenantId, id, alias, JSON.stringify(targets)],
        );
    });
  }
}

export function createIdentityService(
  database: DatabaseConnection,
  options: IdentityOptions,
): IdentityService {
  return new IdentityService(database, options);
}
