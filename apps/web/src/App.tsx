import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  MeSchema,
  DemoLoginInputSchema,
  DemoSwitchInputSchema,
  type Me,
} from '@caixiaozhi/contracts/identity';
import { api, ApiFailure, setApiSession } from './api.js';
import { ErrorNotice } from './ui.js';
import { EngineeringStatus } from './features/operations/EngineeringStatus.js';
const AssistantPage = lazy(() =>
  import('./features/assistant/AssistantPage.js').then((module) => ({
    default: module.AssistantPage,
  })),
);
const BusinessPage = lazy(() =>
  import('./features/business/BusinessPage.js').then((module) => ({
    default: module.BusinessPage,
  })),
);
const FinancePage = lazy(() =>
  import('./features/finance/FinancePage.js').then((module) => ({
    default: module.FinancePage,
  })),
);
const PersonalPage = lazy(() =>
  import('./features/personal/PersonalPage.js').then((module) => ({
    default: module.PersonalPage,
  })),
);
const OperationsPage = lazy(() =>
  import('./features/operations/OperationsPage.js').then((module) => ({
    default: module.OperationsPage,
  })),
);

type Person = {
  id: string;
  display_name: string;
  department_name: string;
  roles: string[];
  position: string;
};
type Catalog = {
  demo_environment_id: string;
  generation: number;
  identities: Person[];
};
const navigation = [
  ['assistant', '财务助理'],
  ['travel', '差旅申请'],
  ['expenses', '票据与报销'],
  ['oa', '前置申请'],
  ['approvals', '待我审批'],
  ['knowledge', '制度与规则'],
  ['analytics', '费用分析'],
  ['skills', 'Skills'],
  ['personal', '记忆与提醒'],
  ['operations', '运行与演示'],
] as const;
const roleLabels: Record<string, string> = {
  employee: '员工',
  manager: '主管',
  finance: '财务',
  platform_admin: '平台管理员',
};

