import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000';
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 20),
  requests = Number(process.env.LOAD_REQUESTS ?? 200);
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 100 ||
  !Number.isInteger(requests) ||
  requests < concurrency ||
  requests > 10000
)
  throw new Error('负载参数无效。');
let cursor = 0,
  failures = 0;
const latencies: number[] = [];
const started = performance.now();
try {
  const preflight = await fetch(`${base}/api/v1/health/ready`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!preflight.ok) throw new Error('依赖未就绪。');
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor++ < requests) {
        const at = performance.now();
        try {
          const response = await fetch(`${base}/api/v1/health/ready`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) failures++;
          await response.arrayBuffer();
        } catch {
          failures++;
        }
        latencies.push(performance.now() - at);
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  const elapsed = performance.now() - started;
  const result = {
    scope: '真实HTTP与数据库/S3就绪探测，不代表Agent并发或100条SSE容量',
    requests: latencies.length,
    concurrency,
    failures,
    elapsed_ms: Math.round(elapsed),
    rps: Math.round((latencies.length / elapsed) * 1000),
    p50_ms: Math.round(latencies[Math.floor(latencies.length * 0.5)] ?? 0),
    p95_ms: Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0),
    p99_ms: Math.round(latencies[Math.floor(latencies.length * 0.99)] ?? 0),
    measured_at: new Date().toISOString(),
  };
  await mkdir('docs/verification', { recursive: true });
  await writeFile(
    'docs/verification/load-latest.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'load.blocked',
      message: error instanceof Error ? error.message : '无法连接待测服务。',
      base_url: base,
    }),
  );
  process.exitCode = 2;
}
