import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActorContext,
  ActionReceipt,
  ResourceRef,
  ApiErrorCode,
} from '@caixiaozhi/contracts';
import { ActionReceiptSchema } from '@caixiaozhi/contracts';
import {
  ActionNameSchema,
  ConfirmInputSchema,
  PrepareInputSchema,
  type ActionName,
  type ActionState,
  type ActionView,
  type ConfirmationView,
  type ConfirmInput,
  type InteractiveConfirmationReview,
  type PrepareInput,
  type DependencyRef,
} from '@caixiaozhi/contracts/actions';
import { AppError } from '@caixiaozhi/platform/errors';
import type { Database, DatabaseExecutor } from '@caixiaozhi/platform/database';
import type {
  ActionContext,
  ActionHandler,
  ConfirmedAction,
  PreparedDomainAction,
  PreparedActionItem,
} from '@caixiaozhi/business-adapters/ports';

export type ActionServiceOptions = {
  signingSecret: string;
  freshActor(actor: ActorContext): Promise<ActorContext>;
  assertAdmission?: (actor: ActorContext) => Promise<void>;
  assertResourceAccess(
    actor: ActorContext,
    operation: string,
    ref: ResourceRef,
    tx?: DatabaseExecutor,
  ): Promise<void>;
  generation?: () => Promise<number>;
  now?: () => Date;
  assertDependencies?: (
    actor: ActorContext,
    refs: DependencyRef[],
    tx?: DatabaseExecutor,
  ) => Promise<void>;
  reconciliationTimeoutMs?: number;
};
type Row = Record<string, unknown>;
type Stored = {
  id: string;
  tenant_id: string;
  actor_id: string;
  actor_context: ActorContext;
  confirmation_id: string;
  operation: ActionName;
  state: ActionState;
  version: number;
  args: unknown;
  resource_refs: ResourceRef[];
  prepared_domain: PreparedDomainAction;
  generation: number;
  run_id: string | null;
  trace_id: string | null;
  cancel_requested: boolean;
};
type Confirmation = {
  id: string;
  tenant_id: string;
  actor_id: string;
  session_id: string;
  authz_version: number;
  version: number;
  action_id: string;
  operation: ActionName;
  args_hash: string;
  summary_hash: string;
  resource_refs: ResourceRef[];
  dependency_refs: NonNullable<PreparedDomainAction['dependency_refs']>;
  extra_guards: Record<string, unknown>;
  summary: unknown;
  generation: number;
  expires_at: Date;
  confirmed_at: Date | null;
};
type Item = {
  id: string;
  ordinal: number;
  resource_ref: ResourceRef | null;
  task_ref: PreparedActionItem['task_ref'];
  args: unknown;
  guards: Record<string, unknown>;
  state: ActionState;
  external_request_id: string;
  idempotency_key: string;
};
export function canonicalJson(value: unknown): string {
  function normalize(v: unknown): unknown {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(normalize);
    if (
      v &&
      typeof v === 'object' &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, normalize(val)]),
      );
    }
    throw new AppError('VALIDATION_ERROR', '参数必须是规范 JSON。');
  }
  return JSON.stringify(normalize(value));
}
export const hashPayload = (v: unknown) =>
  createHash('sha256').update(canonicalJson(v)).digest('hex');
const json = (v: unknown) => sql`${canonicalJson(v)}::jsonb`;
const cast = <T>(row: unknown) => row as T;
const terminal = new Set<ActionState>([
  'succeeded',
  'rejected',
  'failed',
  'cancelled',
  'expired',
]);
const knownCode = (error: unknown): ApiErrorCode => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'VALIDATION_ERROR',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'VERSION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'INVALID_STATE',
      'CONFIRMATION_EXPIRED',
      'REVALIDATION_REQUIRED',
      'RATE_LIMITED',
      'DEPENDENCY_UNAVAILABLE',
      'OUTCOME_UNKNOWN',
    ].includes(error.code)
  )
    return error.code as ApiErrorCode;
  return 'DEPENDENCY_UNAVAILABLE';
};
const guardCode = (code: ApiErrorCode) =>
  !['DEPENDENCY_UNAVAILABLE', 'OUTCOME_UNKNOWN'].includes(code);