export function App() {
  const [me, setMe] = useState<Me | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState(
    new URLSearchParams(location.search).get('page') ?? 'assistant',
  );
  const clear = useCallback(() => {
    setMe(null);
    setError(null);
    setCatalog(null);
    void api<Catalog>('/auth/demo/identities')
      .then(setCatalog)
      .catch(() => {});
  }, []);
  const refreshIdentity = useCallback(async () => {
    const value = MeSchema.parse(await api('/me'));
    setApiSession(value, clear);
    setMe(value);
    return value;
  }, [clear]);
  useEffect(() => {
    let active = true;
    void (async () => {
      for (let attempt = 0; active && attempt < 20; attempt++) {
        const [identity, identities] = await Promise.allSettled([
          api('/me'),
          api<Catalog>('/auth/demo/identities'),
        ]);
        if (!active) return;
        if (identities.status === 'fulfilled') setCatalog(identities.value);
        if (identity.status === 'fulfilled') {
          const value = MeSchema.parse(identity.value);
          setApiSession(value, clear);
          setMe(value);
          setLoading(false);
          return;
        }
        if (
          identities.status === 'fulfilled' ||
          (identities.status === 'rejected' &&
            identities.reason instanceof ApiFailure &&
            identities.reason.status === 404)
        ) {
          setLoading(false);
          return;
        }
        if (attempt === 19) {
          setError(
            new Error('暂时无法连接应用服务，请检查基础服务后刷新页面。'),
          );
          setLoading(false);
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(500 + attempt * 250, 2000)),
        );
      }
    })();
    const changed = () =>
      setPage(new URLSearchParams(location.search).get('page') ?? 'assistant');
    window.addEventListener('popstate', changed);
    return () => {
      active = false;
      window.removeEventListener('popstate', changed);
    };
  }, [refreshIdentity]);
  useEffect(() => {
    if (!me) return;
    let active = true,
      inFlight = false;
    const check = async () => {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const latest = MeSchema.parse(await api('/me'));
        if (
          active &&
          (latest.actor.authz_version !== me.actor.authz_version ||
            latest.actor.user_id !== me.actor.user_id ||
            latest.actor.tenant_id !== me.actor.tenant_id)
        ) {
          setApiSession(latest, clear);
          setMe(latest);
          setError(new Error('当前权限已更新，工作空间已刷新。'));
        }
      } catch {
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void check(), 15000);
    window.addEventListener('focus', check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [me?.actor.authz_version, me?.actor.user_id, me?.actor.tenant_id, clear]);
  const navigate = (next: string) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('page', next);
    history.pushState(null, '', url);
    setPage(next);
  };
  const login = async (person: Person) => {
    if (!catalog) return;
    setBusy(true);
    setError(null);
    try {
      await api(me ? '/auth/demo/switch' : '/auth/demo/login', {
        method: 'POST',
        body: me
          ? DemoSwitchInputSchema.parse({
              selected_user_id: person.id,
              generation: catalog.generation,
            })
          : DemoLoginInputSchema.parse({
              selected_user_id: person.id,
              demo_environment_id: catalog.demo_environment_id,
              generation: catalog.generation,
            }),
      });
      const current = await refreshIdentity();
      navigate(
        current.actor.permissions.some(
          (permission) =>
            permission.includes('.read.') || permission === 'skill.use',
        )
          ? 'assistant'
          : 'operations',
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      setApiSession(null, clear);
      clear();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (location.pathname === '/status') return <EngineeringStatus />;
  if (loading)
    return (
      <main className="application-loading" role="status">
        正在读取当前会话…
      </main>
    );
  if (!me)
    return (
      <main className="login-page">
        <div className="login-heading">
          <span className="brand-mark" aria-hidden="true">
            财
          </span>
          <h1>财小智</h1>
          <p>从一件财务小事开始</p>
        </div>
        <div className="environment-line">合成演示环境</div>
        <h2>选择本次演示身份</h2>
        <p className="muted">
          身份和权限由服务端读取，每次切换都会退出旧会话。
        </p>
        <ErrorNotice error={error} />
        {catalog ? (
          <div className="identity-list">
            {catalog.identities.map((person) => (
              <button
                key={person.id}
                disabled={busy}
                onClick={() => void login(person)}
              >
                <span className="identity-avatar">
                  {person.display_name.slice(-1)}
                </span>
                <span>
                  <strong>{person.display_name}</strong>
                  <small>
                    {person.department_name} ·{' '}
                    {person.roles
                      .map((role) => roleLabels[role] ?? role)
                      .join(' / ')}
                  </small>
                  <span className="muted">{person.position}</span>
                </span>
                <svg
                  className="identity-arrow"
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path
                    d="M4 10h11m-4-4 4 4-4 4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                </svg>
              </button>
            ))}
          </div>
        ) : (
          <p role="status">身份入口尚未启用，请检查基础服务与演示环境配置。</p>
        )}
        <a href="/status">查看基础服务状态</a>
      </main>
    );
  const canApprove = me.actor.permissions.includes('approval.decide');
  const isAdmin = me.actor.permissions.some((permission) =>
    ['operations.read', 'integration.manage', 'demo.control'].includes(
      permission,
    ),
  );
  return (
    <div className="application-root">
      <aside className="app-sidebar">
        <button className="app-brand" onClick={() => navigate('assistant')}>
          <span className="brand-mark" aria-hidden="true">
            财
          </span>
          <span>
            财小智<small>财务个人助理</small>
          </span>
        </button>
        <button
          className="new-conversation"
          onClick={() => {
            navigate('assistant');
            window.dispatchEvent(new Event('new-finance-conversation'));
          }}
        >
          开始新任务
        </button>
        <nav aria-label="主要功能">
          {navigation
            .filter(([id]) => id !== 'approvals' || canApprove)
            .filter(([id]) => id !== 'operations' || isAdmin)
            .map(([id, label]) => (
              <button
                key={id}
                className={page === id ? 'active' : ''}
                onClick={() => navigate(id)}
                aria-current={page === id ? 'page' : undefined}
              >
                {label}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="environment-pill">演示数据</span>
          <p>所有人员、票据与制度均为合成样本。</p>
          <a href="/status">基础服务状态</a>
        </div>
      </aside>
      <div className="app-content">
        <header className="app-topbar">
          <div>
            <span className="status-dot" aria-hidden="true" />
            个人工作空间
          </div>
          <div className="identity-control">
            <span>
              {me.display_name}
              <small>{me.department_name}</small>
            </span>
            {catalog && (
              <select
                aria-label="切换演示身份"
                value={me.actor.user_id}
                disabled={busy}
                onChange={(event) => {
                  const person = catalog.identities.find(
                    (value) => value.id === event.target.value,
                  );
                  if (person) void login(person);
                }}
              >
                {catalog.identities.map((person) => (
                  <option value={person.id} key={person.id}>
                    {person.display_name} · {person.department_name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void logout()}
            >
              退出
            </button>
          </div>
        </header>
        <ErrorNotice error={error} />
        {busy ? (
          <main className="application-loading" role="status">
            正在更新会话…
          </main>
        ) : (
          <main
            className="workspace"
            key={`${me.actor.tenant_id}:${me.actor.user_id}:${me.actor.authz_version}`}
          >
            <Suspense
              fallback={
                <p role="status" className="loading-line">
                  正在读取功能…
                </p>
              }
            >
              {page === 'assistant' ? (
                <AssistantPage me={me} />
              ) : ['travel', 'expenses', 'oa', 'approvals'].includes(page) ? (
                <BusinessPage
                  kind={page as 'travel' | 'expenses' | 'oa' | 'approvals'}
                  me={me}
                />
              ) : ['knowledge', 'analytics', 'skills'].includes(page) ? (
                <FinancePage
                  section={page as 'knowledge' | 'analytics' | 'skills'}
                  me={me}
                />
              ) : page === 'personal' ? (
                <PersonalPage me={me} />
              ) : page === 'operations' && isAdmin ? (
                <OperationsPage me={me} />
              ) : (
                <AssistantPage me={me} />
              )}
            </Suspense>
          </main>
        )}
      </div>
    </div>
  );
}
