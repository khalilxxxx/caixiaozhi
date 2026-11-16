import { runAgentCapacityTest } from '../tests/load/agent-runs.js';

try {
  const report = await runAgentCapacityTest();
  process.stdout.write(
    JSON.stringify({
      event: 'agent.capacity.result',
      status: report.status,
      reason_codes: report.reason_codes,
      actual: report.concurrency,
      accepted_runs: report.requests.accepted_runs,
      completed_runs: report.runs.filter((run) => run.status === 'succeeded')
        .length,
      exit_code: report.exit_code,
    }) + '\n',
  );
  process.exitCode = report.exit_code;
  // 清理失败已写入报告；此兜底只防遗留库句柄使CLI永久挂起。
  if (report.cleanup.error_codes.length)
    setTimeout(() => process.exit(report.exit_code), 1000).unref();
} catch {
  process.stderr.write(
    JSON.stringify({
      event: 'agent.capacity.report_failed',
      status: 'failed',
      message: '容量报告保存失败，未输出模型或认证正文。',
    }) + '\n',
  );
  process.exitCode = 1;
}
