import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  DEMO_SEED_VERSION,
  DemoManifestSchema,
} from '@caixiaozhi/contracts/demo';
import {
  TravelDraftSchema,
  TravelOperationSchema,
} from '@caixiaozhi/contracts/travel';
import {
  ExpenseDraftSchema,
  InvoiceFieldsSchema,
} from '@caixiaozhi/contracts/expenses';
import {
  PreauditTaskAcceptedSchema,
  type PreauditTaskView,
} from '@caixiaozhi/contracts/preaudit';
import {
  ResourceRefSchema,
  type ResourceRef,
} from '@caixiaozhi/contracts/common';
import {
  ActionViewSchema,
  type ActionName,
} from '@caixiaozhi/contracts/actions';

export const DEMO_JOURNEY_IDS = [
  'E2E-01',
  'E2E-02',
  'E2E-03',
  'E2E-04',
  'E2E-05',
  'E2E-06',
  'E2E-07',
  'E2E-08',
] as const;
export type DemoJourneyId = (typeof DEMO_JOURNEY_IDS)[number];
type Json = Record<string, unknown>;
export type DemoJourneyEvidence = {
  step_id: string;
  passed: boolean;
  trace_id: string;
  resource_refs: ResourceRef[];
  occurred_at: string;
  request?: { method: string; path: string; body?: unknown };
  response?: { status: number; data: unknown };
  assertion?: { expected: unknown; actual: unknown };
};
export type DemoJourneyBaseline = {
  scenario_id: DemoJourneyId;
  reset_job_id: string;
  previous_generation: number;
  generation: number;
  environment_id: string;
  manifest_hash: string;
  evidence: DemoJourneyEvidence[];
};
export type DemoJourneyReport = {
  id: string;
  scenario_id: DemoJourneyId;
  status: 'succeeded' | 'failed' | 'blocked';
  started_at: string;
  finished_at: string;
  baseline: DemoJourneyBaseline | null;
  evidence: DemoJourneyEvidence[];
  error: { code: string; message: string } | null;
};
export type DemoJourneyRunnerOptions = {
  /** 正式 API 地址；不接受跳过身份或 CSRF 的选项。 */
  baseUrl: string;
  origin?: string;
  fetch?: typeof globalThis.fetch;
  loadInvoiceFixture: (
    name: 'invoice_transport_demo.pdf' | 'invoice_ambiguous_demo.pdf',
  ) => Promise<Uint8Array>;
  onEvidence?: (evidence: DemoJourneyEvidence) => Promise<void>;
  saveReport?: (report: DemoJourneyReport) => Promise<void>;
  heartbeat?: () => Promise<void>;
  timeoutMs?: number;
  journeyTimeoutMs?: number;
  signal?: AbortSignal;
};
class JourneyFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly blocked = false,
  ) {
    super(message);
  }
}
const object = (value: unknown): Json =>
  z.record(z.string(), z.unknown()).parse(value);
const array = (value: unknown): Json[] =>
  z.array(z.record(z.string(), z.unknown())).parse(value);
const text = (value: unknown): string => z.string().min(1).parse(value);
const integer = (value: unknown): number => z.number().int().parse(value);
const ref = (value: unknown): ResourceRef =>
  ResourceRefSchema.parse(object(value).resource_ref ?? value);
const money = (value: unknown): string => text(object(value).amount_minor);
const same = isDeepStrictEqual;
const clean = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/token|cookie|secret|authorization/i.test(key))
      .map(([key, entry]) => [key, clean(entry)]),
  );
};
function resourceRefs(value: unknown): ResourceRef[] {
  const refs = new Map<string, ResourceRef>();
  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const parsed = ResourceRefSchema.safeParse(entry);
    if (parsed.success)
      refs.set(
        `${parsed.data.type}:${parsed.data.id}@${parsed.data.version}`,
        parsed.data,
      );
    if (Array.isArray(entry)) for (const item of entry) visit(item);
    else for (const item of Object.values(entry)) visit(item);
  };
  visit(value);
  return [...refs.values()];
}
type Session = {
  actorId: string;
  cookie: string;
  csrf: string;
  generation: number;
  environmentId: string;
};

/**
 * 八条真实 API 旅程。run 自行 reset；控制面 Worker 可先 resetBaseline，
 * 在新 generation 创建执行任务后再 execute。所有证据均来自 HTTP 回执或明确断言。
 */
