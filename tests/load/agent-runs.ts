import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '@caixiaozhi/platform/config';
import {
  checkDatabaseReady,
  createDatabase,
  type DatabaseConnection,
} from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { WORKSPACE_ROOT } from '@caixiaozhi/platform/paths';
import { AppError } from '@caixiaozhi/platform/errors';
import { createApplication } from '@caixiaozhi/application';
import {
  assertDshNodeVersion,
  readDshModelConfig,
  type AgentRuntimeAdapter,
  type RuntimeHandle,
} from '@caixiaozhi/agent-runtime';
import { SseEventSchema } from '@caixiaozhi/contracts/events';
import { createApp } from '../../apps/api/src/app.js';
import {
  createIdentityHttpContext,
  registerIdentityRoutes,
} from '../../apps/api/src/modules/identity/routes.js';
import { registerAssistantRoutes } from '../../apps/api/src/modules/assistant/routes.js';
import { registerRunRoutes } from '../../apps/api/src/modules/runs/routes.js';
import { createWorkerRunner } from '../../apps/worker/src/runner/index.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  z.record(z.string(), z.unknown()).parse(value);
const text = (value: unknown) => z.string().min(1).parse(value);
const count = (value: unknown) => z.number().int().nonnegative().parse(value);
const execFileAsync = promisify(execFile);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const safeCode = (error: unknown) =>
  error instanceof AppError
    ? typeof error.details?.reason === 'string' &&
      /^[A-Z_]+$/.test(error.details.reason)
      ? error.details.reason
      : error.code
    : error instanceof CapacityError
      ? error.code
      : error instanceof z.ZodError
        ? 'INVALID_LOAD_CONFIGURATION'
        : 'CAPACITY_TEST_FAILED';
class CapacityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const values = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length
      ? Math.round(
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!,
        )
      : null;
  return {
    count: sorted.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    max_ms: sorted.length ? Math.round(sorted.at(-1)!) : null,
  };
};
const ParametersSchema = z.object({
  LOAD_RUNS: z.coerce.number().int().min(20).max(200).default(20),
  LOAD_USERS: z.coerce.number().int().min(10).max(100).default(10),
  LOAD_SSE: z.coerce.number().int().min(100).max(1000).default(100),
  LOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(1_800_000)
    .default(600_000),
  LOAD_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(30_000),
  LOAD_MIN_JOINT_MS: z.coerce.number().int().min(1).max(60_000).default(1000),
  LOAD_OUTPUT_CHARS: z.coerce.number().int().min(1000).max(24000).default(6000),
  LOAD_SAMPLE_MS: z.coerce.number().int().min(100).max(5000).default(250),
  LOAD_REPORT_PATH: z.string().min(1).optional(),
});
export type AgentCapacityReport = {
  schema_version: 1;
  test_id: string;
  status: 'passed' | 'not_achieved' | 'failed' | 'blocked';
  exit_code: 0 | 1 | 2;
  started_at: string;
  finished_at: string | null;
  scope: string;
  reason_codes: string[];
  target: { active_runs: 20; sse_connections: 100; minimum_joint_ms: number };
  parameters: Json;
  isolation: {
    tenant_digest: string | null;
    workload_users: number;
    cross_owner_checks: number;
    cross_owner_denials: number;
    foreign_events: number;
    foreign_markers: number;
    read_only: boolean;
    unexpected_writes: number;
  };
  concurrency: {
    worker_limit: 20;
    peak_sdk_handles: number;
    peak_model_http_in_flight: number;
    peak_runtime_active_rows: number;
    peak_live_model_slots: number;
    peak_sse_connections: number;
    peak_joint_active_runs: number;
    longest_joint_ms: number;
  };
  model_transport: {
    scope: string;
    requests: number;
    status_counts: Record<string, number>;
    http_429: number;
    network_errors: number;
    latency: ReturnType<typeof values>;
  };
  requests: {
    accepted_runs: number;
    http_status_counts: Record<string, number>;
    http_latency: ReturnType<typeof values>;
  };
  queues: {
    to_first_claim: ReturnType<typeof values>;
    to_sdk_handle: ReturnType<typeof values>;
    after_worker_start: ReturnType<typeof values>;
  };
  runs: Array<{
    run_label: string;
    owner_label: string;
    status: string;
    error_code: string | null;
    model_calls: number;
    input_tokens: number;
    output_tokens: number;
    last_seq: number;
    queue_wait_ms: number | null;
    sdk_start_wait_ms: number | null;
    own_marker_seen: boolean;
    assistant_output_chars: number;
  }>;
  streams: Array<{
    stream_label: string;
    run_label: string;
    status: string;
    first_seq: number | null;
    last_seq: number;
    event_count: number;
    duplicates: number;
    gaps: number;
    foreign_events: number;
    foreign_markers: number;
    event_digest: string | null;
    bytes_received: number;
    error_code: string | null;
  }>;
  resources: {
    scope: string;
    samples: Array<{
      at_ms: number;
      rss_bytes: number;
      node_cpu_percent: number;
      descendant_processes: number | null;
      descendant_rss_bytes: number | null;
      descendant_cpu_percent_from_ps: number | null;
      runtime_active: number;
      live_slots: number;
      queued: number;
      sdk_handles: number;
      model_http_in_flight: number;
      sse_connections: number;
    }>;
    ps_available: boolean | null;
  };
  rate_limits: {
    http_429: number;
    run_rate_limited: number;
    model_error_codes: Record<string, number>;
    worker_error_codes: Record<string, number>;
  };
  cleanup: {
    worker_graceful: boolean | null;
    worker_quiescent: boolean | null;
    connections_closed: boolean | null;
    http_closed: boolean | null;
    forced_descendants: number;
    tenant_rows_removed: number;
    tenant_rows_remaining: number | null;
    runtime_directory_removed: boolean | null;
    error_codes: string[];
  };
};
type Session = { ownerId: string; label: string; cookie: string; csrf: string };
type WorkloadRun = {
  id: string;
  label: string;
  owner: Session;
  marker: string;
  createdAt: number;
  sdkStartedAt: number | null;
  final: Json | null;
};
type ProcessRow = { pid: number; ppid: number; cpu: number; rss: number };
async function processTree(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync(
    'ps',
    ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='],
    { timeout: 2000, maxBuffer: 5_000_000 },
  );
  const all = stdout.split('\n').flatMap((line) => {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    return match && !/(?:^|\/)ps$/.test(match[5]!)
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            cpu: Number(match[3]),
            rss: Number(match[4]) * 1024,
          },
        ]
      : [];
  });
  const ids = new Set([process.pid]);
  for (let pass = 0; pass < all.length; pass++) {
    let changed = false;
    for (const row of all)
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    if (!changed) break;
  }
  return all.filter((row) => row.pid !== process.pid && ids.has(row.pid));
}
async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  code: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CapacityError(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** 仅删除本次随机测试租户。无全局TRUNCATE、演示reset或身份HTTP旁路。 */
async function removeTenant(database: DatabaseConnection, tenant: string) {
  if (!/^load-[a-f0-9-]{36}$/.test(tenant))
    throw new CapacityError('INVALID_TEST_TENANT');
  const client = await database.pool.connect();
  let removed = 0;
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const tables = (
      await client.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY table_name",
      )
    ).rows
      .map((row) => text(row.table_name))
      .filter((name) => /^[a-z][a-z0-9_]*$/.test(name));
    for (let pass = 0; pass < tables.length + 2; pass++) {
      let changed = 0,
        remaining = 0;
      for (const table of tables) {
        await client.query('SAVEPOINT capacity_cleanup');
        try {
          const result = await client.query(
            `DELETE FROM "${table}" WHERE tenant_id=$1`,
            [tenant],
          );
          changed += result.rowCount ?? 0;
          await client.query('RELEASE SAVEPOINT capacity_cleanup');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT capacity_cleanup');
          await client.query('RELEASE SAVEPOINT capacity_cleanup');
          if ((error as { code?: string }).code !== '23503') throw error;
        }
      }
      removed += changed;
      for (const table of tables)
        remaining += Number(
          (
            await client.query(
              `SELECT count(*)::int n FROM "${table}" WHERE tenant_id=$1`,
              [tenant],
            )
          ).rows[0]?.n ?? 0,
        );
      if (!remaining) {
        await client.query('COMMIT');
        return { removed, remaining };
      }
      if (!changed)
        throw new CapacityError('TENANT_CLEANUP_DEPENDENCY_BLOCKED');
    }
    throw new CapacityError('TENANT_CLEANUP_INCOMPLETE');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 实际DSH + 正式HTTP + 20并发Worker。观察包装器不替换模型，也不延迟模型或事件制造并发。 */
export async function runAgentCapacityTest(): Promise<AgentCapacityReport> {
  const started = Date.now(),
    reportPath = resolve(
      process.env.LOAD_REPORT_PATH ??
        join(WORKSPACE_ROOT, 'docs/verification/agent-capacity-latest.json'),
    );
  const report: AgentCapacityReport = {
    schema_version: 1,
    test_id: randomUUID(),
    status: 'blocked',
    exit_code: 2,
    started_at: new Date(started).toISOString(),
    finished_at: null,
    scope:
      '独立测试租户；真实application HTTP、真实DSH SDK、20并发Worker与100条SSE。无固定模型回复；同进程API/Worker加子进程资源，不代表分布式生产容量。',
    reason_codes: [],
    target: { active_runs: 20, sse_connections: 100, minimum_joint_ms: 1000 },
    parameters: {
      required_model_configuration: [
        'DSH_API_KEY',
        'DSH_BASE_URL',
        'DSH_MODEL',
        'DSH_CONTEXT_WINDOW',
      ],
    },
    isolation: {
      tenant_digest: null,
      workload_users: 0,
      cross_owner_checks: 0,
      cross_owner_denials: 0,
      foreign_events: 0,
      foreign_markers: 0,
      read_only: true,
      unexpected_writes: 0,
    },
    concurrency: {
      worker_limit: 20,
      peak_sdk_handles: 0,
      peak_model_http_in_flight: 0,
      peak_runtime_active_rows: 0,
      peak_live_model_slots: 0,
      peak_sse_connections: 0,
      peak_joint_active_runs: 0,
      longest_joint_ms: 0,
    },
    model_transport: {
      scope:
        '透明转发真实网关的推理请求，仅记录状态、并发与耗时，不记录正文或认证头。',
      requests: 0,
      status_counts: {},
      http_429: 0,
      network_errors: 0,
      latency: values([]),
    },
    requests: {
      accepted_runs: 0,
      http_status_counts: {},
      http_latency: values([]),
    },
    queues: {
      to_first_claim: values([]),
      to_sdk_handle: values([]),
      after_worker_start: values([]),
    },
    runs: [],
    streams: [],
    resources: {
      scope:
        '当前API+Worker Node进程与其DSH子进程；不含数据库、S3及外部模型服务器。ps CPU为进程生命周期平均值。',
      samples: [],
      ps_available: null,
    },
    rate_limits: {
      http_429: 0,
      run_rate_limited: 0,
      model_error_codes: {},
      worker_error_codes: {},
    },
    cleanup: {
      worker_graceful: null,
      worker_quiescent: null,
      connections_closed: null,
      http_closed: null,
      forced_descendants: 0,
      tenant_rows_removed: 0,
      tenant_rows_remaining: null,
      runtime_directory_removed: null,
      error_codes: [],
    },
  };
  let database: DatabaseConnection | undefined,
    storage: ReturnType<typeof createStorage> | undefined,
    app: ReturnType<typeof createApp> | undefined,
    runner: ReturnType<typeof createWorkerRunner> | undefined;
  const allController = new AbortController(),
    connections: AbortController[] = [],
    streamTasks: Promise<void>[] = [],
    handles = new Map<string, RuntimeHandle>(),
    workload: WorkloadRun[] = [],
    latencies: number[] = [],
    modelLatencies: number[] = [],
    streamOwnMarker = new Map<string, boolean>(),
    streamOutputChars = new Map<string, number>(),
    modelErrorEvents = new Set<string>(),
    modelSockets = new Set<Socket>(),
    upstreamRequests = new Set<ClientRequest>();
  let modelProxy: Server | undefined,
    originalModelBase: string | undefined,
    modelInFlight = 0,
    runtimeStopFailed = false;
  let tenant: string | undefined,
    base = '',
    sampling: ReturnType<typeof setInterval> | undefined,
    sampleBusy = false,
    workerStartedAt: number | null = null,
    activeSse = 0,
    jointSince: number | null = null,
    totalTimer: ReturnType<typeof setTimeout> | undefined;
  let processSignalHandler: (() => void) | undefined;
  const recordCode = (target: Record<string, number>, code: string) => {
    target[code] = (target[code] ?? 0) + 1;
  };
  const joint = () => {
    const at = Date.now(),
      active = Math.min(handles.size, modelInFlight);
    report.concurrency.peak_model_http_in_flight = Math.max(
      report.concurrency.peak_model_http_in_flight,
      modelInFlight,
    );
    report.concurrency.peak_sdk_handles = Math.max(
      report.concurrency.peak_sdk_handles,
      handles.size,
    );
    report.concurrency.peak_sse_connections = Math.max(
      report.concurrency.peak_sse_connections,
      activeSse,
    );
    if (activeSse >= 100)
      report.concurrency.peak_joint_active_runs = Math.max(
        report.concurrency.peak_joint_active_runs,
        active,
      );
    if (active >= 20 && activeSse >= 100) {
      jointSince ??= at;
      report.concurrency.longest_joint_ms = Math.max(
        report.concurrency.longest_joint_ms,
        at - jointSince,
      );
    } else if (jointSince !== null) {
      report.concurrency.longest_joint_ms = Math.max(
        report.concurrency.longest_joint_ms,
        at - jointSince,
      );
      jointSince = null;
    }
  };
  const persist = async () => {
    report.finished_at = new Date().toISOString();
    report.requests.http_latency = values(latencies);
    report.model_transport.latency = values(modelLatencies);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  };
  const summarizeRuns = async () => {
    if (!database || !tenant || !workload.length) return;
    const rows = await database.pool.query(
      'SELECT id,status,error_code,usage,last_seq,created_at,started_at FROM agent_runs WHERE tenant_id=$1',
      [tenant],
    );
    for (const row of rows.rows) {
      const run = workload.find((run) => run.id === row.id);
      if (run)
        run.final = object({
          ...row,
          created_at: new Date(row.created_at).toISOString(),
          started_at: row.started_at
            ? new Date(row.started_at).toISOString()
            : null,
        });
    }
    report.runs = workload.map((run) => {
      const final = run.final,
        usage = object(final?.usage ?? {}),
        createdAt = final ? Date.parse(text(final.created_at)) : run.createdAt;
      const queueWait =
        typeof final?.started_at === 'string'
          ? Date.parse(final.started_at) - createdAt
          : null;
      return {
        run_label: run.label,
        owner_label: run.owner.label,
        status:
          typeof final?.status === 'string' ? final.status : 'unavailable',
        error_code:
          typeof final?.error_code === 'string' ? final.error_code : null,
        model_calls: count(usage.model_calls ?? 0),
        input_tokens: count(usage.input_tokens ?? 0),
        output_tokens: count(usage.output_tokens ?? 0),
        last_seq: Number(final?.last_seq ?? 0),
        queue_wait_ms: queueWait,
        sdk_start_wait_ms:
          run.sdkStartedAt === null ? null : run.sdkStartedAt - createdAt,
        own_marker_seen: streamOwnMarker.get(run.id) ?? false,
        assistant_output_chars: Math.round(streamOutputChars.get(run.id) ?? 0),
      };
    });
    report.rate_limits.run_rate_limited = report.runs.filter(
      (run) => run.error_code === 'RATE_LIMITED',
    ).length;
    report.queues.to_first_claim = values(
      report.runs.flatMap((run) =>
        run.queue_wait_ms === null ? [] : [run.queue_wait_ms],
      ),
    );
    report.queues.to_sdk_handle = values(
      report.runs.flatMap((run) =>
        run.sdk_start_wait_ms === null ? [] : [run.sdk_start_wait_ms],
      ),
    );
    report.queues.after_worker_start = values(
      workload.flatMap((run) =>
        run.sdkStartedAt === null || workerStartedAt === null
          ? []
          : [run.sdkStartedAt - Math.max(run.createdAt, workerStartedAt)],
      ),
    );
    const unexpected = await database.pool.query(
      "SELECT (SELECT count(*) FROM integration_invocations WHERE tenant_id=$1 AND effect<>'read')+(SELECT count(*) FROM actions WHERE tenant_id=$1)+(SELECT count(*) FROM memories WHERE tenant_id=$1)+(SELECT count(*) FROM expense_claims WHERE tenant_id=$1)+(SELECT count(*) FROM travel_requests WHERE tenant_id=$1)+(SELECT count(*) FROM entertainment_requests WHERE tenant_id=$1) n",
      [tenant],
    );
    report.isolation.unexpected_writes = Number(unexpected.rows[0]?.n ?? 0);
    report.isolation.read_only = report.isolation.unexpected_writes === 0;
  };
  try {
    // 必须先验证DSH，缺配置绝不建立连接、创建身份或运行替身。
    const actualModel = readDshModelConfig();
    assertDshNodeVersion();
    const parameters = ParametersSchema.parse(process.env),
      config = loadConfig();
    if (parameters.LOAD_RUNS > parameters.LOAD_USERS * 10)
      throw new CapacityError('LOAD_EXCEEDS_USER_UNFINISHED_QUOTA');
    report.parameters = {
      runs: parameters.LOAD_RUNS,
      users: parameters.LOAD_USERS,
      sse: parameters.LOAD_SSE,
      worker_concurrency: 20,
      timeout_ms: parameters.LOAD_TIMEOUT_MS,
      connect_timeout_ms: parameters.LOAD_CONNECT_TIMEOUT_MS,
      requested_output_chars: parameters.LOAD_OUTPUT_CHARS,
      sample_interval_ms: parameters.LOAD_SAMPLE_MS,
      model: actualModel.model,
      protocol: actualModel.protocol,
      context_window: actualModel.contextWindow,
    };
    report.target.minimum_joint_ms = parameters.LOAD_MIN_JOINT_MS;
    totalTimer = setTimeout(
      () => allController.abort(),
      parameters.LOAD_TIMEOUT_MS,
    );
    processSignalHandler = () => allController.abort();
    process.on('SIGINT', processSignalHandler);
    process.on('SIGTERM', processSignalHandler);
    const upstreamBase = new URL(actualModel.baseURL);
    originalModelBase = process.env.DSH_BASE_URL;
    modelProxy = createServer((incoming, outgoing) => {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
        outgoing.writeHead(400).end();
        return;
      }
      const incomingUrl = new URL(incoming.url, 'http://127.0.0.1');
      const target = new URL(upstreamBase.href);
      target.pathname = incomingUrl.pathname;
      target.search = incomingUrl.search;
      const inference =
        incoming.method === 'POST' &&
        /\/(?:chat\/completions|responses|messages)\/?$/.test(target.pathname);
      const requestedAt = performance.now();
      let settled = false;
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      if (inference) {
        report.model_transport.requests++;
        modelInFlight++;
      }
      joint();
      const complete = () => {
        if (settled) return;
        settled = true;
        clearTimeout(requestTimer);
        if (inference) {
          modelInFlight--;
          modelLatencies.push(performance.now() - requestedAt);
        }
        joint();
      };
      const upstream = (
        target.protocol === 'https:' ? httpsRequest : httpRequest
      )(
        target,
        {
          method: incoming.method,
          headers: { ...incoming.headers, host: target.host },
          timeout: 90_000,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (inference)
            recordCode(report.model_transport.status_counts, String(status));
          if (inference && status === 429) report.model_transport.http_429++;
          outgoing.writeHead(status, response.headers);
          response.pipe(outgoing);
          response.on('end', complete);
          response.on('close', complete);
        },
      );
      requestTimer = setTimeout(
        () => upstream.destroy(new CapacityError('MODEL_HTTP_TIMEOUT')),
        90_000,
      );
      upstreamRequests.add(upstream);
      upstream.on('close', () => {
        upstreamRequests.delete(upstream);
        complete();
      });
      upstream.on('timeout', () =>
        upstream.destroy(new CapacityError('MODEL_HTTP_TIMEOUT')),
      );
      upstream.on('error', () => {
        if (inference && !settled) report.model_transport.network_errors++;
        complete();
        if (!outgoing.headersSent && !outgoing.destroyed)
          outgoing
            .writeHead(502, { 'content-type': 'application/json' })
            .end('{"error":{"code":"MODEL_TRANSPORT_FAILED"}}');
        else if (!outgoing.destroyed) outgoing.destroy();
      });
      incoming.on('aborted', () => upstream.destroy());
      outgoing.on('close', () => {
        upstream.destroy();
        complete();
      });
      incoming.pipe(upstream);
    });
    modelProxy.on('connection', (socket) => {
      modelSockets.add(socket);
      socket.on('close', () => modelSockets.delete(socket));
    });
    await new Promise<void>((resolveListen, reject) => {
      modelProxy!.once('error', reject);
      modelProxy!.listen(0, '127.0.0.1', resolveListen);
    });
    const proxyAddress = modelProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string')
      throw new CapacityError('MODEL_OBSERVER_LISTEN_FAILED');
    // 仅当前测试进程临时改路由，所有字节仍流式转发到已配置真实网关。
    process.env.DSH_BASE_URL = `http://127.0.0.1:${proxyAddress.port}${upstreamBase.pathname}${upstreamBase.search}`;
    database = createDatabase(config.databaseUrl);
    storage = createStorage(config.s3);
    await Promise.all([checkDatabaseReady(database), storage.checkReady()]);
    tenant = `load-${randomUUID()}`;
    const environmentId = `capacity-${report.test_id}`,
      origin = 'http://127.0.0.1';
    report.isolation.tenant_digest = hash(tenant);
    const isolatedConfig = {
      ...config,
      appMode: 'demo' as const,
      demoAccessEnabled: true,
      cookieSecure: false,
      appOrigin: origin,
      sessionSecret: randomUUID() + randomUUID(),
      logLevel: 'silent' as const,
    };
    const services = createApplication({
      database,
      storage,
      config: isolatedConfig,
      generation: async () => 1,
    });
    await services.identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId,
      generation: 1,
    });
    const ownerIds = Array.from(
      { length: parameters.LOAD_USERS },
      (_, index) => `load-actor-${String(index + 1).padStart(3, '0')}`,
    );
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [index, id] of ownerIds.entries()) {
        await client.query(
          "INSERT INTO identities(tenant_id,id,external_subject,display_name,department_id,position,state) VALUES($1,$2,$2,$3,'dept-sales','隔离负载身份','active')",
          [tenant, id, `负载用户${index + 1}`],
        );
        await client.query(
          "INSERT INTO role_assignments(tenant_id,user_id,role,valid_from) VALUES($1,$2,'employee','2026-01-01T00:00:00Z')",
          [tenant, id],
        );
        for (const capability of [
          'skill.use',
          'expense.read.own',
          'travel.read.own',
          'oa.read.own',
        ])
          await client.query(
            "INSERT INTO grants(tenant_id,id,subject_id,capability,scope_type,scope_ids,effect) VALUES($1,$2,$3,$4,'self',$5,'allow')",
            [tenant, randomUUID(), id, capability, JSON.stringify([id])],
          );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    report.isolation.workload_users = ownerIds.length;
    app = createApp({
      database: () => checkDatabaseReady(database!),
      storage: () => storage!.checkReady(),
      dataMode: 'demo',
      logLevel: 'silent',
    });
    const identityOptions = {
      appMode: 'demo' as const,
      cookieSecure: false,
      allowedOrigins: [origin],
    };
    registerIdentityRoutes(app, {
      ...identityOptions,
      identity: services.identity,
      demoAccessGate: async (_request, input) => {
        if (
          input.demo_environment_id !== undefined &&
          input.demo_environment_id !== environmentId
        )
          throw new AppError('NOT_FOUND', '测试环境不存在。');
        return { tenantId: tenant!, environmentId, generation: 1 };
      },
    });
    const httpIdentity = createIdentityHttpContext(
      services.identity,
      identityOptions,
    );
    const actor = async (
      request: Parameters<typeof httpIdentity.requireActor>[0],
      write: boolean,
    ) => {
      if (write) await httpIdentity.assertCsrf(request);
      const current = await services.freshActor(
        await httpIdentity.requireActor(request),
      );
      if (current.tenant_id !== tenant)
        throw new AppError('NOT_FOUND', '测试身份不存在。');
      return current;
    };
    registerAssistantRoutes(app, { assistant: services.assistant, actor });
    registerRunRoutes(app, { runs: services.runs, actor });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    async function api(
      session: Session | null,
      method: string,
      path: string,
      body?: unknown,
      expected = [200, 201, 202],
    ) {
      allController.signal.throwIfAborted();
      const at = performance.now(),
        headers: Record<string, string> = { origin };
      if (session) headers.cookie = session.cookie;
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        headers['idempotency-key'] = randomUUID();
        if (session?.csrf) headers['x-csrf-token'] = session.csrf;
      }
      const response = await fetch(new URL(path, base), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([
          allController.signal,
          AbortSignal.timeout(10_000),
        ]),
      });
      latencies.push(performance.now() - at);
      recordCode(report.requests.http_status_counts, String(response.status));
      if (response.status === 429) report.rate_limits.http_429++;
      if (session) {
        const cookie = response.headers
          .getSetCookie()
          .find((value) => value.startsWith('caixiaozhi_session='));
        if (cookie) session.cookie = cookie.split(';')[0]!;
      }
      const payload = object(await response.json());
      if (!expected.includes(response.status))
        throw new CapacityError(
          typeof object(payload.error ?? {}).code === 'string'
            ? text(object(payload.error).code)
            : `HTTP_${response.status}`,
        );
      return object(payload.data ?? payload);
    }
    const sessions: Session[] = [];
    for (const [index, ownerId] of ownerIds.entries()) {
      const session: Session = {
        ownerId,
        label: `actor-${index + 1}`,
        cookie: '',
        csrf: '',
      };
      const me = await api(session, 'POST', '/api/v1/auth/demo/login', {
        demo_environment_id: environmentId,
        generation: 1,
        selected_user_id: ownerId,
      });
      session.csrf = text(me.csrf_token);
      if (!session.cookie) throw new CapacityError('LOGIN_COOKIE_MISSING');
      sessions.push(session);
    }
    // 先排队，再连接100条正式SSE；不通过sleep或固定回复延长实际模型调用。
    const accepted = await Promise.allSettled(
      Array.from({ length: parameters.LOAD_RUNS }, async (_, index) => {
        const owner = sessions[index % sessions.length]!,
          marker = `LOADCHECK_${randomUUID().replaceAll('-', '').toUpperCase()}`;
        const created = await api(owner, 'POST', '/api/v1/threads', {
          title: `容量只读任务${index + 1}`,
          initial_message: null,
        });
        const thread = object(created.thread);
        const result = await api(
          owner,
          'POST',
          `/api/v1/threads/${text(thread.id)}/messages`,
          {
            expected_version: count(thread.version),
            client_message_id: randomUUID(),
            intent: 'new_task',
            content: `本次为隔离的只读模型容量测试。请在首行逐字输出当前输入标记 ${marker}，然后仅对下列虚构培训材料做中文改写，至少${parameters.LOAD_OUTPUT_CHARS}字，分段连续输出直到完成。不得调用工具、保存记忆、创建任何业务对象或执行提交、审批、发布。材料：预算计划应记录目标、假设、来源与不确定性；数据不足应明确说明；金额需要明确单位；保留原始资料，区分已知事实与建议；人工决策应可复核。以上均是本测试提供的虚构训练文字，不是现行公司制度，不需查询或推断真实业务。`,
            resource_refs: [],
            attachment_ids: [],
          },
        );
        const run: WorkloadRun = {
          id: text(result.run_id),
          label: `run-${index + 1}`,
          owner,
          marker,
          createdAt: Date.now(),
          sdkStartedAt: null,
          final: null,
        };
        workload.push(run);
      }),
    );
    for (const result of accepted)
      if (result.status === 'rejected')
        report.reason_codes.push(safeCode(result.reason));
    report.requests.accepted_runs = workload.length;
    if (workload.length !== parameters.LOAD_RUNS)
      throw new CapacityError('RUN_ACCEPTANCE_INCOMPLETE');
    const markers = new Set(workload.map((run) => run.marker));
    for (const run of workload) {
      const other =
        sessions[
          (sessions.findIndex((session) => session === run.owner) + 1) %
            sessions.length
        ]!;
      for (const suffix of ['', '/events']) {
        report.isolation.cross_owner_checks++;
        const denied = await api(
          other,
          'GET',
          `/api/v1/runs/${run.id}${suffix}`,
          undefined,
          [404],
        );
        if (object(denied.error ?? {}).code === 'NOT_FOUND')
          report.isolation.cross_owner_denials++;
      }
    }
    const openSse = async (run: WorkloadRun, index: number) => {
      const controller = new AbortController();
      connections.push(controller);
      const entry: AgentCapacityReport['streams'][number] = {
        stream_label: `sse-${index + 1}`,
        run_label: run.label,
        status: 'connecting',
        first_seq: null,
        last_seq: 0,
        event_count: 0,
        duplicates: 0,
        gaps: 0,
        foreign_events: 0,
        foreign_markers: 0,
        event_digest: null,
        bytes_received: 0,
        error_code: null,
      };
      report.streams.push(entry);
      let opened = false,
        tail = '',
        assistantChars = 0;
      const digest = createHash('sha256');
      const openTimer = setTimeout(
        () => controller.abort(),
        parameters.LOAD_CONNECT_TIMEOUT_MS,
      );
      try {
        const response = await fetch(`${base}/api/v1/runs/${run.id}/events`, {
          headers: { cookie: run.owner.cookie, origin },
          signal: AbortSignal.any([controller.signal, allController.signal]),
        });
        clearTimeout(openTimer);
        recordCode(report.requests.http_status_counts, String(response.status));
        if (response.status === 429) report.rate_limits.http_429++;
        if (
          response.status !== 200 ||
          !response.headers
            .get('content-type')
            ?.includes('text/event-stream') ||
          !response.body
        )
          throw new CapacityError(`SSE_HTTP_${response.status}`);
        entry.status = 'open';
        opened = true;
        activeSse++;
        joint();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = '';
        const consume = (frame: string) => {
          const lines = frame.split('\n'),
            rawId = lines
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim(),
            rawData = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
          if (!rawData) return;
          const event = SseEventSchema.parse(JSON.parse(rawData));
          if (event.run_id !== run.id) {
            entry.foreign_events++;
            report.isolation.foreign_events++;
          }
          if (rawId !== String(event.seq)) entry.gaps++;
          if (event.seq <= entry.last_seq) entry.duplicates++;
          else if (event.seq !== entry.last_seq + 1) entry.gaps++;
          entry.first_seq ??= event.seq;
          entry.last_seq = event.seq;
          entry.event_count++;
          digest.update(
            `${event.seq}:${event.type}:${JSON.stringify(event.payload)}\n`,
          );
          const payload =
            event.payload && typeof event.payload === 'object'
              ? object(event.payload)
              : {};
          if (
            event.type === 'run.error' &&
            typeof payload.code === 'string' &&
            !modelErrorEvents.has(`${run.id}:${event.seq}`)
          ) {
            modelErrorEvents.add(`${run.id}:${event.seq}`);
            recordCode(report.rate_limits.model_error_codes, payload.code);
          }
          if (
            (event.type === 'assistant.delta' ||
              event.type === 'assistant.message') &&
            typeof payload.text === 'string'
          ) {
            const combined = tail + payload.text;
            for (const marker of combined.match(/LOADCHECK_[A-F0-9]{32}/g) ??
              [])
              if (marker !== run.marker && markers.has(marker)) {
                entry.foreign_markers++;
                report.isolation.foreign_markers++;
              }
            if (combined.includes(run.marker))
              streamOwnMarker.set(run.id, true);
            if (event.type === 'assistant.delta') {
              assistantChars += payload.text.length;
              streamOutputChars.set(
                run.id,
                Math.max(streamOutputChars.get(run.id) ?? 0, assistantChars),
              );
            } else
              streamOutputChars.set(
                run.id,
                Math.max(
                  streamOutputChars.get(run.id) ?? 0,
                  payload.text.length,
                ),
              );
            tail = combined.slice(-100);
          }
        };
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            entry.bytes_received += chunk.value.byteLength;
            buffer += decoder
              .decode(chunk.value, { stream: true })
              .replaceAll('\r\n', '\n');
            if (buffer.length > 8_000_000)
              throw new CapacityError('SSE_BUFFER_EXCEEDED');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              consume(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) consume(buffer);
          entry.status = 'closed';
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        entry.status =
          allController.signal.aborted || controller.signal.aborted
            ? 'aborted'
            : 'failed';
        entry.error_code = safeCode(error);
      } finally {
        clearTimeout(openTimer);
        if (opened) {
          activeSse--;
          joint();
        }
        entry.event_digest = digest.digest('hex');
      }
    };
    for (let index = 0; index < parameters.LOAD_SSE; index++)
      streamTasks.push(openSse(workload[index % workload.length]!, index));
    const connectDeadline = Date.now() + parameters.LOAD_CONNECT_TIMEOUT_MS;
    while (activeSse < parameters.LOAD_SSE) {
      allController.signal.throwIfAborted();
      if (
        Date.now() > connectDeadline ||
        report.streams.some((stream) =>
          ['failed', 'aborted'].includes(stream.status),
        )
      )
        throw new CapacityError('SSE_CONNECTION_TARGET_NOT_REACHED');
      await delay(25);
    }
    const stopLateRuntime = async (handle: RuntimeHandle) => {
      try {
        const result = await bounded(
          services.runtime.stop(handle, 'shutdown'),
          5000,
          'LATE_RUNTIME_STOP_TIMEOUT',
        );
        if (!result.process_stopped) runtimeStopFailed = true;
        await bounded(
          services.runtime.dispose(handle),
          5000,
          'LATE_RUNTIME_DISPOSE_TIMEOUT',
        );
      } catch (error) {
        runtimeStopFailed = true;
        throw error;
      }
    };
    const runtime: AgentRuntimeAdapter = {
      start: async (input) => {
        if (allController.signal.aborted)
          throw new CapacityError('LOAD_STOPPED_BEFORE_RUNTIME_START');
        const handle = await services.runtime.start(input);
        if (allController.signal.aborted) {
          await stopLateRuntime(handle);
          throw new CapacityError('LOAD_STOPPED_AFTER_RUNTIME_START');
        }
        handles.set(handle.runtime_instance_id, handle);
        const run = workload.find((run) => run.id === input.run_id);
        if (run) run.sdkStartedAt = Date.now();
        joint();
        return handle;
      },
      continue: async (input) => {
        if (allController.signal.aborted)
          throw new CapacityError('LOAD_STOPPED_BEFORE_RUNTIME_CONTINUE');
        const handle = await services.runtime.continue(input);
        if (allController.signal.aborted) {
          await stopLateRuntime(handle);
          throw new CapacityError('LOAD_STOPPED_AFTER_RUNTIME_CONTINUE');
        }
        handles.set(handle.runtime_instance_id, handle);
        joint();
        return handle;
      },
      stop: async (handle, reason) => {
        try {
          const result = await services.runtime.stop(handle, reason);
          if (!result.process_stopped) runtimeStopFailed = true;
          return result;
        } finally {
          handles.delete(handle.runtime_instance_id);
          joint();
        }
      },
      dispose: async (handle) => {
        try {
          await services.runtime.dispose(handle);
        } finally {
          handles.delete(handle.runtime_instance_id);
          joint();
        }
      },
    };
    runner = createWorkerRunner({
      runs: services.runs,
      runtime,
      buildInput: services.buildRuntimeInput,
      freshActor: services.freshActor,
      claimScope: async () => ({ tenant_id: tenant }),
      workerId: `capacity-${report.test_id}`,
      concurrency: 20,
      pollMs: 50,
      log: (event) => {
        if (event.code)
          recordCode(report.rate_limits.worker_error_codes, event.code);
      },
    });
    let previousCpu = process.cpuUsage(),
      previousAt = performance.now(),
      lastPsAt = 0,
      descendants: ProcessRow[] | null = null;
    const sample = async () => {
      if (sampleBusy) return;
      sampleBusy = true;
      try {
        const now = performance.now(),
          cpu = process.cpuUsage(),
          elapsed = Math.max(1, now - previousAt);
        const state = await database!.pool.query(
          "SELECT count(*) FILTER(WHERE runtime_active)::int active,count(*) FILTER(WHERE status='queued')::int queued,(SELECT count(*)::int FROM model_slots WHERE tenant_id=$1 AND released_at IS NULL AND lease_until>clock_timestamp()) slots FROM agent_runs WHERE tenant_id=$1",
          [tenant],
        );
        if (now - lastPsAt >= 1000) {
          try {
            descendants = await processTree();
            report.resources.ps_available = true;
          } catch {
            report.resources.ps_available = false;
            descendants = null;
          }
          lastPsAt = now;
        }
        const active = Number(state.rows[0]?.active ?? 0),
          slots = Number(state.rows[0]?.slots ?? 0);
        report.concurrency.peak_runtime_active_rows = Math.max(
          report.concurrency.peak_runtime_active_rows,
          active,
        );
        report.concurrency.peak_live_model_slots = Math.max(
          report.concurrency.peak_live_model_slots,
          slots,
        );
        joint();
        report.resources.samples.push({
          at_ms: Date.now() - started,
          rss_bytes: process.memoryUsage().rss,
          node_cpu_percent:
            Math.round(
              ((cpu.user + cpu.system - previousCpu.user - previousCpu.system) /
                1000 /
                elapsed) *
                10000,
            ) / 100,
          descendant_processes: descendants?.length ?? null,
          descendant_rss_bytes:
            descendants?.reduce((sum, row) => sum + row.rss, 0) ?? null,
          descendant_cpu_percent_from_ps:
            descendants?.reduce((sum, row) => sum + row.cpu, 0) ?? null,
          runtime_active: active,
          live_slots: slots,
          queued: Number(state.rows[0]?.queued ?? 0),
          sdk_handles: handles.size,
          model_http_in_flight: modelInFlight,
          sse_connections: activeSse,
        });
        previousCpu = cpu;
        previousAt = now;
      } catch (error) {
        recordCode(report.rate_limits.worker_error_codes, safeCode(error));
      } finally {
        sampleBusy = false;
      }
    };
    sampling = setInterval(() => void sample(), parameters.LOAD_SAMPLE_MS);
    workerStartedAt = Date.now();
    runner.start();
    await sample();
    while (true) {
      allController.signal.throwIfAborted();
      const finalRows = await database.pool.query(
        'SELECT id,status,error_code,usage,last_seq,created_at,started_at FROM agent_runs WHERE tenant_id=$1',
        [tenant],
      );
      for (const row of finalRows.rows) {
        const run = workload.find((run) => run.id === row.id);
        if (run)
          run.final = object({
            ...row,
            created_at: new Date(row.created_at).toISOString(),
            started_at: row.started_at
              ? new Date(row.started_at).toISOString()
              : null,
          });
      }
      if (
        workload.every(
          (run) => run.final && TERMINAL.has(text(run.final.status)),
        )
      )
        break;
      if (
        workload.some(
          (run) =>
            run.final &&
            ['waiting_user', 'waiting_confirmation', 'interrupted'].includes(
              text(run.final.status),
            ),
        )
      )
        throw new CapacityError('READ_ONLY_RUN_DID_NOT_TERMINATE');
      await delay(100, undefined, { signal: allController.signal });
    }
    await bounded(Promise.all(streamTasks), 15_000, 'SSE_FINAL_CLOSE_TIMEOUT');
    await sample();
    joint();
    await summarizeRuns();
    if (
      report.concurrency.peak_joint_active_runs < 20 ||
      report.concurrency.longest_joint_ms < parameters.LOAD_MIN_JOINT_MS
    )
      report.reason_codes.push('ACTIVE20_WITH_SSE100_NOT_SUSTAINED');
    if (
      report.concurrency.peak_runtime_active_rows < 20 ||
      report.concurrency.peak_live_model_slots < 20
    )
      report.reason_codes.push('PERSISTED_ACTIVE20_NOT_OBSERVED');
    if (report.resources.ps_available !== true)
      report.reason_codes.push('CHILD_RESOURCE_METRICS_UNAVAILABLE');
    if (
      report.runs.some(
        (run) => run.status !== 'succeeded' || run.model_calls < 1,
      )
    )
      report.reason_codes.push('REAL_MODEL_RUNS_NOT_ALL_SUCCEEDED');
    if (report.runs.some((run) => !run.own_marker_seen))
      report.reason_codes.push('OWN_CONTEXT_MARKER_NOT_OBSERVED');
    if (
      report.isolation.cross_owner_denials !==
        report.isolation.cross_owner_checks ||
      report.isolation.foreign_events ||
      report.isolation.foreign_markers ||
      !report.isolation.read_only
    )
      report.reason_codes.push('ISOLATION_OR_READONLY_FAILED');
    for (const run of workload) {
      const streams = report.streams.filter(
        (stream) => stream.run_label === run.label,
      );
      if (
        streams.some(
          (stream) =>
            stream.status !== 'closed' ||
            stream.duplicates ||
            stream.gaps ||
            stream.first_seq !== 1 ||
            stream.last_seq !== Number(run.final?.last_seq),
        ) ||
        new Set(streams.map((stream) => stream.event_digest)).size !== 1
      )
        report.reason_codes.push('SSE_SEQUENCE_OR_REPLICA_MISMATCH');
    }
    report.status = report.reason_codes.length ? 'not_achieved' : 'passed';
    report.exit_code = report.status === 'passed' ? 0 : 1;
  } catch (error) {
    const code = allController.signal.aborted
      ? 'CAPACITY_TIMEOUT_OR_CANCELLED'
      : safeCode(error);
    report.reason_codes.push(code);
    if (!database) {
      report.status = 'blocked';
      report.exit_code = 2;
    } else {
      report.status = 'failed';
      report.exit_code = 1;
    }
  } finally {
    clearTimeout(totalTimer);
    clearInterval(sampling);
    allController.abort();
    for (const connection of connections) connection.abort();
    if (processSignalHandler) {
      process.removeListener('SIGINT', processSignalHandler);
      process.removeListener('SIGTERM', processSignalHandler);
    }
    await bounded(
      (async () => {
        while (sampleBusy) await delay(25);
      })(),
      5000,
      'RESOURCE_SAMPLE_STOP_TIMEOUT',
    ).catch((error) => report.cleanup.error_codes.push(safeCode(error)));
    await bounded(
      Promise.allSettled(streamTasks),
      5000,
      'SSE_CLEANUP_TIMEOUT',
    ).catch((error) => report.cleanup.error_codes.push(safeCode(error)));
    report.cleanup.connections_closed = activeSse === 0;
    if (runner) {
      try {
        await bounded(runner.stop(), 20_000, 'WORKER_STOP_TIMEOUT');
        report.cleanup.worker_graceful = !runtimeStopFailed;
        report.cleanup.worker_quiescent = runner.activeCount === 0;
        if (runtimeStopFailed)
          report.cleanup.error_codes.push('RUNTIME_STOP_UNCONFIRMED');
      } catch (error) {
        report.cleanup.worker_graceful = false;
        report.cleanup.worker_quiescent = false;
        report.cleanup.error_codes.push(safeCode(error));
      }
    }
    if (report.cleanup.worker_graceful === false) {
      try {
        const descendants = await processTree();
        for (const row of descendants) {
          try {
            process.kill(row.pid, 'SIGTERM');
            report.cleanup.forced_descendants++;
          } catch {}
        }
        await delay(500);
        for (const row of [...descendants, ...(await processTree())])
          try {
            process.kill(row.pid, 'SIGKILL');
          } catch {}
      } catch (error) {
        report.cleanup.error_codes.push(safeCode(error));
      }
      if (runner) {
        try {
          await bounded(
            runner.waitForIdle(),
            5000,
            'WORKER_QUIESCENCE_TIMEOUT',
          );
          report.cleanup.worker_quiescent = runner.activeCount === 0;
        } catch (error) {
          report.cleanup.worker_quiescent = false;
          report.cleanup.error_codes.push(safeCode(error));
        }
      }
    }
    if (modelProxy) {
      for (const request of upstreamRequests) request.destroy();
      for (const socket of modelSockets) socket.destroy();
      await bounded(
        new Promise<void>((resolveClose, reject) =>
          modelProxy!.close((error) =>
            error ? reject(error) : resolveClose(),
          ),
        ),
        5000,
        'MODEL_OBSERVER_CLOSE_TIMEOUT',
      ).catch((error) => report.cleanup.error_codes.push(safeCode(error)));
      if (report.cleanup.worker_quiescent !== false) {
        if (originalModelBase === undefined) delete process.env.DSH_BASE_URL;
        else process.env.DSH_BASE_URL = originalModelBase;
      }
    }
    if (app) {
      try {
        await bounded(app.close(), 5000, 'HTTP_CLOSE_TIMEOUT');
        report.cleanup.http_closed = true;
      } catch (error) {
        app.server.closeAllConnections();
        report.cleanup.http_closed = false;
        report.cleanup.error_codes.push(safeCode(error));
      }
    }
    if (database && tenant) {
      await bounded(summarizeRuns(), 5000, 'FINAL_RUN_STATUS_TIMEOUT').catch(
        (error) => report.cleanup.error_codes.push(safeCode(error)),
      );
      if (report.cleanup.worker_quiescent === false) {
        // 未证实停止时保留隔离测试数据，防止迟到写入与删除并发。
        report.cleanup.error_codes.push(
          'TEST_DATA_RETAINED_UNTIL_WORKER_STOP_VERIFIED',
        );
      } else {
        try {
          const cleanup = await bounded(
            removeTenant(database, tenant),
            15_000,
            'TENANT_CLEANUP_TIMEOUT',
          );
          report.cleanup.tenant_rows_removed = cleanup.removed;
          report.cleanup.tenant_rows_remaining = cleanup.remaining;
        } catch (error) {
          report.cleanup.error_codes.push(safeCode(error));
        }
        try {
          await rm(join(WORKSPACE_ROOT, '.runtime/dsh', hash(tenant)), {
            recursive: true,
            force: true,
          });
          report.cleanup.runtime_directory_removed = true;
        } catch (error) {
          report.cleanup.runtime_directory_removed = false;
          report.cleanup.error_codes.push(safeCode(error));
        }
      }
    }
    storage?.close();
    if (database)
      await bounded(database.close(), 5000, 'DATABASE_CLOSE_TIMEOUT').catch(
        (error) => report.cleanup.error_codes.push(safeCode(error)),
      );
    if (report.cleanup.error_codes.length && report.exit_code === 0) {
      report.status = 'failed';
      report.exit_code = 1;
      report.reason_codes.push('CLEANUP_INCOMPLETE');
    }
    report.reason_codes = [...new Set(report.reason_codes)];
    await persist();
  }
  return report;
}
