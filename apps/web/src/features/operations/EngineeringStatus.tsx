import { useCallback, useEffect, useRef, useState } from 'react';
import { checkHealth, type HealthCheck } from '../../health.js';

type Status = 'loading' | 'ready' | 'unavailable' | 'error';
type Snapshot = {
  live: HealthCheck | null;
  ready: HealthCheck | null;
  checkedAt: Date | null;
};

const statusLabels: Record<Status, string> = {
  loading: '检查中',
  ready: '可用',
  unavailable: '未就绪',
  error: '检查失败',
};

function StatusLabel({ status }: { status: Status }) {
  return (
    <span className={`status status--${status}`}>{statusLabels[status]}</span>
  );
}

function getDependencyStatus(
  check: HealthCheck | null,
  dependency: 'database' | 'storage',
): Status {
  if (!check) return 'loading';
  if (check.kind === 'error') return 'error';

  const dependencies =
    check.kind === 'not_ready'
      ? check.dependencies
      : check.response.data.dependencies;

  return dependencies?.[dependency] === 'ready' ? 'ready' : 'unavailable';
}

function formatTime(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }).format(value);
}

export function EngineeringStatus() {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    live: null,
    ready: null,
    checkedAt: null,
  });
  const [loading, setLoading] = useState(true);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setSnapshot({ live: null, ready: null, checkedAt: null });

    try {
      await Promise.all(
        (['live', 'ready'] as const).map(async (endpoint) => {
          const check = await checkHealth(endpoint, controller.signal);

          if (!controller.signal.aborted) {
            setSnapshot((current) => ({ ...current, [endpoint]: check }));
          }
        }),
      );
    } finally {
      if (!controller.signal.aborted) {
        setSnapshot((current) => ({ ...current, checkedAt: new Date() }));
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => activeRequest.current?.abort();
  }, [refresh]);

  const processStatus: Status = !snapshot.live
    ? 'loading'
    : snapshot.live.kind === 'available'
      ? 'ready'
      : 'error';
  const databaseStatus = getDependencyStatus(snapshot.ready, 'database');
  const storageStatus = getDependencyStatus(snapshot.ready, 'storage');
  const hasError =
    snapshot.live?.kind === 'error' || snapshot.ready?.kind === 'error';
  const hasUnavailable = snapshot.ready?.kind === 'not_ready';
  const summary = loading
    ? '正在检查工程依赖'
    : hasError
      ? '健康检查未完成'
      : hasUnavailable
        ? '基础依赖尚未就绪'
        : '基础服务已就绪';
  const summaryText = loading
    ? '正在向 API 请求当前状态，请稍候。'
    : hasError
      ? '请查看下方检查结果，确认服务运行状态后重新检查。'
      : hasUnavailable
        ? 'API 已返回检查结果，部分基础依赖需要恢复。'
        : 'API 进程、数据库与私有文件存储均已通过本次检查。';
  const meta =
    snapshot.live?.kind === 'available'
      ? snapshot.live.response.meta
      : snapshot.ready?.kind === 'available'
        ? snapshot.ready.response.meta
        : snapshot.ready?.kind === 'not_ready'
          ? snapshot.ready.meta
          : null;

  return (
    <div className="page-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="财小智工程状态首页">
          <svg
            className="brand-mark"
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="2"
              y="2"
              width="24"
              height="24"
              rx="7"
              fill="currentColor"
            />
            <path
              d="M8 18V10H13M8 14H12M15 10H20L15 18H20"
              stroke="#fff"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>财小智</span>
        </a>
        <span className="header-context">基础服务检查</span>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <h1>基础服务状态</h1>
            <p className="page-description">
              检查 API 进程、PostgreSQL 与私有文件存储的当前连通状态。
            </p>
          </div>
          <button
            className="refresh-button"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <svg
              className={loading ? 'refresh-icon is-spinning' : 'refresh-icon'}
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M16.4 8A6.5 6.5 0 1 0 16 13M16.5 3.5V8H12"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {loading ? '正在检查' : '刷新状态'}
          </button>
        </div>

        <section
          className="health-section"
          aria-labelledby="health-title"
          aria-busy={loading}
        >
          <div className="health-summary" role="status" aria-live="polite">
            <span
              className={`summary-indicator summary-indicator--${loading ? 'loading' : hasError ? 'error' : hasUnavailable ? 'unavailable' : 'ready'}`}
              aria-hidden="true"
            />
            <div>
              <h2 id="health-title">{summary}</h2>
              <p>{summaryText}</p>
            </div>
          </div>

          <div className="service-list">
            <div className="service-row">
              <div className="service-heading">
                <h3>API 进程</h3>
                <span>Fastify 服务</span>
              </div>
              <div className="service-detail">
                <code>GET /api/v1/health/live</code>
                {snapshot.live?.kind === 'error' && (
                  <p className="error-message">{snapshot.live.message}</p>
                )}
              </div>
              <StatusLabel status={processStatus} />
            </div>
            <div className="service-row">
              <div className="service-heading">
                <h3>数据库</h3>
                <span>PostgreSQL</span>
              </div>
              <div className="service-detail">
                <p>通过就绪检查验证数据库连接</p>
                {databaseStatus === 'unavailable' && (
                  <p className="dependency-message">
                    数据库暂不可用，请检查数据库服务与连接配置。
                  </p>
                )}
              </div>
              <StatusLabel status={databaseStatus} />
            </div>
            <div className="service-row">
              <div className="service-heading">
                <h3>私有文件存储</h3>
                <span>S3 兼容对象存储</span>
              </div>
              <div className="service-detail">
                <p>通过就绪检查验证私有存储可用性</p>
                {storageStatus === 'unavailable' && (
                  <p className="dependency-message">
                    私有存储暂不可用，请检查存储服务与访问配置。
                  </p>
                )}
              </div>
              <StatusLabel status={storageStatus} />
            </div>
          </div>

          <div className="health-footnote">
            <code>GET /api/v1/health/ready</code>
            <span>数据库与私有存储共用就绪检查</span>
          </div>
          {snapshot.ready?.kind === 'error' && (
            <p className="readiness-error" role="alert">
              {snapshot.ready.message}
            </p>
          )}
        </section>

        <section className="scope-section" aria-labelledby="scope-title">
          <div>
            <h2 id="scope-title">当前验证范围</h2>
            <p>本页验证 Web、API 与基础依赖的最小运行链路。</p>
          </div>
          <div className="next-stage">
            <span className="stage-label">独立验收</span>
            <h3>dsh Agent 运行时</h3>
            <p>
              dsh SDK
              已接入；真实模型与业务工具是否可用，需通过对应任务和独立验收确认。
            </p>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span>
          {snapshot.checkedAt
            ? `本次检查于 ${formatTime(snapshot.checkedAt)}（北京时间）`
            : '正在获取实时健康状态'}
        </span>
        <span>
          {meta?.data_mode
            ? `数据模式 ${meta.data_mode}`
            : loading
              ? '等待 API 返回运行元数据'
              : '运行元数据暂不可用'}
        </span>
      </footer>
    </div>
  );
}