export function createActionService(
  database: Database,
  options: ActionServiceOptions,
) {
  if (Buffer.byteLength(options.signingSecret) < 32)
    throw new Error('确认签名密钥至少需要 32 字节。');
  const handlers = new Map<ActionName, ActionHandler<unknown>>();
  const now = () => options.now?.() ?? new Date();
  const generation = () => options.generation?.() ?? Promise.resolve(1);
  const handlerFor = (name: ActionName) => {
    const handler = handlers.get(name);
    if (!handler)
      throw new AppError('INVALID_STATE', '此动作尚未接入业务处理器。');
    return handler;
  };
  async function current(actor: ActorContext) {
    const fresh = await options.freshActor(actor);
    if (
      fresh.tenant_id !== actor.tenant_id ||
      fresh.user_id !== actor.user_id ||
      fresh.session_id !== actor.session_id ||
      fresh.invocation_origin !== actor.invocation_origin
    )
      throw new AppError('FORBIDDEN', '身份或交互会话不匹配。');
    return fresh;
  }
  function interactive(actor: ActorContext) {
    if (actor.invocation_origin !== 'interactive' || !actor.session_id)
      throw new AppError('FORBIDDEN', '此操作需要当前浏览器交互会话。');
  }
  async function actionRow(id: string, tx: DatabaseExecutor = database) {
    const r = await tx.execute(sql`SELECT * FROM actions WHERE id=${id}`);
    if (!r.rows[0]) throw new AppError('NOT_FOUND', '动作不存在或无权访问。');
    return cast<Stored>(r.rows[0]);
  }
  async function confirmationRow(
    id: string,
    tx: DatabaseExecutor = database,
    lock = false,
  ) {
    const r = await tx.execute(
      sql`SELECT * FROM confirmations WHERE id=${id} ${lock ? sql`FOR UPDATE` : sql``}`,
    );
    if (!r.rows[0]) throw new AppError('NOT_FOUND', '确认不存在或无权访问。');
    return cast<Confirmation>(r.rows[0]);
  }
  async function itemsOf(id: string, tx: DatabaseExecutor = database) {
    return (
      await tx.execute(
        sql`SELECT * FROM action_items WHERE action_id=${id} ORDER BY ordinal`,
      )
    ).rows.map((row) => cast<Item>(row));
  }
  async function access(
    actor: ActorContext,
    a: Stored,
    tx: DatabaseExecutor = database,
    operation: string = a.operation,
  ) {
    if (actor.tenant_id !== a.tenant_id || actor.user_id !== a.actor_id)
      throw new AppError('NOT_FOUND', '动作不存在或无权访问。');
    for (const ref of a.resource_refs)
      await options.assertResourceAccess(actor, operation, ref, tx);
  }
  async function binding(
    actor: ActorContext,
    c: Confirmation,
    checkExpiry = true,
  ) {
    interactive(actor);
    if (actor.tenant_id !== c.tenant_id || actor.user_id !== c.actor_id)
      throw new AppError('NOT_FOUND', '确认不存在或无权访问。');
    if (actor.session_id !== c.session_id)
      throw new AppError('FORBIDDEN', '请在创建此确认的浏览器会话中操作。');
    if (
      actor.authz_version !== c.authz_version ||
      c.generation !== (await generation())
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '权限或演示环境版本已变化，请重新准备确认。',
      );
    if (checkExpiry && now().getTime() >= new Date(c.expires_at).getTime())
      throw new AppError('CONFIRMATION_EXPIRED', '确认已过期，请重新准备。');
  }
  async function audit(
    tx: DatabaseExecutor,
    a: Stored,
    event: string,
    details: unknown = {},
    itemId: string | null = null,
  ) {
    await tx.execute(
      sql`INSERT INTO action_audit(id,tenant_id,actor_id,action_id,item_id,event_type,details) VALUES(${randomUUID()},${a.tenant_id},${a.actor_id},${a.id},${itemId},${event},${json(details)})`,
    );
  }
  function confirmationView(
    c: Confirmation,
    state: ActionState,
  ): ConfirmationView {
    return {
      action_id: c.action_id,
      confirmation_id: c.id,
      version: c.version,
      summary: c.summary,
      summary_hash: c.summary_hash,
      expires_at: new Date(c.expires_at).toISOString(),
      state,
    };
  }
  async function internalView(
    a: Stored,
    tx: DatabaseExecutor = database,
  ): Promise<ActionView> {
    const rows = await itemsOf(a.id, tx);
    const receipts = (
      await tx.execute(
        sql`SELECT * FROM action_receipts WHERE action_id=${a.id}`,
      )
    ).rows;
    const summary = {
      succeeded: 0,
      rejected: 0,
      failed: 0,
      unknown: 0,
      cancelled: 0,
    };
    const items = rows.map((item) => {
      const record = receipts.find((r) => r.item_id === item.id);
      const receipt = record ? receiptProjection(record) : null;
      if (receipt) summary[receipt.outcome]++;
      else if (item.state === 'cancelled') summary.cancelled++;
      return {
        id: item.id,
        ordinal: item.ordinal,
        resource_ref: item.resource_ref,
        task_ref: item.task_ref ?? null,
        state: item.state,
        receipt,
      };
    });
    return {
      id: a.id,
      confirmation_id: a.confirmation_id,
      operation: a.operation,
      state: a.state,
      version: a.version,
      resource_refs: a.resource_refs,
      items,
      summary,
      next_poll_after_ms: ['unknown', 'executing', 'confirmed'].includes(
        a.state,
      )
        ? 1000
        : null,
    };
  }
  function receiptProjection(row: Row): ActionReceipt {
    return ActionReceiptSchema.parse({
      id: row.id,
      action_id: row.action_id,
      idempotency_key: row.idempotency_key,
      outcome: row.outcome,
      resource: row.resource,
      external_receipt_id: row.external_receipt_id,
      occurred_at: new Date(row.occurred_at as string).toISOString(),
      data_mode: row.data_mode,
      error_code: row.error_code,
    });
  }
  function tokenData(c: Confirmation, expires: number) {
    return {
      tenant: c.tenant_id,
      actor: c.actor_id,
      session: c.session_id,
      authz_version: c.authz_version,
      confirmation: c.id,
      version: 1,
      action: c.action_id,
      args_hash: c.args_hash,
      summary_hash: c.summary_hash,
      generation: c.generation,
      expires,
    };
  }
  function sign(data: unknown) {
    const body = Buffer.from(canonicalJson(data)).toString('base64url');
    return `${body}.${createHmac('sha256', options.signingSecret).update(body).digest('base64url')}`;
  }
  function verifyToken(token: string, c: Confirmation) {
    try {
      const [body, sig, ...extra] = token.split('.');
      if (!body || !sig || extra.length) throw 0;
      const actual = Buffer.from(sig, 'base64url'),
        expected = createHmac('sha256', options.signingSecret)
          .update(body)
          .digest();
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw 0;
      const decoded = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as { expires: number };
      if (
        typeof decoded.expires !== 'number' ||
        decoded.expires <= now().getTime() ||
        decoded.expires > new Date(c.expires_at).getTime() ||
        canonicalJson(decoded) !== canonicalJson(tokenData(c, decoded.expires))
      )
        throw 0;
    } catch {
      throw new AppError('FORBIDDEN', '确认令牌无效或已到期，请刷新确认页面。');
    }
  }
  function registerHandler<A>(name: ActionName, handler: ActionHandler<A>) {
    handlers.set(
      ActionNameSchema.parse(name),
      handler as ActionHandler<unknown>,
    );
  }
  async function prepareAction(
    actor: ActorContext,
    input: PrepareInput,
  ): Promise<ConfirmationView> {
    await options.assertAdmission?.(actor);
    const parsed = PrepareInputSchema.parse(input);
    const fresh = await current(actor);
    interactive(fresh);
    const refs = parsed.resource_refs;
    if (new Set(refs.map((r) => `${r.type}:${r.id}`)).size !== refs.length)
      throw new AppError('VALIDATION_ERROR', '确认对象不能重复。');
    const payloadHash = hashPayload({
      action: parsed.action,
      resource_refs: refs,
      args: parsed.args,
      dependency_refs: parsed.dependency_refs ?? [],
      extra_guards: parsed.extra_guards ?? {},
    });
    return database.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${fresh.tenant_id}:${fresh.user_id}:${parsed.action}:${parsed.idempotency_key}`},0))`,
      );
      const existing = await tx.execute(
        sql`SELECT * FROM actions WHERE tenant_id=${fresh.tenant_id} AND actor_id=${fresh.user_id} AND operation=${parsed.action} AND idempotency_key=${parsed.idempotency_key}`,
      );
      if (existing.rows[0]) {
        const a = cast<Stored & { payload_hash: string }>(existing.rows[0]);
        await access(fresh, a, tx);
        if (a.payload_hash !== payloadHash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '相同幂等键不能用于不同参数。',
          );
        return confirmationView(
          await confirmationRow(a.confirmation_id, tx),
          a.state,
        );
      }
      for (const ref of refs)
        await options.assertResourceAccess(fresh, parsed.action, ref, tx);
      const domain = await handlerFor(parsed.action).validate(
        fresh,
        parsed.args,
        refs,
        tx,
      );
      const normalizedArgs = domain.args ?? parsed.args;
      const id = randomUUID(),
        confirmationId = randomUUID(),
        gen = await generation();
      const dependencies = [
        ...new Map(
          [
            ...(domain.dependency_refs ?? []),
            ...(parsed.dependency_refs ?? []),
          ].map((ref) => [`${ref.type}:${ref.id}`, ref]),
        ).values(),
      ];
      if (
        (parsed.dependency_refs ?? []).some((ref) =>
          (domain.dependency_refs ?? []).some(
            (other) =>
              other.type === ref.type &&
              other.id === ref.id &&
              other.version !== ref.version,
          ),
        )
      )
        throw new AppError('REVALIDATION_REQUIRED', '动作依赖版本不一致。');
      await options.assertDependencies?.(fresh, dependencies, tx);
      const guards = domain.extra_guards ?? parsed.extra_guards ?? {};
      const argsHash = hashPayload({
        operation: parsed.action,
        args: normalizedArgs,
        resource_refs: refs,
        dependency_refs: dependencies,
        extra_guards: guards,
      });
      const summaryHash = hashPayload({
        summary: domain.summary,
        args_hash: argsHash,
      });
      const expires = new Date(now().getTime() + 600000);
      const items: PreparedActionItem[] =
        domain.items ?? refs.map((resource_ref) => ({ resource_ref }));
      if (!items.length || items.length > 50)
        throw new AppError('VALIDATION_ERROR', '动作必须包含 1–50 个执行项。');
      if (
        refs.length &&
        (items.length !== refs.length ||
          items.some(
            (i) =>
              !i.resource_ref ||
              !refs.some(
                (r) => canonicalJson(r) === canonicalJson(i.resource_ref),
              ),
          ))
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '动作执行项必须精确对应确认对象。',
        );
      await tx.execute(
        sql`INSERT INTO confirmations(id,tenant_id,actor_id,session_id,authz_version,action_id,operation,args_hash,summary_hash,resource_refs,dependency_refs,extra_guards,summary,generation,expires_at) VALUES(${confirmationId},${fresh.tenant_id},${fresh.user_id},${fresh.session_id!},${fresh.authz_version},${id},${parsed.action},${argsHash},${summaryHash},${json(refs)},${json(dependencies)},${json(guards)},${json(domain.summary)},${gen},${expires})`,
      );
      await tx.execute(
        sql`INSERT INTO actions(id,tenant_id,actor_id,actor_context,confirmation_id,operation,state,idempotency_key,payload_hash,args,resource_refs,prepared_domain,run_id,trace_id,generation) VALUES(${id},${fresh.tenant_id},${fresh.user_id},${json(fresh)},${confirmationId},${parsed.action},'prepared',${parsed.idempotency_key},${payloadHash},${json(normalizedArgs)},${json(refs)},${json(domain)},${parsed.run_id ?? null},${parsed.trace_id ?? null},${gen})`,
      );
      for (const [ordinal, item] of items.entries())
        await tx.execute(
          sql`INSERT INTO action_items(id,tenant_id,action_id,ordinal,resource_ref,task_ref,args,guards,state,external_request_id,idempotency_key) VALUES(${randomUUID()},${fresh.tenant_id},${id},${ordinal},${json(item.resource_ref)},${json(item.task_ref ?? null)},${json(item.args ?? normalizedArgs)},${json(item.guards ?? {})},'prepared',${randomUUID()},${`${parsed.idempotency_key}:${ordinal}`})`,
        );
      await audit(tx, await actionRow(id, tx), 'prepared', {
        args_hash: argsHash,
        resource_count: refs.length,
      });
      return confirmationView(
        await confirmationRow(confirmationId, tx),
        'prepared',
      );
    });
  }
  async function getReview(
    actor: ActorContext,
    id: string,
    source: { channel: 'browser' },
  ): Promise<InteractiveConfirmationReview> {
    if (source?.channel !== 'browser')
      throw new AppError('FORBIDDEN', '模型或连接器不能取得确认凭证。');
    const fresh = await current(actor),
      c = await confirmationRow(id),
      a = await actionRow(c.action_id);
    await binding(fresh, c, !c.confirmed_at);
    await access(
      fresh,
      a,
      database,
      a.state === 'prepared' ? a.operation : 'read',
    );
    await options.assertDependencies?.(fresh, c.dependency_refs);
    if (a.state !== 'prepared')
      return {
        ...confirmationView(c, a.state),
        confirmation_token: null,
        token_expires_at: null,
      };
    const expiry = Math.min(
      now().getTime() + 120000,
      new Date(c.expires_at).getTime(),
    );
    return {
      ...confirmationView(c, a.state),
      confirmation_token: sign(tokenData(c, expiry)),
      token_expires_at: new Date(expiry).toISOString(),
    };
  }
  async function confirmAction(
    actor: ActorContext,
    id: string,
    input: ConfirmInput,
  ): Promise<ActionView> {
    await options.assertAdmission?.(actor);
    const parsed = ConfirmInputSchema.parse(input),
      fresh = await current(actor);
    const actionId = await database.transaction(async (tx) => {
      const c = await confirmationRow(id, tx, true),
        a = await actionRow(c.action_id, tx);
      await binding(fresh, c, !c.confirmed_at);
      await access(fresh, a, tx, c.confirmed_at ? 'read' : a.operation);
      verifyToken(parsed.confirmation_token, c);
      await options.assertDependencies?.(fresh, c.dependency_refs, tx);
      if (parsed.summary_hash !== c.summary_hash)
        throw new AppError('REVALIDATION_REQUIRED', '确认摘要已变化。');
      if (c.confirmed_at) return a.id;
      if (parsed.expected_version !== c.version)
        throw new AppError('VERSION_CONFLICT', '确认版本已变化。');
      if (a.state !== 'prepared')
        throw new AppError('INVALID_STATE', '此动作不能再次确认。');
      // 跨动作/幂等键也不能绕过同一对象的在途或unknown写入。
      for (const ref of [...a.resource_refs].sort((x, y) =>
        `${x.type}:${x.id}`.localeCompare(`${y.type}:${y.id}`),
      )) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${a.tenant_id}:action-resource:${ref.type}:${ref.id}`},0))`,
        );
        const pending = (
          await tx.execute(
            sql`SELECT i.state,a.actor_id,a.id FROM action_items i JOIN actions a ON a.id=i.action_id WHERE i.tenant_id=${a.tenant_id} AND i.action_id<>${a.id} AND i.state IN('confirmed','executing','unknown') AND i.resource_ref->>'type'=${ref.type} AND i.resource_ref->>'id'=${ref.id} LIMIT 1`,
          )
        ).rows[0];
        if (pending)
          throw new AppError(
            pending.state === 'unknown' ? 'OUTCOME_UNKNOWN' : 'INVALID_STATE',
            '此对象已有待核实或执行中的动作，请先查询原回执。',
            {
              details:
                pending.actor_id === a.actor_id
                  ? { action_id: pending.id }
                  : { reason: 'RESOURCE_ACTION_PENDING' },
            },
          );
      }
      await tx.execute(
        sql`UPDATE confirmations SET version=version+1,confirmed_at=${now()},updated_at=now() WHERE id=${id}`,
      );
      await tx.execute(
        sql`UPDATE actions SET state='confirmed',version=version+1,updated_at=now() WHERE id=${a.id}`,
      );
      await tx.execute(
        sql`UPDATE action_items SET state='confirmed',updated_at=now() WHERE action_id=${a.id} AND state='prepared'`,
      );
      await audit(tx, a, 'confirmed');
      return a.id;
    });
    return executeAction(actionId);
  }
  function confirmed(a: Stored, c: Confirmation, item: Item): ConfirmedAction {
    return {
      id: a.id,
      operation: a.operation,
      args: item.args,
      resource_refs: item.resource_ref ? [item.resource_ref] : [],
      item: {
        id: item.id,
        ordinal: item.ordinal,
        resource_ref: item.resource_ref,
        task_ref: item.task_ref,
        args: item.args,
        guards: item.guards,
      },
      confirmation: {
        id: c.id,
        args_hash: c.args_hash,
        summary_hash: c.summary_hash,
        dependency_refs: c.dependency_refs,
        extra_guards: c.extra_guards,
      },
    };
  }
  function context(a: Stored, item: Item, fresh: ActorContext): ActionContext {
    return {
      actor: fresh,
      action_id: a.id,
      item_id: item.id,
      idempotency_key: item.idempotency_key,
      external_request_id: item.external_request_id,
      run_id: a.run_id,
      trace_id: a.trace_id,
      generation: a.generation,
    };
  }
  function outcome(
    ctx: ActionContext,
    item: Item,
    kind: ActionReceipt['outcome'],
    code: string | null,
  ): ActionReceipt {
    return {
      id: randomUUID(),
      action_id: ctx.action_id,
      idempotency_key: ctx.idempotency_key,
      outcome: kind,
      resource: item.resource_ref,
      external_receipt_id: null,
      occurred_at: now().toISOString(),
      data_mode: 'demo',
      error_code: code,
    };
  }
  async function storeReceipt(
    tx: DatabaseExecutor,
    a: Stored,
    item: Item,
    receipt: ActionReceipt,
    kind: string,
  ) {
    if (a.generation !== (await generation()))
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '旧演示环境不能写入动作回执。',
      );
    const checked = ActionReceiptSchema.parse(receipt);
    if (
      checked.action_id !== a.id ||
      checked.idempotency_key !== item.idempotency_key
    )
      throw new AppError('VALIDATION_ERROR', '业务回执与动作绑定不一致。');
    if (
      checked.resource &&
      item.resource_ref &&
      (checked.resource.type !== item.resource_ref.type ||
        checked.resource.id !== item.resource_ref.id)
    )
      throw new AppError('VALIDATION_ERROR', '业务回执对象不一致。');
    await tx.execute(
      sql`INSERT INTO action_receipts(id,tenant_id,action_id,item_id,idempotency_key,outcome,resource,external_receipt_id,occurred_at,data_mode,error_code) VALUES(${checked.id},${a.tenant_id},${a.id},${item.id},${checked.idempotency_key},${checked.outcome},${json(checked.resource)},${checked.external_receipt_id},${new Date(checked.occurred_at)},${checked.data_mode},${checked.error_code}) ON CONFLICT(item_id) DO UPDATE SET outcome=excluded.outcome,resource=excluded.resource,external_receipt_id=excluded.external_receipt_id,occurred_at=excluded.occurred_at,error_code=excluded.error_code,version=action_receipts.version+1,updated_at=now() WHERE action_receipts.outcome='unknown'`,
    );
    await tx.execute(
      sql`UPDATE action_items SET state=${checked.outcome},receipt_id=(SELECT id FROM action_receipts WHERE item_id=${item.id}),version=version+1,updated_at=now() WHERE id=${item.id} AND state IN('executing','unknown','confirmed')`,
    );
    await audit(
      tx,
      a,
      kind,
      { outcome: checked.outcome, error_code: checked.error_code },
      item.id,
    );
  }
  async function refreshState(id: string) {
    await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM actions WHERE id=${id} FOR UPDATE`);
      const a = await actionRow(id, tx),
        items = await itemsOf(id, tx);
      if (a.state === 'prepared' || a.state === 'expired') return;
      let state: ActionState;
      if (items.some((i) => i.state === 'unknown')) state = 'unknown';
      else if (items.some((i) => i.state === 'executing')) state = 'executing';
      else if (items.some((i) => i.state === 'confirmed')) state = 'confirmed';
      else if (items.every((i) => i.state === 'cancelled')) state = 'cancelled';
      else if (items.every((i) => i.state === 'rejected')) state = 'rejected';
      else if (items.every((i) => i.state === 'failed')) state = 'failed';
      else state = 'succeeded'; // 表示逐项处理结束，summary明确保留部分结果。
      if (state !== a.state)
        await tx.execute(
          sql`UPDATE actions SET state=${state},version=version+1,updated_at=now() WHERE id=${id}`,
        );
    });
  }
  async function executeAction(actionId: string): Promise<ActionView> {
    let a = await actionRow(actionId);
    if (terminal.has(a.state) || a.state === 'prepared') return internalView(a);
    const handler = handlerFor(a.operation),
      c = await confirmationRow(a.confirmation_id);
    for (const item of await itemsOf(actionId)) {
      if (item.state !== 'confirmed') continue;
      // 原子领取；已经在途/unknown的项永不再次发出业务命令。
      const claimed = await database.transaction(async (tx) => {
        const result = await tx.execute(
          sql`UPDATE action_items SET state='executing',version=version+1,updated_at=now() WHERE id=${item.id} AND state='confirmed' AND EXISTS(SELECT 1 FROM actions WHERE id=${actionId} AND cancel_requested=false) RETURNING id`,
        );
        if (!result.rows.length) return false;
        await tx.execute(
          sql`UPDATE actions SET state='executing',version=version+1,updated_at=now() WHERE id=${actionId} AND state<>'unknown'`,
        );
        await tx.execute(
          sql`INSERT INTO action_attempts(id,tenant_id,item_id,attempt,kind) SELECT ${randomUUID()},${a.tenant_id},${item.id},COALESCE(MAX(attempt),0)+1,'execute' FROM action_attempts WHERE item_id=${item.id}`,
        );
        await audit(tx, a, 'execution_claimed', {}, item.id);
        return true;
      });
      if (!claimed) continue;
      let fresh = a.actor_context;
      const domainAction = confirmed(a, c, item);
      let sent = false;
      try {
        fresh = await current(a.actor_context);
        if (
          fresh.authz_version !== c.authz_version ||
          (await generation()) !== a.generation
        )
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '执行前权限或环境版本已变化。',
          );
        if (now().getTime() >= new Date(c.expires_at).getTime())
          throw new AppError('CONFIRMATION_EXPIRED', '执行前确认已过期。');
        const executeInTx = async (tx: DatabaseExecutor) => {
          await tx.execute(
            sql`SELECT id FROM action_items WHERE id=${item.id} FOR UPDATE`,
          );
          if (item.resource_ref)
            await options.assertResourceAccess(
              fresh,
              a.operation,
              item.resource_ref,
              tx,
            );
          await options.assertDependencies?.(fresh, c.dependency_refs, tx);
          const validation = await handler.validate(
            fresh,
            item.args,
            domainAction.resource_refs,
            tx,
          );
          const domainDependencies = (refs: DependencyRef[]) =>
            refs.filter(
              (ref) =>
                !options.assertDependencies ||
                !['skill', 'capability'].includes(ref.type),
            );
          if (
            c.dependency_refs.length &&
            hashPayload(
              domainDependencies(validation.dependency_refs ?? []),
            ) !== hashPayload(domainDependencies(c.dependency_refs))
          )
            throw new AppError('REVALIDATION_REQUIRED', '动作依赖版本已变化。');
          if (
            Object.keys(c.extra_guards).length &&
            hashPayload(validation.extra_guards ?? {}) !==
              hashPayload(c.extra_guards)
          )
            throw new AppError('REVALIDATION_REQUIRED', '动作附加守卫已变化。');
          if (
            Object.keys(item.guards).length &&
            hashPayload(
              validation.items?.[0]?.guards ?? validation.extra_guards ?? {},
            ) !== hashPayload(item.guards)
          )
            throw new AppError('REVALIDATION_REQUIRED', '执行项守卫已变化。');
          const result = await handler.execute(
            context(a, item, fresh),
            tx,
            domainAction,
          );
          await storeReceipt(tx, a, item, result, 'executed');
        };
        if (handler.mode === 'remote') {
          if (item.resource_ref)
            await options.assertResourceAccess(
              fresh,
              a.operation,
              item.resource_ref,
            );
          await options.assertDependencies?.(fresh, c.dependency_refs);
          const validation = await handler.validate(
            fresh,
            item.args,
            domainAction.resource_refs,
          );
          const domainDependencies = (refs: DependencyRef[]) =>
            refs.filter(
              (ref) =>
                !options.assertDependencies ||
                !['skill', 'capability'].includes(ref.type),
            );
          if (
            c.dependency_refs.length &&
            hashPayload(
              domainDependencies(validation.dependency_refs ?? []),
            ) !== hashPayload(domainDependencies(c.dependency_refs))
          )
            throw new AppError('REVALIDATION_REQUIRED', '动作依赖版本已变化。');
          if (
            Object.keys(c.extra_guards).length &&
            hashPayload(validation.extra_guards ?? {}) !==
              hashPayload(c.extra_guards)
          )
            throw new AppError('REVALIDATION_REQUIRED', '动作附加守卫已变化。');
          sent = true;
          const receipt = await handler.execute(
            context(a, item, fresh),
            null,
            domainAction,
          );
          await database.transaction((tx) =>
            storeReceipt(tx, a, item, receipt, 'executed'),
          );
        } else await database.transaction(executeInTx);
      } catch (error) {
        const code = knownCode(error),
          knownUncommitted =
            error instanceof AppError &&
            error.details?.effect_not_started === true &&
            guardCode(code),
          uncertain = sent && !knownUncommitted,
          kind = uncertain
            ? 'unknown'
            : guardCode(code)
              ? 'rejected'
              : 'failed';
        await database.transaction((tx) =>
          storeReceipt(
            tx,
            a,
            item,
            outcome(
              context(a, item, fresh),
              item,
              kind,
              uncertain ? 'OUTCOME_UNKNOWN' : code,
            ),
            'execution_failed',
          ),
        );
      }
      await database.execute(
        sql`UPDATE action_attempts SET finished_at=now(),transport_result=(SELECT state FROM action_items WHERE id=${item.id}),reconcile_after=CASE WHEN (SELECT state FROM action_items WHERE id=${item.id})='unknown' THEN now()+interval '2 seconds' ELSE NULL END WHERE item_id=${item.id} AND kind='execute' AND finished_at IS NULL`,
      );
    }
    await refreshState(actionId);
    a = await actionRow(actionId);
    return internalView(a);
  }
  async function getAction(
    actor: ActorContext,
    id: string,
  ): Promise<ActionView> {
    const fresh = await current(actor),
      a = await actionRow(id);
    await access(fresh, a, database, 'read');
    return internalView(a);
  }
  async function reconcileAction(
    actor: ActorContext,
    id: string,
  ): Promise<ActionView> {
    const fresh = await current(actor),
      a = await actionRow(id);
    await access(fresh, a, database, 'read');
    if (a.generation !== (await generation()))
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '旧演示环境不能核实或写入回执。',
      );
    const handler = handlerFor(a.operation),
      c = await confirmationRow(a.confirmation_id);
    for (const item of await itemsOf(id)) {
      if (!['unknown', 'executing'].includes(item.state)) continue;
      // 会话撤权不授予重新发送的权利；queryOutcome仅核实已有稳定请求。
      try {
        const receipt = await handler.queryOutcome(
          context(a, item, fresh),
          confirmed(a, c, item),
        );
        const latest = await current(fresh);
        await access(latest, a, database, 'read');
        await database.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM action_items WHERE id=${item.id} FOR UPDATE`,
          );
          await storeReceipt(tx, a, item, receipt, 'reconciled');
        });
      } catch {
        await audit(database, a, 'reconcile_unavailable', {}, item.id);
      }
    }
    await refreshState(id);
    return internalView(await actionRow(id));
  }
  /** 每个reconcile attempt是一份持久30秒租约；attempt递增作为fencing epoch。仅查询原external_request_id。 */
  async function processNextReconciliation(
    workerId: string,
    scope: { tenant_id?: string; action_id?: string } = {},
  ): Promise<boolean> {
    if (!workerId || workerId.length > 200)
      throw new AppError('VALIDATION_ERROR', '核实Worker标识无效。');
    const claim = await database.transaction(async (tx) => {
      const candidates = (
        await tx.execute(
          sql`SELECT i.id,i.action_id FROM action_items i JOIN actions a ON a.id=i.action_id LEFT JOIN LATERAL(SELECT reconcile_after,started_at FROM action_attempts WHERE item_id=i.id ORDER BY attempt DESC LIMIT 1)t ON true WHERE i.state IN('unknown','executing') AND a.state IN('unknown','executing') AND (${scope.tenant_id ?? null}::text IS NULL OR i.tenant_id=${scope.tenant_id ?? null}) AND (${scope.action_id ?? null}::text IS NULL OR a.id=${scope.action_id ?? null}) AND COALESCE(t.reconcile_after,t.started_at+interval '30 seconds',i.updated_at+interval '30 seconds')<=clock_timestamp() ORDER BY COALESCE(t.reconcile_after,t.started_at+interval '30 seconds',i.updated_at+interval '30 seconds'),i.id LIMIT 20`,
        )
      ).rows;
      for (const candidate of candidates) {
        const lock = (
          await tx.execute(
            sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`action-reconcile:${candidate.id}`},0)) AS locked`,
          )
        ).rows[0];
        if (!lock?.locked) continue;
        const item = (await itemsOf(String(candidate.action_id), tx)).find(
          (i) => i.id === candidate.id,
        );
        if (!item || !['unknown', 'executing'].includes(item.state)) continue;
        const latest = (
          await tx.execute(
            sql`SELECT id,attempt,COALESCE(reconcile_after,started_at+interval '30 seconds')<=clock_timestamp() AS due FROM action_attempts WHERE item_id=${item.id} ORDER BY attempt DESC LIMIT 1`,
          )
        ).rows[0];
        if (latest && !latest.due) continue;
        const a = await actionRow(String(candidate.action_id), tx);
        if (!['unknown', 'executing'].includes(a.state)) continue;
        const stats = (
          await tx.execute(
            sql`SELECT count(*) FILTER(WHERE kind='reconcile')::int count,min(started_at) AS first_at FROM action_attempts WHERE item_id=${item.id}`,
          )
        ).rows[0];
        const id = randomUUID(),
          attempt = Number(latest?.attempt ?? 0) + 1,
          count = Number(stats?.count ?? 0);
        await tx.execute(
          sql`UPDATE action_attempts SET finished_at=clock_timestamp(),transport_result='lease_expired' WHERE item_id=${item.id} AND kind='reconcile' AND finished_at IS NULL AND reconcile_after<=clock_timestamp()`,
        );
        await tx.execute(
          sql`INSERT INTO action_attempts(id,tenant_id,item_id,attempt,kind,reconcile_after) VALUES(${id},${a.tenant_id},${item.id},${attempt},'reconcile',clock_timestamp()+interval '30 seconds')`,
        );
        await audit(
          tx,
          a,
          'reconciliation.claimed',
          { attempt, worker_id: workerId },
          item.id,
        );
        return { id, attempt, count, a, item };
      }
      return null;
    });
    if (!claim) return false;
    const backoff = [2000, 5000, 15000, 30000, 60000, 300000],
      delay = backoff[Math.min(claim.count + 1, backoff.length - 1)]!;
    const assertLease = async (tx: DatabaseExecutor) => {
      const live = (
        await tx.execute(
          sql`SELECT id FROM action_attempts WHERE id=${claim.id} AND item_id=${claim.item.id} AND kind='reconcile' AND finished_at IS NULL AND reconcile_after>clock_timestamp() AND attempt=(SELECT max(attempt) FROM action_attempts WHERE item_id=${claim.item.id}) FOR UPDATE`,
        )
      ).rows[0];
      if (!live)
        throw new AppError('INVALID_STATE', '动作核实租约已失效。', {
          details: { reason: 'LEASE_LOST' },
        });
    };
    const escalate = async (tx: DatabaseExecutor) => {
      const overdue = (
        await tx.execute(
          sql`SELECT min(started_at)<=clock_timestamp()-interval '15 minutes' AS overdue FROM action_attempts WHERE item_id=${claim.item.id}`,
        )
      ).rows[0];
      if (
        overdue?.overdue &&
        !(
          await tx.execute(
            sql`SELECT id FROM action_audit WHERE action_id=${claim.a.id} AND item_id=${claim.item.id} AND event_type='reconciliation.manual_required' LIMIT 1`,
          )
        ).rows.length
      )
        await audit(
          tx,
          claim.a,
          'reconciliation.manual_required',
          { reason: 'OUTCOME_STILL_UNKNOWN', attempt: claim.attempt },
          claim.item.id,
        );
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fresh = await current(claim.a.actor_context);
      await access(fresh, claim.a, database, 'read');
      if (
        fresh.authz_version !== claim.a.actor_context.authz_version ||
        claim.a.generation !== (await generation())
      )
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '核实动作的权限或环境已变化。',
        );
      const c = await confirmationRow(claim.a.confirmation_id),
        handler = handlerFor(claim.a.operation);
      const receipt = await Promise.race([
        handler.queryOutcome(
          context(claim.a, claim.item, fresh),
          confirmed(claim.a, c, claim.item),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError('DEPENDENCY_UNAVAILABLE', '原动作回执查询超时。'),
              ),
            Math.min(
              15000,
              Math.max(10, options.reconciliationTimeoutMs ?? 10000),
            ),
          );
        }),
      ]);
      clearTimeout(timer);
      const latest = await current(fresh);
      await access(latest, claim.a, database, 'read');
      if (
        latest.authz_version !== fresh.authz_version ||
        claim.a.generation !== (await generation())
      )
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '回执查询期间权限或环境已变化。',
        );
      await database.transaction(async (tx) => {
        await assertLease(tx);
        const identity = (
          await tx.execute(
            sql`SELECT authz_version,state FROM identities WHERE tenant_id=${latest.tenant_id} AND id=${latest.user_id} FOR SHARE`,
          )
        ).rows[0];
        if (
          !identity ||
          identity.state !== 'active' ||
          Number(identity.authz_version) !== latest.authz_version
        )
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '核实结果提交前权限已变化。',
          );
        await storeReceipt(tx, claim.a, claim.item, receipt, 'reconciled');
        await tx.execute(
          sql`UPDATE action_attempts SET finished_at=clock_timestamp(),transport_result=${receipt.outcome},reconcile_after=CASE WHEN ${receipt.outcome}='unknown' THEN clock_timestamp()+${delay}*interval '1 millisecond' ELSE NULL END WHERE id=${claim.id}`,
        );
        if (receipt.outcome === 'unknown') await escalate(tx);
      });
      await refreshState(claim.a.id);
    } catch (error) {
      if (error instanceof AppError && error.details?.reason === 'LEASE_LOST')
        return true;
      try {
        await database.transaction(async (tx) => {
          await assertLease(tx);
          await tx.execute(
            sql`UPDATE action_attempts SET finished_at=clock_timestamp(),transport_result=${knownCode(error)},reconcile_after=clock_timestamp()+${delay}*interval '1 millisecond' WHERE id=${claim.id}`,
          );
          await audit(
            tx,
            claim.a,
            'reconciliation.deferred',
            { code: knownCode(error), attempt: claim.attempt },
            claim.item.id,
          );
          await escalate(tx);
        });
      } catch (failure) {
        if (!(
          failure instanceof AppError &&
          failure.details?.reason === 'LEASE_LOST'
        ))
          throw failure;
      }
    } finally {
      clearTimeout(timer);
    }
    return true;
  }
  async function listReconciliation(actor: ActorContext) {
    const fresh = await current(actor);
    if (!fresh.permissions.includes('operations.read'))
      throw new AppError('FORBIDDEN', '无动作核实元数据查看权限。');
    const result = await database.execute(
      sql`SELECT a.id AS action_id,a.operation,a.state,a.trace_id,count(DISTINCT i.id)::int AS pending_items,min(t.started_at) AS first_attempt_at,max(t.finished_at) AS last_attempt_at,bool_or(e.id IS NOT NULL) AS manual_required FROM actions a JOIN action_items i ON i.action_id=a.id LEFT JOIN action_attempts t ON t.item_id=i.id LEFT JOIN action_audit e ON e.action_id=a.id AND e.item_id=i.id AND e.event_type='reconciliation.manual_required' WHERE a.tenant_id=${fresh.tenant_id} AND i.state IN('unknown','executing') GROUP BY a.id ORDER BY min(t.started_at),a.id LIMIT 100`,
    );
    return {
      items: result.rows.map((row) => ({
        action_id: String(row.action_id),
        operation: String(row.operation),
        state: String(row.state),
        trace_id: row.trace_id ? String(row.trace_id) : null,
        pending_items: Number(row.pending_items),
        first_attempt_at: row.first_attempt_at
          ? new Date(row.first_attempt_at as string).toISOString()
          : null,
        last_attempt_at: row.last_attempt_at
          ? new Date(row.last_attempt_at as string).toISOString()
          : null,
        manual_required: Boolean(row.manual_required),
      })),
    };
  }
  async function cancelAction(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
  ): Promise<ActionView> {
    const fresh = await current(actor);
    interactive(fresh);
    await database.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM actions WHERE id=${id} FOR UPDATE`);
      const a = await actionRow(id, tx);
      await access(fresh, a, tx);
      if (terminal.has(a.state)) return;
      if (a.version !== expectedVersion)
        throw new AppError('VERSION_CONFLICT', '动作版本已变化，请刷新。');
      await tx.execute(
        sql`UPDATE actions SET cancel_requested=true,state=CASE WHEN state='prepared' THEN 'cancelled' ELSE state END,version=version+1,updated_at=now() WHERE id=${id}`,
      );
      await tx.execute(
        sql`UPDATE action_items SET state='cancelled',version=version+1,updated_at=now() WHERE action_id=${id} AND state IN('prepared','confirmed')`,
      );
      await audit(tx, a, 'cancel_requested');
    });
    await refreshState(id);
    return internalView(await actionRow(id));
  }
  return {
    registerHandler,
    prepareAction,
    getReview,
    getConfirmationReview: getReview,
    confirmAction,
    executeAction,
    getAction,
    cancelAction,
    reconcileAction,
    processNextReconciliation,
    listReconciliation,
  };
}
export type ActionService = ReturnType<typeof createActionService>;
export type {
  ActionHandler,
  ActionContext,
  ConfirmedAction,
  PreparedDomainAction,
  PreparedActionItem,
} from '@caixiaozhi/business-adapters/ports';