export function createDemoJourneyRunner(options: DemoJourneyRunnerOptions) {
  const origin = options.origin ?? new URL(options.baseUrl).origin;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const consumedBaselines = new Set<string>();
  let active = false;
  let resetting = false;
  let journeySignal: AbortSignal | null = null;
  let evidence: DemoJourneyEvidence[] = [];
  let sequence = 0;
  async function emit(entry: Omit<DemoJourneyEvidence, 'occurred_at'>) {
    const completed = { ...entry, occurred_at: new Date().toISOString() };
    evidence.push(completed);
    await options.onEvidence?.(completed);
  }
  async function pulse() {
    options.signal?.throwIfAborted();
    if (journeySignal?.aborted)
      throw new JourneyFailure(
        'JOURNEY_TIMEOUT',
        '旅程已超出总执行时限。',
        true,
      );
    await options.heartbeat?.();
  }
  async function check(
    step: string,
    expected: unknown,
    actual: unknown,
    refs: ResourceRef[] = [],
  ) {
    const passed = same(expected, actual);
    await emit({
      step_id: step,
      passed,
      trace_id: `assertion:${randomUUID()}`,
      resource_refs: refs,
      assertion: { expected, actual },
    });
    if (!passed)
      throw new JourneyFailure(
        'ASSERTION_FAILED',
        `${step}：实际结果不符合验收断言。`,
      );
  }
  async function request(
    session: Session | null,
    method: string,
    path: string,
    body?: unknown,
    expected = [200, 201, 202],
    extraHeaders: Record<string, string> = {},
    raw = false,
  ) {
    await pulse();
    const headers: Record<string, string> = { origin, ...extraHeaders };
    if (session?.cookie) headers.cookie = session.cookie;
    if (method !== 'GET') {
      headers['idempotency-key'] = randomUUID();
      if (session?.csrf) headers['x-csrf-token'] = session.csrf;
      if (!raw) headers['content-type'] = 'application/json';
    }
    const requestSignal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      ...(journeySignal ? [journeySignal] : []),
      AbortSignal.timeout(Math.min(timeoutMs, 60_000)),
    ]);
    let response: Awaited<ReturnType<typeof fetcher>>;
    try {
      response = await fetcher(new URL(path, options.baseUrl), {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : raw
              ? Buffer.from(z.instanceof(Uint8Array).parse(body))
              : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      const code = requestSignal.aborted
        ? 'HTTP_ABORTED_OR_TIMEOUT'
        : 'HTTP_NETWORK_ERROR';
      await emit({
        step_id: `http-${++sequence}`,
        passed: false,
        trace_id: `transport:${randomUUID()}`,
        resource_refs: [],
        request: { method, path },
        response: { status: 0, data: { code } },
      });
      throw new JourneyFailure(
        code,
        `${method} ${path} 未取得HTTP回执。`,
        true,
      );
    }
    if (session) {
      const values =
        response.headers.getSetCookie?.() ??
        (response.headers.get('set-cookie')
          ? [response.headers.get('set-cookie')!]
          : []);
      const setCookie = values.find((value) =>
        /(?:__Host-)?caixiaozhi_session=/.test(value),
      );
      if (setCookie) session.cookie = setCookie.split(';')[0]!;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const payload: unknown = contentType.includes('json')
      ? await response.json()
      : {
          binary_sha256: createHash('sha256')
            .update(new Uint8Array(await response.arrayBuffer()))
            .digest('hex'),
        };
    const envelope = object(payload);
    const data = envelope.data ?? payload;
    const meta =
      envelope.meta && typeof envelope.meta === 'object'
        ? object(envelope.meta)
        : {};
    const traceId =
      typeof meta.trace_id === 'string'
        ? meta.trace_id
        : (response.headers.get('x-request-id') ?? `http:${randomUUID()}`);
    const refs = resourceRefs([data, raw ? null : body]);
    await emit({
      step_id: `http-${++sequence}`,
      passed: expected.includes(response.status),
      trace_id: traceId,
      resource_refs: refs,
      request: {
        method,
        path,
        body: raw
          ? {
              size_bytes: (body as Uint8Array).byteLength,
              sha256: createHash('sha256')
                .update(body as Uint8Array)
                .digest('hex'),
            }
          : clean(body),
      },
      response: { status: response.status, data: clean(data) },
    });
    if (!expected.includes(response.status)) {
      const error =
        envelope.error && typeof envelope.error === 'object'
          ? object(envelope.error)
          : {};
      const code =
        typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
      throw new JourneyFailure(
        code,
        typeof error.message === 'string'
          ? error.message
          : `${method} ${path} 返回 ${response.status}。`,
        ['DEPENDENCY_UNAVAILABLE', 'SERVICE_UNAVAILABLE'].includes(code),
      );
    }
    return object(data);
  }
  async function login(actorId: string): Promise<Session> {
    const identities = await request(
      null,
      'GET',
      '/api/v1/auth/demo/identities',
    );
    const session: Session = {
      actorId,
      cookie: '',
      csrf: '',
      generation: integer(identities.generation),
      environmentId: text(identities.demo_environment_id),
    };
    const loggedIn = await request(session, 'POST', '/api/v1/auth/demo/login', {
      selected_user_id: actorId,
      demo_environment_id: session.environmentId,
      generation: session.generation,
    });
    session.csrf = text(loggedIn.csrf_token);
    if (!session.cookie)
      throw new JourneyFailure(
        'SESSION_COOKIE_MISSING',
        '正式登录没有返回会话 Cookie。',
      );
    return session;
  }
  async function poll<T>(
    name: string,
    read: () => Promise<T>,
    state: (value: T) => string,
    done: string[],
    failed = ['failed', 'cancelled', 'partial_failed', 'stale', 'blocked'],
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      const current = state(value);
      if (done.includes(current)) return value;
      if (failed.includes(current)) {
        const record =
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : {};
        const task =
          record.task && typeof record.task === 'object'
            ? (record.task as Record<string, unknown>)
            : {};
        const dependencyCode = record.error_code ?? task.error_code;
        const dependencyBlocked =
          dependencyCode === 'DEPENDENCY_UNAVAILABLE' ||
          dependencyCode === 'MODEL_NOT_CONFIGURED';
        throw new JourneyFailure(
          dependencyBlocked
            ? String(dependencyCode)
            : `${name.toUpperCase()}_${current.toUpperCase()}`,
          `${name} 返回 ${current}，已保留真实回执。`,
          current === 'blocked' || dependencyBlocked,
        );
      }
      await pulse();
      await delay(500, undefined, { signal: options.signal });
    }
    throw new JourneyFailure(
      'JOURNEY_TIMEOUT',
      `${name} 在限定时间内没有完成。`,
      true,
    );
  }
  async function environment(admin: Session) {
    return request(admin, 'GET', '/api/v1/demo/environments/current');
  }
  const guard = (env: Json) => ({
    expected_generation: integer(env.generation),
    expected_environment_version: integer(env.version),
  });
  async function verifyBaseline(admin: Session, baseline: DemoJourneyBaseline) {
    const resetProof = await request(
      admin,
      'GET',
      `/api/v1/demo/reset-jobs/${baseline.reset_job_id}`,
    );
    await check('基线绑定已完成受控重置', 'succeeded', resetProof.state);
    await check(
      '重置回执锁定前后generation',
      [baseline.previous_generation, baseline.generation],
      [resetProof.old_generation, resetProof.new_generation],
    );
    await check(
      '重置场景对应本条旅程',
      baseline.scenario_id === 'E2E-04' ? 'rule-creation' : 'baseline',
      resetProof.scenario_id,
    );
    const env = await environment(admin);
    await check(
      '新 generation 与重置回执一致',
      baseline.generation,
      env.generation,
    );
    await check(
      '重置产生新 generation',
      true,
      baseline.generation > baseline.previous_generation,
    );
    await check('环境已就绪', 'ready', env.lifecycle);
    const manifestReply = await request(admin, 'GET', '/api/v1/demo/manifest');
    const manifest = DemoManifestSchema.parse(manifestReply.manifest);
    await check(
      '基线七人十一单',
      { users: 7, claims: 11 },
      manifest.expected_counts,
    );
    await check(
      '基线所有完整性断言通过',
      true,
      manifest.assertions.length >= 6 &&
        manifest.assertions.every((item) => item.passed),
    );
    await check(
      '基线 manifest 摘要一致',
      baseline.manifest_hash,
      env.manifest_hash,
    );
    const manager = await login('u-zhang');
    const approvals = await request(
      manager,
      'GET',
      '/api/v1/approvals?limit=100',
    );
    const claims = array(approvals.items).filter(
      (item) => ref(item.document).type === 'expense_claim',
    );
    await check('销售五张基线待办', 5, claims.length);
    await check(
      '销售基线待办版本均为1',
      true,
      claims.every((item) => ref(item.document).version === 1),
    );
    await check(
      '销售基线待办合计554000分',
      '554000',
      claims
        .reduce(
          (sum, item) =>
            sum + BigInt(money(object(item.document).total_amount)),
          0n,
        )
        .toString(),
    );
    const snapshot = await analysis(manager, 'expense.completed_amount');
    await check('销售完成基线590000分', '590000', money(snapshot.total));
  }
  async function resetBaseline(
    scenarioId: DemoJourneyId,
  ): Promise<DemoJourneyBaseline> {
    if (active || resetting)
      throw new JourneyFailure(
        'RUNNER_BUSY',
        '同一runner已有正在执行的旅程或重置。',
      );
    resetting = true;
    journeySignal = AbortSignal.timeout(
      options.journeyTimeoutMs ?? 15 * 60_000,
    );
    evidence = [];
    sequence = 0;
    try {
      const admin = await login('u-zhao');
      const prior = await environment(admin);
      const reset = await request(admin, 'POST', '/api/v1/demo/reset', {
        ...guard(prior),
        seed_version: DEMO_SEED_VERSION,
        scenario_id: scenarioId === 'E2E-04' ? 'rule-creation' : 'baseline',
        intent: 'reset_demo_environment',
      });
      const resetId = text(reset.id);
      let currentAdmin = admin;
      const completed = await poll(
        'reset',
        async () => {
          try {
            return await request(
              currentAdmin,
              'GET',
              `/api/v1/demo/reset-jobs/${resetId}`,
            );
          } catch (error) {
            if (
              !(error instanceof JourneyFailure) ||
              !['REVALIDATION_REQUIRED', 'UNAUTHENTICATED'].includes(error.code)
            )
              throw error;
            currentAdmin = await login('u-zhao');
            return request(
              currentAdmin,
              'GET',
              `/api/v1/demo/reset-jobs/${resetId}`,
            );
          }
        },
        (value) => text(value.state),
        ['completed', 'succeeded'],
      );
      currentAdmin = await login('u-zhao');
      const env = await environment(currentAdmin);
      const baseline: DemoJourneyBaseline = {
        scenario_id: scenarioId,
        reset_job_id: resetId,
        previous_generation: integer(prior.generation),
        generation: integer(completed.new_generation),
        environment_id: text(env.id),
        manifest_hash: text(env.manifest_hash),
        evidence: [],
      };
      await verifyBaseline(currentAdmin, baseline);
      baseline.evidence = [...evidence];
      return baseline;
    } finally {
      resetting = false;
    }
  }
  async function action(
    session: Session,
    operation: ActionName,
    refs: ResourceRef[],
    args: unknown = {},
  ) {
    const prepared = await request(session, 'POST', '/api/v1/confirmations', {
      action: operation,
      resource_refs: refs,
      args,
    });
    const review = await request(
      session,
      'GET',
      `/api/v1/confirmations/${text(prepared.confirmation_id)}`,
    );
    await request(
      session,
      'POST',
      `/api/v1/confirmations/${text(prepared.confirmation_id)}/confirm`,
      {
        expected_version: integer(review.version),
        summary_hash: text(review.summary_hash),
        confirmation_token: text(review.confirmation_token),
      },
    );
    const result = await poll(
      'action',
      () =>
        request(session, 'GET', `/api/v1/actions/${text(prepared.action_id)}`),
      (value) => text(value.state),
      ['succeeded'],
      ['failed', 'rejected', 'cancelled', 'unknown', 'expired'],
    );
    const parsed = ActionViewSchema.parse(result);
    await check(
      `${operation}逐项真实成功回执`,
      true,
      parsed.items.length === refs.length &&
        parsed.items.every((item) => item.receipt?.outcome === 'succeeded'),
      refs,
    );
    return parsed;
  }
  async function analysis(
    session: Session,
    metric = 'expense.category_completed_amount',
    dimensions: string[] = [],
    expenseTypes?: string[],
  ) {
    const queued = await request(session, 'POST', '/api/v1/analytics/queries', {
      metric,
      period: {
        from: '2026-11-01',
        to_exclusive: '2026-11-06',
        timezone: 'Asia/Shanghai',
        date_basis: 'completed_at',
      },
      dimensions,
      filters: {
        scope: 'department',
        ...(expenseTypes ? { expense_types: expenseTypes } : {}),
      },
    });
    const query = await poll(
      'analytics',
      () =>
        request(
          session,
          'GET',
          `/api/v1/analytics/queries/${text(queued.request_id)}`,
        ),
      (value) => text(value.status),
      ['ready', 'empty', 'degraded'],
    );
    return request(
      session,
      'GET',
      `/api/v1/analytics/snapshots/${text(query.snapshot_id)}`,
    );
  }
  async function conversation(
    session: Session,
    prompt: string,
    selectedSkill?: string,
  ) {
    const created = await request(session, 'POST', '/api/v1/threads', {
      title: `正式旅程-${randomUUID().slice(0, 8)}`,
      initial_message: null,
    });
    const thread = object(created.thread ?? created);
    const accepted = await request(
      session,
      'POST',
      `/api/v1/threads/${text(thread.id)}/messages`,
      {
        content: prompt,
        client_message_id: randomUUID(),
        intent: 'new_task',
        expected_version: integer(thread.version),
        resource_refs: [],
        attachment_ids: [],
        ...(selectedSkill ? { selected_skill_version_id: selectedSkill } : {}),
      },
    );
    const runId = text(accepted.run_id);
    const run = await poll(
      'agent',
      () => request(session, 'GET', `/api/v1/runs/${runId}`),
      (value) => text(value.status),
      ['succeeded'],
      ['failed', 'cancelled', 'waiting_user', 'waiting_confirmation'],
    );
    await check(
      '真实模型调用已有计量',
      true,
      integer(object(run.usage).model_calls) > 0,
    );
    const snapshot = await request(
      session,
      'GET',
      `/api/v1/threads/${text(thread.id)}/snapshot`,
    );
    return { run, runId, threadId: text(thread.id), snapshot };
  }
  async function preaudit(
    session: Session,
    refs: ResourceRef[],
    purpose: 'employee_precheck' | 'manager_review' | 'finance_review',
  ) {
    const started = PreauditTaskAcceptedSchema.parse(
      await request(session, 'POST', '/api/v1/preaudit/tasks', {
        purpose,
        documents: refs,
      }),
    );
    return poll(
      'preaudit',
      async () =>
        (await request(
          session,
          'GET',
          `/api/v1/preaudit/tasks/${started.task_id}`,
        )) as unknown as PreauditTaskView,
      (value) => value.task.status,
      ['completed'],
    );
  }
  async function journey01() {
    const li = await login('u-li');
    const conversationResult = await conversation(
      li,
      '请依据当前授权制度查询：2026-11-10至2026-11-13去杭州，住宿标准是多少？重要结论附来源。',
    );
    const question = await request(li, 'POST', '/api/v1/knowledge/questions', {
      query: '杭州 住宿 标准',
      business_date: '2026-11-10',
      context: {
        module: 'expense_claim',
        category: 'lodging',
        city_code: '330100',
        travel_start: '2026-11-10',
        travel_end: '2026-11-13',
      },
      top_k: 6,
      origin_run_id: conversationResult.runId,
    });
    await check('问答由真实模型生成并校验', 'answered', question.answer_state);
    await check(
      '问答服务端模型版本已记录',
      true,
      typeof question.model_version === 'string' &&
        question.model_version.length > 0,
    );
    const blocks = array(question.answer_blocks);
    await check(
      '回答包含800元间夜及引用',
      true,
      blocks.some(
        (block) =>
          /800/.test(text(block.text)) &&
          /间.*夜/.test(text(block.text)) &&
          z.array(z.string()).parse(block.citation_ids).length > 0,
      ),
    );
    const citations = z.array(z.string()).parse(question.citation_ids);
    await check('有可打开的来源', true, citations.length > 0);
    for (const id of citations) {
      const citation = await request(
        li,
        'GET',
        `/api/v1/knowledge/citations/${id}`,
      );
      await check(
        '引用含制度版本及定位',
        true,
        !!citation.policy_ref && !!citation.locator,
        [ref(citation.policy_ref)],
      );
    }
    const followup = await request(li, 'POST', '/api/v1/knowledge/questions', {
      query:
        '杭州住宿超过800元间夜应当如何处理？如没有制度依据请明确无法确定，勿编造例外。',
      business_date: '2026-11-10',
      context: {
        module: 'expense_claim',
        category: 'lodging',
        city_code: '330100',
      },
      origin_run_id: conversationResult.runId,
    });
    await check(
      '追问只含授权来源块',
      true,
      array(followup.answer_blocks).every(
        (block) => z.array(z.string()).parse(block.citation_ids).length > 0,
      ),
    );
    const sun = await login('u-sun');
    await request(
      sun,
      'GET',
      `/api/v1/knowledge/questions/${text(question.question_id)}`,
      undefined,
      [404],
    );
    // 基准制度面向四部门；另建销售限定来源，验证真实的组织授权拒绝。
    const maintainer = await login('u-liu');
    const sourceBytes = Buffer.from(
      '# 销售限定来源\n本合成来源的专用代号为销售隔离凭证，仅销售部可检索。\n',
      'utf8',
    );
    const registered = await request(maintainer, 'POST', '/api/v1/files', {
      filename: 'journey-sales-policy.txt',
      mime_type: 'text/plain',
      size_bytes: sourceBytes.byteLength,
      profile: 'policy-text-v1',
    });
    const sourceFile = object(registered.file),
      uploadTarget = object(registered.upload_target);
    const uploaded = await request(
      maintainer,
      'PUT',
      text(uploadTarget.url),
      sourceBytes,
      [200],
      z.record(z.string(), z.string()).parse(uploadTarget.headers),
      true,
    );
    await request(
      maintainer,
      'POST',
      `/api/v1/files/${text(sourceFile.id)}/finalize`,
      {
        expected_version: uploaded.version,
        sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      },
    );
    const policyId = `journey-sales-${randomUUID()}`;
    const policy = await request(
      maintainer,
      'POST',
      '/api/v1/knowledge/policies',
      {
        policy_id: policyId,
        policy_code: policyId,
        title: '销售限定演示来源',
        source_file_id: sourceFile.id,
        organization_ids: ['dept-sales'],
        effective_from: '2026-01-01',
        effective_to: null,
        topic_tags: ['销售隔离凭证'],
        supersedes_version_id: null,
      },
    );
    await poll(
      'policy_import',
      () =>
        request(
          maintainer,
          'GET',
          `/api/v1/knowledge/imports/${text(policy.import_id)}`,
        ),
      (value) => text(value.stage),
      ['ready'],
    );
    await action(
      maintainer,
      'policy.publish',
      [{ type: 'policy', id: policyId, version: integer(policy.version_no) }],
      { policy_id: policyId, version_id: policy.version_id },
    );
    const authorizedSource = await request(
      li,
      'POST',
      '/api/v1/knowledge/search',
      { query: '销售隔离凭证', business_date: '2026-11-10', top_k: 10 },
    );
    const privateCitation = array(authorizedSource.hits).find(
      (hit) => object(hit.policy_ref).id === policyId,
    );
    await check('销售限定来源本人可检索', true, !!privateCitation);
    if (!privateCitation)
      throw new JourneyFailure(
        'SOURCE_MISSING',
        '销售限定来源未产生可验证引用。',
      );
    await request(
      li,
      'GET',
      `/api/v1/knowledge/citations/${text(privateCitation.citation_id)}`,
    );
    await request(
      sun,
      'GET',
      `/api/v1/knowledge/citations/${text(privateCitation.citation_id)}`,
      undefined,
      [404],
    );
    const unauthorizedSearch = await request(
      sun,
      'POST',
      '/api/v1/knowledge/search',
      { query: '销售隔离凭证', business_date: '2026-11-10', top_k: 10 },
    );
    await check(
      '孙静检索不召回未授权来源',
      false,
      array(unauthorizedSearch.hits).some(
        (hit) => object(hit.policy_ref).id === policyId,
      ),
    );
  }
  async function journey02() {
    const li = await login('u-li'),
      source = await request(li, 'GET', '/api/v1/travel/trv-001');
    const draft = TravelDraftSchema.parse(
      Object.fromEntries(
        Object.keys(TravelDraftSchema.shape).map((key) => [key, source[key]]),
      ),
    );
    const saved = await request(li, 'PATCH', '/api/v1/travel/trv-001', {
      ...draft,
      legs: draft.legs.map((leg, index) =>
        index === 0 ? { ...leg, departure_date: '2026-11-09' } : leg,
      ),
      expected_version: integer(source.version),
    });
    await check('手改保存v2', 2, saved.version, [ref(saved)]);
    const queued = await request(
      li,
      'POST',
      '/api/v1/travel/trv-001/proposals',
      {
        expected_version: integer(saved.version),
        prompt:
          '返程改到2026年11月13号，其他不变。仅修改返程end_date，不能改变我手改的出发日期、预算、行程ID或住宿日期。',
        selected_material_refs: [],
      },
    );
    const proposal = await poll(
      'travel_proposal',
      () =>
        request(
          li,
          'GET',
          `/api/v1/travel/trv-001/proposals/${text(queued.proposal_id)}`,
        ),
      (value) => text(value.status),
      ['proposed'],
    );
    const operations = z
      .array(TravelOperationSchema)
      .parse(proposal.operations);
    await check(
      '真实模型只建议返程日期',
      true,
      operations.length > 0 &&
        operations.every(
          (operation) =>
            operation.kind === 'replace' &&
            operation.field === 'end_date' &&
            operation.new === '2026-11-13',
        ),
    );
    const applied = await request(
      li,
      'POST',
      `/api/v1/travel/trv-001/proposals/${text(queued.proposal_id)}/apply`,
      {
        expected_version: 2,
        selected_operation_ids: operations.map((operation) => operation.id),
      },
    );
    await check('明确采纳保存v3', 3, applied.version, [ref(applied)]);
    await check(
      '手改出发日期保留',
      '2026-11-09',
      array(applied.legs)[0]?.departure_date,
    );
    await check(
      '行程稳定ID保留',
      array(saved.legs).map((leg) => leg.leg_id),
      array(applied.legs).map((leg) => leg.leg_id),
    );
    await request(
      li,
      'POST',
      `/api/v1/travel/trv-001/proposals/${text(queued.proposal_id)}/apply`,
      {
        expected_version: 2,
        selected_operation_ids: operations.map((operation) => operation.id),
      },
      [409],
    );
    await action(li, 'travel.submit', [ref(applied)]);
    const manager = await login('u-zhang'),
      pending = await request(manager, 'GET', '/api/v1/travel/trv-001');
    const task = array(pending.approval_tasks).find(
      (task) => task.state === 'pending' && task.assigned_to === 'u-zhang',
    );
    if (!task)
      throw new JourneyFailure('TASK_MISSING', '张伟没有收到同一差旅的待办。');
    await action(manager, 'approval.approve', [ref(pending)], {
      task_ref: { id: task.id, version: task.version },
      reason: '正式旅程已核对最新行程。',
    });
    const approved = await request(li, 'GET', '/api/v1/travel/trv-001');
    await check('同ID差旅已批准', 'approved', approved.state, [ref(approved)]);
  }
  async function uploadInvoice(
    session: Session,
    name: 'invoice_transport_demo.pdf' | 'invoice_ambiguous_demo.pdf',
    type: 'transport' | 'meals',
  ) {
    const bytes = await options.loadInvoiceFixture(name),
      registered = await request(session, 'POST', '/api/v1/files', {
        filename: name,
        mime_type: 'application/pdf',
        size_bytes: bytes.byteLength,
        profile: 'invoice-v1',
      });
    const file = object(registered.file),
      target = object(registered.upload_target);
    const uploaded = await request(
      session,
      'PUT',
      text(target.url),
      bytes,
      [200],
      z.record(z.string(), z.string()).parse(target.headers),
      true,
    );
    const validated = await request(
      session,
      'POST',
      `/api/v1/files/${text(file.id)}/finalize`,
      {
        expected_version: integer(uploaded.version),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    );
    const queued = await request(
      session,
      'POST',
      '/api/v1/expenses/ocr-tasks',
      { file_id: text(file.id), file_version: integer(validated.version) },
    );
    const task = await poll(
      'ocr',
      () =>
        request(
          session,
          'GET',
          `/api/v1/expenses/ocr-tasks/${text(queued.task_id ?? queued.id)}`,
        ),
      (value) => text(value.state ?? value.status),
      ['completed'],
    );
    const recognized = array(task.invoices);
    await check('每份样票仅识别一张票', 1, recognized.length);
    const invoice = await request(
      session,
      'GET',
      `/api/v1/expenses/invoices/${text(recognized[0]?.id)}`,
    );
    const fields = InvoiceFieldsSchema.parse({
      ...object(invoice.fields),
      expense_type: type,
    });
    await check(
      `${name}原金额`,
      type === 'transport' ? '18000' : '20000',
      fields.gross_amount?.amount_minor,
    );
    await check(
      `${name}原消费日`,
      type === 'transport' ? '2026-11-03' : '2026-11-04',
      fields.invoice_date,
    );
    const confirmed = await request(
      session,
      'POST',
      `/api/v1/expenses/invoices/${text(invoice.id)}/confirm`,
      {
        expected_version: integer(invoice.version),
        fields,
        expense_type: type,
        expense_subtype: type === 'meals' ? 'business_entertainment' : null,
      },
    );
    await check('票面已明确确认', 'confirmed', confirmed.confirmation_state);
    return confirmed;
  }
  async function journey03() {
    const li = await login('u-li'),
      transport = await uploadInvoice(
        li,
        'invoice_transport_demo.pdf',
        'transport',
      ),
      meals = await uploadInvoice(li, 'invoice_ambiguous_demo.pdf', 'meals');
    const oa = await request(li, 'GET', '/api/v1/oa/entertainment/oa-001');
    await check(
      'OA原可用30000分',
      '30000',
      money(object(oa.budget_usage).available),
    );
    const claim = await request(li, 'POST', '/api/v1/expenses/claims', {
      title: '正式旅程两票报销',
    });
    const draft = ExpenseDraftSchema.parse({
      title: '正式旅程两票报销',
      purpose: '合成交通与业务招待',
      cost_center_id: 'cc-sales',
      material_refs: [],
      items: [transport, meals].map((invoice, index) => ({
        item_id: `new:${index}`,
        invoice_id: text(invoice.id),
        invoice_version: integer(invoice.version),
        expense_type: index === 0 ? 'transport' : 'meals',
        expense_subtype: index === 0 ? null : 'business_entertainment',
        type_confirmation: 'confirmed',
        incurred_date: object(invoice.fields).invoice_date,
        claim_amount: object(invoice.fields).gross_amount,
        reduction_reason: null,
        travel_ref: null,
        oa_ref: index === 0 ? null : ref(oa),
        lodging_details: null,
        transport_details: null,
      })),
    });
    const saved = await request(
      li,
      'PATCH',
      `/api/v1/expenses/claims/${text(claim.id)}`,
      { ...draft, expected_version: integer(claim.version) },
    );
    await check('两票一票一行合计38000分', '38000', money(saved.total_amount), [
      ref(saved),
    ]);
    await check(
      '两票没有重复计费',
      2,
      new Set(array(saved.items).map((item) => item.invoice_id)).size,
    );
    const refreshed = await request(
      li,
      'GET',
      `/api/v1/expenses/claims/${text(claim.id)}`,
    );
    await check('刷新读取同一保存版本', saved.version, refreshed.version, [
      ref(refreshed),
    ]);
    const checked = await preaudit(li, [ref(saved)], 'employee_precheck');
    await check(
      '预审只接结构化单据',
      true,
      checked.items.length === 1 &&
        checked.items[0]?.document_ref.id === claim.id,
    );
    const validation = await request(
      li,
      'GET',
      `/api/v1/expenses/claims/${text(claim.id)}/validation`,
    );
    await check('报销提交硬校验通过', true, validation.valid);
    await action(li, 'expense.submit', [ref(saved)]);
    const submitted = await request(
      li,
      'GET',
      `/api/v1/expenses/claims/${text(claim.id)}`,
    );
    await check('新报销待主管审批', 'pending_manager', submitted.state, [
      ref(submitted),
    ]);
    const after = await request(li, 'GET', '/api/v1/oa/entertainment/oa-001');
    await check(
      '仅餐饮20000分新增占用后剩10000分',
      '10000',
      money(object(after.budget_usage).available),
    );
    await check(
      '原OA占用保留加本次餐饮为140000分',
      '140000',
      money(object(after.budget_usage).reserved),
    );
  }
  async function managerPreaudit(session: Session) {
    const approvals = await request(
      session,
      'GET',
      '/api/v1/approvals?limit=100',
    );
    const refs = array(approvals.items)
      .filter((item) => ref(item.document).type === 'expense_claim')
      .map((item) => ref(item.document));
    return preaudit(session, refs, 'manager_review');
  }
  async function journey04() {
    const manager = await login('u-zhang'),
      prior = await managerPreaudit(manager);
    const rule = await request(manager, 'POST', '/api/v1/rules/proposals', {
      natural_language:
        '部门内每张报销单餐饮费超过1000元提醒我。严格gt，1000元不触发，单位CNY，金额分100000，范围销售部，自2026-01-01起长期有效，缺字段unknown，仅个人提醒。',
      module: 'expense_claim',
      purpose: 'manager_review',
      source_refs: [],
    });
    const draft = array(rule.versions).find(
      (version) => version.id === rule.draft_version_id,
    );
    if (!draft)
      throw new JourneyFailure(
        'RULE_DRAFT_MISSING',
        '真实模型未生成规则草稿。',
      );
    const dsl = object(draft.dsl_json);
    await check(
      '个人提醒不覆盖公司制度',
      'attention_trigger',
      dsl.outcome_mode,
    );
    let tested = await request(
      manager,
      'POST',
      `/api/v1/rules/${text(rule.id)}/tests`,
      { expected_version: integer(rule.version), test_set_id: 'boundary-v1' },
    );
    if (tested.task_id && tested.passed === undefined)
      tested = await poll(
        'rule_test',
        () =>
          request(
            manager,
            'GET',
            `/api/v1/rules/${text(rule.id)}/tests/${text(tested.task_id)}`,
          ),
        (value) => text(value.status),
        ['completed'],
      );
    const proof = tested.proof ? object(tested.proof) : tested;
    await check('四组规则测试通过', true, proof.passed);
    const results = array(proof.results);
    await check('阈值下界/等值/上界/缺值四边界', 4, results.length);
    await check(
      '严格gt边界与unknown',
      ['false', 'false', 'true', 'unknown'],
      results.map((result) => result.truth),
    );
    await action(
      manager,
      'rule.enable',
      [{ type: 'rule', id: text(rule.id), version: integer(rule.version) }],
      {
        rule_id: rule.id,
        expected_version: rule.version,
        draft_hash: proof.draft_hash ?? draft.content_hash,
        test_run_id: proof.test_run_id,
      },
    );
    if (prior.items[0]?.result_id) {
      const old = await request(
        manager,
        'GET',
        `/api/v1/preaudit/results/${prior.items[0].result_id}`,
      );
      await check('启用新规则后旧预审stale', 'stale', old.status);
    }
    const fresh = await managerPreaudit(manager);
    await check(
      'clm002为个人提醒',
      'attention',
      fresh.items.find((item) => item.document_ref.id === 'clm-002')?.result
        ?.group,
    );
    await check(
      '公司住宿超标仍为risk',
      'risk',
      fresh.items.find((item) => item.document_ref.id === 'clm-003')?.result
        ?.group,
    );
    const li = await login('u-li'),
      own = await request(li, 'GET', '/api/v1/expenses/claims/clm-002');
    const self = await preaudit(li, [ref(own)], 'employee_precheck');
    await check(
      '员工预检不加载张伟个人规则',
      0,
      self.items[0]?.result?.coverage.personal_selected_total,
    );
  }
  async function journey05() {
    const manager = await login('u-zhang'),
      finance = await login('u-liu');
    const financeBefore = await request(
      finance,
      'GET',
      '/api/v1/approvals?limit=100',
    );
    const task = await managerPreaudit(manager);
    await check(
      '五单预审554000分',
      '554000',
      task.summary.total_amount.amount_minor,
    );
    await check(
      '四分组数量',
      { risk: 1, incomplete: 1, attention: 1, low: 2 },
      Object.fromEntries(
        Object.entries(task.summary.groups).map(([group, value]) => [
          group,
          value.count,
        ]),
      ),
    );
    const missing = task.items.find(
      (item) => item.document_ref.id === 'clm-004',
    )?.result;
    await check(
      'clm004金额仍90000分且incomplete',
      ['90000', 'incomplete'],
      [missing?.amount?.amount_minor, missing?.group],
    );
    const risk = task.items.find(
      (item) => item.document_ref.id === 'clm-003',
    )?.result;
    await check(
      '住宿风险有可追溯证据',
      true,
      !!risk?.findings.some(
        (finding) =>
          finding.kind === 'company_violation' &&
          finding.citation_refs.length > 0,
      ),
    );
    const selected = task.items.filter((item) =>
      ['clm-001', 'clm-005'].includes(item.document_ref.id),
    );
    await check(
      '仅明确选择124000分低风险两单',
      true,
      selected.length === 2 &&
        selected.every((item) => item.result?.eligible_for_bulk_approval) &&
        selected.reduce(
          (sum, item) => sum + BigInt(item.result?.amount?.amount_minor ?? '0'),
          0n,
        ) === 124000n,
    );
    await action(
      manager,
      'approval.batch_approve',
      selected.map((item) => item.document_ref),
      {
        items: selected.map((item) => ({
          resource_id: item.document_ref.id,
          task_ref: item.result?.task_ref,
          preaudit_result_id: item.result_id,
        })),
      },
    );
    for (const item of selected) {
      const claim = await request(
        manager,
        'GET',
        `/api/v1/expenses/claims/${item.document_ref.id}`,
      );
      await check(
        `${item.document_ref.id}转财务`,
        'pending_finance',
        claim.state,
        [ref(claim)],
      );
    }
    const managerAfter = await request(
        manager,
        'GET',
        '/api/v1/approvals?limit=100',
      ),
      financeAfter = await request(
        finance,
        'GET',
        '/api/v1/approvals?limit=100',
      );
    await check('主管剩3张', 3, managerAfter.count);
    await check(
      '财务新增2张',
      integer(financeBefore.count) + 2,
      financeAfter.count,
    );
    await check(
      '主管通过尚未计入完成金额',
      '590000',
      money((await analysis(manager, 'expense.completed_amount')).total),
    );
  }
  async function journey06() {
    const manager = await login('u-zhang');
    let skills = await request(manager, 'GET', '/api/v1/skills?limit=100');
    if (
      !array(skills.items).some(
        (skill) => skill.id === 'skill-analytics' && skill.usable === true,
      )
    ) {
      // 每次reset仅登记待验证的合成候选。本代必须真正通过验证、独立审查和统一确认发布。
      const maintainer = await login('u-liu');
      try {
        const source = await request(
          maintainer,
          'GET',
          '/api/v1/skills/skill-analytics/versions/skill-analytics-v1/source',
        );
        const validation = await request(
          maintainer,
          'POST',
          '/api/v1/skills/skill-analytics/versions/skill-analytics-v1/validate',
          { expected_version: integer(source.version) },
        );
        const validated = await poll(
          'skill_validation',
          () =>
            request(
              maintainer,
              'GET',
              `/api/v1/skills/skill-analytics/validations/${text(validation.validation_id)}`,
            ),
          (value) => text(value.status),
          ['passed'],
        );
        await check(
          '费用分析Skill使用真实非合成验证',
          false,
          validated.synthetic,
        );
        await check(
          '费用分析Skill已产生真实试运行记录',
          true,
          z.array(z.string()).parse(validated.test_run_ids).length > 0,
        );
        const profile = await request(maintainer, 'GET', '/api/v1/me');
        const candidate = await request(
          maintainer,
          'GET',
          '/api/v1/skills/skill-analytics',
        );
        const review = await request(
          maintainer,
          'POST',
          '/api/v1/skills/skill-analytics/reviews',
          {
            expected_version: integer(candidate.version),
            version_id: 'skill-analytics-v1',
            requested_scope: { scope: 'tenant' },
            grants: [
              {
                subject_type: 'tenant',
                subject_id: text(object(profile.actor).tenant_id),
                action: 'use',
              },
            ],
            reviewer_id: manager.actorId,
          },
        );
        const reviewedSource = await request(
          manager,
          'GET',
          '/api/v1/skills/skill-analytics/versions/skill-analytics-v1/source',
        );
        await check(
          '独立审查绑定同一候选内容hash',
          source.content_hash,
          reviewedSource.content_hash,
        );
        await request(
          manager,
          'POST',
          `/api/v1/skills/skill-analytics/reviews/${text(review.review_id)}/decide`,
          {
            expected_version: integer(review.version),
            decision: 'approved',
            reason:
              '已核对当前版本源码、登记工具、三类真实样例和只读分析范围。',
          },
        );
        const prepared = await request(
          maintainer,
          'POST',
          '/api/v1/skills/skill-analytics/publication-intents',
          {
            expected_version: integer(candidate.version),
            version_id: 'skill-analytics-v1',
            review_id: text(review.review_id),
          },
        );
        const confirmation = await request(
          maintainer,
          'GET',
          `/api/v1/confirmations/${text(prepared.confirmation_id)}`,
        );
        await request(
          maintainer,
          'POST',
          `/api/v1/confirmations/${text(prepared.confirmation_id)}/confirm`,
          {
            expected_version: integer(confirmation.version),
            summary_hash: text(confirmation.summary_hash),
            confirmation_token: text(confirmation.confirmation_token),
          },
        );
        const published = ActionViewSchema.parse(
          await poll(
            'skill_publication',
            () =>
              request(
                maintainer,
                'GET',
                `/api/v1/actions/${text(prepared.action_id)}`,
              ),
            (value) => text(value.state),
            ['succeeded'],
            ['failed', 'rejected', 'cancelled', 'unknown', 'expired'],
          ),
        );
        await check(
          '费用分析Skill统一确认发布有真实回执',
          true,
          published.items.length === 1 &&
            published.items[0]?.receipt?.outcome === 'succeeded',
          [
            {
              type: 'skill',
              id: 'skill-analytics',
              version: integer(candidate.version),
            },
          ],
        );
      } catch (error) {
        if (error instanceof JourneyFailure && error.blocked)
          throw new JourneyFailure(
            'SKILL_VALIDATION_REQUIRED',
            `费用分析Skill治理前置依赖受阻（${error.code}）：需要本代真实模型验证、独立审查和本人确认发布。`,
            true,
          );
        throw error;
      }
      skills = await request(manager, 'GET', '/api/v1/skills?limit=100');
    }
    await check(
      '费用分析Skill可用',
      true,
      array(skills.items).some(
        (skill) => skill.id === 'skill-analytics' && skill.usable === true,
      ),
    );
    await check(
      '财务私有Skill不可见',
      false,
      array(skills.items).some((skill) => skill.id === 'skill-finance-private'),
    );
    await request(
      manager,
      'GET',
      '/api/v1/skills/skill-finance-private',
      undefined,
      [404],
    );
    await conversation(
      manager,
      '请用费用分析查询销售部2026年11月1日至11月5日已完成报销的餐饮排行，按申请人排行，仅completed口径；生成费用月报草稿，附同一快照引用，不发送。',
      'skill-analytics-v1',
    );
    const snapshot = await analysis(
      manager,
      'expense.category_completed_amount',
      ['applicant'],
      ['meals'],
    );
    const rows = array(snapshot.rows);
    await check(
      '王强餐饮180000分',
      '180000',
      rows.find(
        (row) =>
          row.dimension_key === '["u-wang"]' ||
          row.label === 'u-wang' ||
          row.label === '王强',
      )?.value,
    );
    await check(
      '李娜餐饮50000分',
      '50000',
      rows.find(
        (row) =>
          row.dimension_key === '["u-li"]' ||
          row.label === 'u-li' ||
          row.label === '李娜',
      )?.value,
    );
    await check('排行总额230000分', '230000', money(snapshot.total));
    const drill = await request(
      manager,
      'GET',
      `/api/v1/analytics/snapshots/${text(snapshot.id)}/rows?limit=100`,
    );
    await check('下钻同一snapshot', snapshot.id, drill.snapshot_id);
    await check(
      '下钻只含完成销售餐饮',
      true,
      array(drill.items).every(
        (fact) =>
          fact.state === 'completed' &&
          fact.department_id === 'dept-sales' &&
          fact.expense_type === 'meals',
      ),
    );
    const started = await request(
      manager,
      'POST',
      '/api/v1/analytics/reports',
      { analysis_snapshot_id: snapshot.id, template: 'monthly_expense' },
    );
    const report = await poll(
      'report',
      () =>
        request(
          manager,
          'GET',
          `/api/v1/analytics/reports/${text(started.report_id)}`,
        ),
      (value) => text(value.state),
      ['ready'],
    );
    await check(
      '报告图表与明细引用同snapshot',
      [snapshot.id, snapshot.id, snapshot.id],
      [
        report.analysis_snapshot_id,
        object(object(report.snapshot).chart).snapshot_id,
        drill.snapshot_id,
      ],
    );
    const exported = await request(
      manager,
      'POST',
      `/api/v1/analytics/reports/${text(report.id)}/exports`,
      {
        expected_version: report.version,
        format: 'csv',
        freshness_choice: 'as_recorded',
      },
    );
    const artifact = await poll(
      'export',
      () =>
        request(
          manager,
          'GET',
          `/api/v1/analytics/artifacts/${text(exported.artifact_id)}`,
        ),
      (value) => text(value.state),
      ['ready'],
    );
    await check(
      '授权导出具有hash与内容',
      true,
      typeof artifact.sha256 === 'string' && integer(artifact.size_bytes) > 0,
    );
    await request(
      manager,
      'GET',
      `/api/v1/analytics/artifacts/${text(exported.artifact_id)}/download`,
    );
  }
  async function journey07() {
    const manager = await login('u-zhang'),
      input = {
        kind: 'response_preference',
        key: '正式旅程报告偏好',
        content: '报告先给摘要，金额使用元。',
        value: { summary_first: true, money_unit: 'yuan' },
        expires_at: null,
        source: { kind: 'manual' },
        explicit_save: true,
      };
    const saved = await request(manager, 'POST', '/api/v1/memories', input),
      memory = object(saved.memory);
    await check('偏好保存本人回执', 'u-zhang', memory.owner_id);
    const report = await conversation(
      manager,
      '请生成销售部本月已完成费用的简短说明，按我的已保存表达偏好输出，不再保存任何记忆。',
    );
    const historical = JSON.stringify({
      messages: report.snapshot.messages,
      cards: report.snapshot.cards,
    });
    await check(
      '新会话报告摘要优先且用元',
      true,
      /摘要/.test(historical) && /元/.test(historical),
    );
    const li = await login('u-li'),
      other = await request(li, 'GET', '/api/v1/memories');
    await check(
      '李娜不继承本人偏好',
      false,
      array(other.items).some(
        (item) => item.id === memory.id || item.key === input.key,
      ),
    );
    const liRun = await conversation(
      li,
      '列出我当前已保存的报告表达偏好，没有就明确没有，不要保存记忆。',
    );
    await check(
      '李娜新会话不含张伟偏好key',
      false,
      JSON.stringify(liRun.snapshot).includes(input.key),
    );
    const updated = await request(
      manager,
      'PATCH',
      `/api/v1/memories/${text(memory.id)}`,
      {
        ...input,
        content: '报告先给摘要，金额使用万元。',
        value: { summary_first: true, money_unit: 'ten_thousand_yuan' },
        expected_version: memory.version,
      },
    );
    const latest = object(updated.memory);
    await check(
      '修改偏好提升本人缓存epoch',
      true,
      integer(updated.memory_epoch) > integer(saved.memory_epoch),
    );
    const changed = await conversation(
      manager,
      '请生成销售部本月已完成费用简短说明，遵循我最新已保存的表达偏好，不要保存记忆。',
    );
    await check(
      '修改后新run按万元输出',
      true,
      /万元/.test(JSON.stringify(changed.snapshot)),
    );
    const old = await request(
      manager,
      'GET',
      `/api/v1/threads/${report.threadId}/snapshot`,
    );
    await check(
      '偏好修改不篡改历史报告',
      historical,
      JSON.stringify({ messages: old.messages, cards: old.cards }),
    );
    await request(manager, 'DELETE', `/api/v1/memories/${text(memory.id)}`, {
      expected_version: latest.version,
    });
    const removed = await request(manager, 'GET', '/api/v1/memories');
    await check(
      '删除后本人活动记忆停止使用',
      false,
      array(removed.items).some(
        (item) => item.id === memory.id && item.status === 'active',
      ),
    );
  }
  async function journey08() {
    const manager = await login('u-zhang'),
      admin = await login('u-zhao');
    const beforeThreads = await request(manager, 'GET', '/api/v1/threads'),
      beforeInbox = await request(manager, 'GET', '/api/v1/inbox');
    const subscriptionRequestedAt = Date.now();
    const created = await request(manager, 'POST', '/api/v1/subscriptions', {
      type: 'todo_digest',
      title: '正式旅程工作日九点待办摘要',
      schedule: {
        frequency: 'weekdays',
        local_time: '09:00',
        timezone: 'Asia/Shanghai',
        start_date: '2026-11-06',
      },
      query_spec: {
        scope: 'current_approval_scope',
        include_existing_preaudit: true,
      },
      skill_version_id: null,
      delivery: { channel: 'in_app' },
    });
    const subscription = object(created.subscription ?? created);
    const env = await environment(admin);
    await request(admin, 'PUT', '/api/v1/demo/business-clock', {
      ...guard(env),
      expected_version: env.clock_version,
      business_now: '2026-11-06T01:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });
    const current = await environment(admin);
    const trigger = {
      ...guard(current),
      subscription_id: text(subscription.id),
    };
    const triggered = await request(
      admin,
      'POST',
      '/api/v1/demo/summary-triggers',
      trigger,
    );
    await poll(
      'summary_trigger',
      () =>
        request(
          admin,
          'GET',
          `/api/v1/demo/summary-triggers/${text(triggered.request_id)}`,
        ),
      (value) => text(value.status),
      ['scheduled', 'no_due_subscription'],
    );
    const inbox = await poll(
      'digest',
      () => request(manager, 'GET', '/api/v1/inbox'),
      (value) =>
        array(value.items).length > array(beforeInbox.items).length
          ? 'ready'
          : 'waiting',
      ['ready'],
    );
    const item = array(inbox.items).find(
      (item) => !array(beforeInbox.items).some((old) => old.id === item.id),
    );
    if (!item) throw new JourneyFailure('DIGEST_MISSING', '未找到本次摘要。');
    await check('摘要投递为未读', true, item.unread);
    const beforeOpen = await request(manager, 'GET', '/api/v1/threads');
    await check(
      '仅投递摘要不创建隐藏聊天',
      array(beforeThreads.items).length,
      array(beforeOpen.items).length,
    );
    const triggeredAgain = await request(
      admin,
      'POST',
      '/api/v1/demo/summary-triggers',
      trigger,
    );
    await poll(
      'summary_trigger',
      () =>
        request(
          admin,
          'GET',
          `/api/v1/demo/summary-triggers/${text(triggeredAgain.request_id)}`,
        ),
      (value) => text(value.status),
      ['scheduled', 'no_due_subscription'],
    );
    const duplicate = await request(manager, 'GET', '/api/v1/inbox');
    await check(
      '同订阅计划时点仅一条',
      array(inbox.items).length,
      array(duplicate.items).length,
    );
    const adminInbox = await request(admin, 'GET', '/api/v1/inbox');
    await check(
      '触发管理员不能读取张伟摘要',
      false,
      array(adminInbox.items).some((entry) => entry.id === item.id),
    );
    const opened = await request(
      manager,
      'POST',
      `/api/v1/inbox/${text(item.id)}/open`,
      { expected_version: item.version },
    );
    const snapshot = await request(
      manager,
      'GET',
      `/api/v1/threads/${text(opened.thread_id)}/snapshot`,
    );
    const summaryCard = object(
      array(snapshot.cards).find(
        (card) =>
          card.id === opened.card_id && card.type === 'reminder_summary',
      ),
    );
    const summaryPayload = object(summaryCard.payload);
    const generatedAt = Date.parse(text(summaryPayload.generated_at));
    const summaryMessage = object(
      array(snapshot.messages).find(
        (message) =>
          message.id === summaryCard.message_id && message.role === 'assistant',
      ),
    );
    const expectedRefs: ResourceRef[] = ['001', '002', '003', '004', '005'].map(
      (suffix) => ({ type: 'expense_claim', id: `clm-${suffix}`, version: 1 }),
    );
    await check(
      '打开摘要含生成时点快照',
      true,
      Number.isFinite(generatedAt) &&
        generatedAt >= subscriptionRequestedAt &&
        generatedAt <= Date.parse(text(item.created_at)) &&
        summaryCard.snapshot_at === summaryPayload.generated_at,
    );
    await check(
      '摘要卡绑定原收件箱并保持只读',
      { inbox_item_id: item.id, read_only: true, origin_run_id: null },
      {
        inbox_item_id: summaryPayload.inbox_item_id,
        read_only: summaryPayload.read_only,
        origin_run_id: summaryPayload.origin_run_id,
      },
    );
    await check('摘要正文保留投递时预览', item.preview, summaryMessage.content);
    await check(
      '摘要卡保留生成时五张来源版本',
      expectedRefs,
      summaryPayload.subject_refs,
      expectedRefs,
    );
    await check(
      '摘要消息与卡片来源一致',
      expectedRefs,
      summaryMessage.resource_refs,
      expectedRefs,
    );
    const reopened = await request(
      manager,
      'POST',
      `/api/v1/inbox/${text(item.id)}/open`,
      { expected_version: item.version },
    );
    await check(
      '重复打开复用原摘要会话和卡片',
      { thread_id: opened.thread_id, card_id: opened.card_id },
      { thread_id: reopened.thread_id, card_id: reopened.card_id },
    );
    const reopenedSnapshot = await request(
      manager,
      'GET',
      `/api/v1/threads/${text(reopened.thread_id)}/snapshot`,
    );
    const reopenedCard = object(
      array(reopenedSnapshot.cards).find((card) => card.id === opened.card_id),
    );
    await check(
      '重复打开保持原生成时点',
      summaryPayload.generated_at,
      object(reopenedCard.payload).generated_at,
    );
    const latest = await request(manager, 'GET', '/api/v1/approvals?limit=100');
    await check('摘要未自动审批，最新待办仍5张', 5, latest.count);
    const li = await login('u-li');
    await request(
      li,
      'POST',
      `/api/v1/inbox/${text(item.id)}/open`,
      { expected_version: item.version },
      [404],
    );
  }
  const journeys: Record<DemoJourneyId, () => Promise<void>> = {
    'E2E-01': journey01,
    'E2E-02': journey02,
    'E2E-03': journey03,
    'E2E-04': journey04,
    'E2E-05': journey05,
    'E2E-06': journey06,
    'E2E-07': journey07,
    'E2E-08': journey08,
  };
  async function execute(input: {
    scenarioId: DemoJourneyId;
    baseline: DemoJourneyBaseline;
  }): Promise<DemoJourneyReport> {
    if (active || resetting)
      throw new JourneyFailure(
        'RUNNER_BUSY',
        '同一runner不能并发修改全局演示环境。',
      );
    active = true;
    journeySignal ??= AbortSignal.timeout(
      options.journeyTimeoutMs ?? 15 * 60_000,
    );
    const startedAt = new Date().toISOString();
    evidence = [...input.baseline.evidence];
    let status: DemoJourneyReport['status'] = 'succeeded',
      failure: DemoJourneyReport['error'] = null;
    try {
      const id = `${input.baseline.environment_id}:${input.baseline.generation}`;
      if (consumedBaselines.has(id))
        throw new JourneyFailure(
          'BASELINE_ALREADY_USED',
          '本runner已使用该generation；每条旅程必须先受控reset。',
        );
      if (input.baseline.scenario_id !== input.scenarioId)
        throw new JourneyFailure(
          'BASELINE_SCENARIO_MISMATCH',
          '基线不属于本条旅程。',
        );
      await verifyBaseline(await login('u-zhao'), input.baseline);
      consumedBaselines.add(id);
      await journeys[input.scenarioId]();
    } catch (error) {
      status =
        error instanceof JourneyFailure && error.blocked ? 'blocked' : 'failed';
      failure = {
        code: error instanceof JourneyFailure ? error.code : 'JOURNEY_FAILED',
        message: error instanceof Error ? error.message : '旅程执行失败。',
      };
      await emit({
        step_id: 'journey-outcome',
        passed: false,
        trace_id: `failure:${randomUUID()}`,
        resource_refs: [],
        assertion: { expected: 'succeeded', actual: failure },
      });
    } finally {
      active = false;
      journeySignal = null;
    }
    const report: DemoJourneyReport = {
      id: randomUUID(),
      scenario_id: input.scenarioId,
      status,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      baseline: input.baseline,
      evidence: [...evidence],
      error: failure,
    };
    await options.saveReport?.(report);
    return report;
  }
  async function run(input: {
    scenarioId: DemoJourneyId;
  }): Promise<DemoJourneyReport> {
    if (active || resetting)
      throw new JourneyFailure(
        'RUNNER_BUSY',
        '同一runner已有正在执行的旅程或重置。',
      );
    const startedAt = new Date().toISOString();
    let baseline: DemoJourneyBaseline;
    try {
      baseline = await resetBaseline(input.scenarioId);
    } catch (error) {
      const report: DemoJourneyReport = {
        id: randomUUID(),
        scenario_id: input.scenarioId,
        status:
          error instanceof JourneyFailure && error.blocked
            ? 'blocked'
            : 'failed',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        baseline: null,
        evidence: [...evidence],
        error: {
          code: error instanceof JourneyFailure ? error.code : 'RESET_FAILED',
          message: error instanceof Error ? error.message : '基线重置失败。',
        },
      };
      await options.saveReport?.(report);
      return report;
    }
    return execute({ ...input, baseline });
  }
  return { run, resetBaseline, execute };
}
export type DemoJourneyRunner = ReturnType<typeof createDemoJourneyRunner>;
