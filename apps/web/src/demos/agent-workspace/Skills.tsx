import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  useSlice,
  useWorkspace,
  type ContextRef,
  type PanelSpec,
} from './workspace';
import { Badge, Button, Empty, Field, Icon, Section } from './ui';
import './analytics-skills.css';
import './skills-catalog.css';
import { useToolCatalog } from './tool-catalog';
import { ToolDetailPanel } from './ToolDetailPanel';
import { CatalogMark } from './CatalogMark';
import { SkillDocument } from './SkillDocument';
import { SkillFiles } from './SkillFiles';
import './skill-detail.css';
import {
  available,
  catalogArea,
  type CatalogArea,
  currentVersion,
  filterCatalog,
  formatCatalogUpdatedAt,
  readCatalogRoute,
  reviewStage,
  skillCatalogItem,
  skillDocumentText,
  skillUnavailableReason,
  writeCatalogRoute,
  type CatalogItem,
  type CatalogRoute,
  type Conclusion,
  type Skill,
  type SkillVersion,
  type VersionStatus,
} from './skills-catalog-model';
import { ToolCenterEmbed } from './ToolCenterEmbed';
import { api, uploadFile } from './runtime-client';
import {
  inspectedSkillDraft,
  skillExecutionBlock,
  type SkillFile,
  type SkillInspection,
} from './skill-package-model';

interface SkillDraft {
  name: string;
  category: string;
  version: string;
  description: string;
  file: SkillFile | null;
}
interface Hub {
  skills: Skill[];
  skillDrafts?: Record<string, SkillDraft>;
}
const emptySkillDraft: SkillDraft = {
  name: '',
  category: '数据分析',
  version: '1.0.0',
  description: '',
  file: null,
};
const released = (
  version: string,
  mode: 'runnable' | 'storage' = 'runnable',
): SkillVersion => ({
  version,
  status: 'published',
  business: 'pass',
  security: 'pass',
  compatibility: mode === 'runnable' ? 'pass' : 'fail',
  technical: 'pass',
  mode,
  note:
    mode === 'runnable'
      ? '已核对输入、输出与适用范围。'
      : '保留内容资料；当前运行环境不支持。',
  updated: '2026-11-12',
  events: [
    '2026-11-12 · 业务审核通过',
    '2026-11-12 · 技术审核通过',
    `2026-11-12 · ${mode === 'runnable' ? '可调用版本已上架' : '仅存储版本已上架'}`,
  ],
});
const seedSkills: Skill[] = [
  {
    id: 'monthly-analysis',
    title: '月度费用分析',
    category: '数据分析',
    icon: 'chart',
    description: '汇总费用结构、比较月份变化，生成带数据口径的费用报告。',
    owner: '财务共享中心',
    tags: ['费用分析', '报告'],
    favorite: true,
    view: true,
    download: false,
    call: true,
    instructions:
      '输入：月份、部门与费用类型。\n输出：费用汇总、同比较期变化、待核实解释及报告。\n先确认统计范围；缺少比较期或预算时明确标记，不推断业务原因。',
    versions: [released('1.2.0'), released('1.1.0')],
  },
  {
    id: 'invoice-check',
    title: '报销票据核验',
    category: '单据处理',
    icon: 'shield',
    description: '检查票据要素、重复风险与报销规则，汇总待补材料。',
    owner: '财务共享中心',
    tags: ['票据', '规则核验'],
    favorite: true,
    view: true,
    download: true,
    call: true,
    instructions:
      '输入：报销单与票据。\n输出：字段核验结果、疑点与补充材料清单。\n核验结果作为经办参考，关键提交动作仍需用户确认。',
    versions: [released('2.1.0')],
  },
  {
    id: 'travel-guide',
    title: '差旅政策问答',
    category: '知识问答',
    icon: 'book',
    description: '依据当前差旅制度回答额度、交通、住宿与材料问题。',
    owner: '费用管理组',
    tags: ['差旅', '制度'],
    favorite: false,
    view: true,
    download: true,
    call: true,
    instructions:
      '输入：差旅安排及政策问题。\n输出：带来源和生效日期的制度答复。\n缺少目的地、职级等条件时先澄清，冲突制度交由财务确认。',
    versions: [released('1.0.0')],
  },
  {
    id: 'english-report',
    title: '英文报告写作风格',
    category: '内容生成',
    icon: 'file',
    description: '财务英文报告的术语、语气与章节规范。',
    owner: '财务运营组',
    tags: ['写作', '英文'],
    favorite: false,
    view: true,
    download: true,
    call: false,
    instructions:
      '使用简洁、客观的财务表达。区分事实、解释与建议。金额明确币种、单位及比较期。',
    versions: [released('1.0.0', 'storage')],
  },
  {
    id: 'close-checklist',
    title: '月末结账检查',
    category: '单据处理',
    icon: 'tasks',
    description: '按关账清单整理待处理事项，核对凭证与附件完整性。',
    owner: '我',
    tags: ['月末', '结账'],
    favorite: false,
    view: true,
    download: true,
    call: false,
    instructions: '核对关账事项、责任人与截止时间；生成待办清单。',
    versions: [
      {
        version: '1.2',
        status: 'returned',
        business: 'fail',
        security: 'pass',
        compatibility: 'pass',
        technical: 'pending',
        mode: 'runnable',
        note: '业务退回：补充跨月调整事项与责任人要求。',
        updated: '2026-11-13',
        events: [
          '2026-11-13 · 申请审核',
          '2026-11-13 · 业务退回：补充跨月调整事项与责任人要求。',
        ],
      },
    ],
  },
  {
    id: 'contract-audit',
    title: '合同付款条件检查',
    category: '单据处理',
    icon: 'brief',
    description: '提取付款节点、验收材料与发票约定，生成核对清单。',
    owner: '我',
    tags: ['合同', '付款'],
    favorite: false,
    view: true,
    download: false,
    call: false,
    instructions:
      '对照合同正文和付款申请核对条件。无法确定的条款标记为待人工核实。',
    versions: [
      {
        version: '0.9.0',
        status: 'review',
        business: 'pending',
        security: 'pending',
        compatibility: 'pending',
        technical: 'pending',
        mode: 'runnable',
        note: '待业务和技术审核。',
        updated: '2026-11-15',
        events: ['2026-11-15 · 资产入库', '2026-11-15 · 申请审核'],
      },
    ],
  },
];
const initialHub: Hub = { skills: seedSkills };
const categories = ['全部分类', '数据分析', '单据处理', '知识问答', '内容生成'];
const statusLabel: Record<VersionStatus, string> = {
  draft: '待申请',
  review: '审核中',
  returned: '已退回',
  published: '已上架',
};
const conclusion = (v: Conclusion) =>
  v === 'pass' ? '通过' : v === 'fail' ? '不通过' : '待审核';
const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const versionKey = (input: string) =>
  input
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((v) => String(Number(v)))
    .concat(['0', '0'])
    .slice(0, 3)
    .join('.');
function useHub() {
  return useSlice<Hub>('skillsHub', initialHub);
}
function VersionBadge({ version }: { version: SkillVersion }) {
  return (
    <Badge
      tone={
        version.status === 'published'
          ? 'success'
          : version.status === 'returned'
            ? 'danger'
            : 'warning'
      }
    >
      {statusLabel[version.status]}
    </Badge>
  );
}
function selectSkillInConversation(
  w: ReturnType<typeof useWorkspace>,
  skill: Skill,
  version = currentVersion(skill),
) {
  if (!available(skill, version)) return;
  w.selectSkill({
    kind: 'skill',
    id: skill.id,
    title: skill.title,
    version: version.version,
  });
  w.notify('已加入对话草稿，发送后使用');
}
function downloadSkill(skill: Skill, v: SkillVersion) {
  if (v.file?.id) {
    const link = document.createElement('a');
    link.href = `/api/local/files/${encodeURIComponent(v.file.id)}/download`;
    link.download = v.file.name;
    link.click();
    return;
  }
  const content = `# ${skill.title}\n\n版本：${v.version}\n类别：${skill.category}\n维护者：${skill.owner}\n发布方式：${v.mode === 'runnable' ? '可调用' : '仅存储'}\n\n${skillDocumentText(skill, v)}\n\n${v.note}\n`;
  const url = URL.createObjectURL(
    new Blob([content], { type: 'text/markdown;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${skill.title}-v${v.version}-说明.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SkillPackageCheck({
  file,
  busy = false,
  onRetry,
}: {
  file: SkillFile;
  busy?: boolean;
  onRetry?: () => void;
}) {
  const inspection = file.inspection;
  const blocked = skillExecutionBlock(file);
  return (
    <div className="sh-package-check" aria-busy={busy}>
      <div className="sh-package-summary">
        <strong>包检查</strong>
        <Badge tone={busy ? 'neutral' : blocked ? 'warning' : 'success'}>
          {busy
            ? '检查中'
            : inspection
              ? blocked
                ? '仅存储'
                : '检查通过'
              : file.inspectionError
                ? '检查失败'
                : file.text
                  ? '已读取文本'
                  : '待检查'}
        </Badge>
        {inspection && (
          <span>
            {inspection.files.length} 个文件 · {inspection.scripts.length}{' '}
            个脚本
          </span>
        )}
        {onRetry && (
          <Button variant="ghost" disabled={busy} onClick={onRetry}>
            重新检查
          </Button>
        )}
      </div>
      {blocked && (
        <p className="sh-package-warning" role="status">
          {blocked}
        </p>
      )}
      {inspection?.warnings?.length ? (
        <ul className="sh-package-warnings">
          {inspection.warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {inspection && (
        <details className="sh-package-files">
          <summary>包内文件（{inspection.files.length}）</summary>
          <ul>
            {inspection.files.map((item) => (
              <li key={item.path}>
                <span>{item.path}</span>
                <small>
                  {item.size < 1024
                    ? `${item.size} B`
                    : `${(item.size / 1024).toFixed(1)} KB`}
                </small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SkillEnvironment() {
  const [environment, setEnvironment] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<
        { environment?: Record<string, unknown> } & Record<string, unknown>
      >('/skills/environment');
      setEnvironment(result.environment || result);
    } catch {
      setError('无法读取运行环境，请重试。');
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      className="sh-environment"
      onToggle={(event) => {
        if (event.currentTarget.open && !environment && !loading && !error)
          void load();
      }}
    >
      <summary>运行环境</summary>
      {loading && <p role="status">正在检查运行环境…</p>}
      {error && (
        <div className="sh-environment-error" role="alert">
          <span>{error}</span>
          <Button onClick={load}>重试</Button>
        </div>
      )}
      {environment && (
        <dl>
          <div>
            <dt>脚本执行</dt>
            <dd>
              {environment.available === true || environment.supported === true
                ? '可用'
                : environment.available === false ||
                    environment.supported === false
                  ? '不可用'
                  : '以包检查结果为准'}
            </dd>
          </div>
          {typeof environment.platform === 'string' && (
            <div>
              <dt>操作系统</dt>
              <dd>
                {(
                  {
                    darwin: 'macOS',
                    linux: 'Linux',
                    win32: 'Windows',
                  } as Record<string, string>
                )[environment.platform] || environment.platform}
              </dd>
            </div>
          )}
          {environment.interpreters &&
          typeof environment.interpreters === 'object' ? (
            <div>
              <dt>可用语言</dt>
              <dd>
                {Object.entries(environment.interpreters)
                  .filter(([, enabled]) => enabled === true)
                  .map(
                    ([key]) =>
                      ({ python: 'Python', node: 'Node.js', shell: 'Shell' })[
                        key
                      ] || key,
                  )
                  .join('、') || '暂无'}
              </dd>
            </div>
          ) : null}
          {typeof environment.reason === 'string' && environment.reason && (
            <div>
              <dt>当前限制</dt>
              <dd>{environment.reason}</dd>
            </div>
          )}
          {typeof environment.network === 'string' && (
            <div>
              <dt>网络访问</dt>
              <dd>
                {environment.network === 'denied' ||
                environment.network === 'disabled'
                  ? '已限制'
                  : environment.network}
              </dd>
            </div>
          )}
        </dl>
      )}
    </details>
  );
}

const catalogSessionKey = (area: CatalogArea) => `caixiaozhi-${area}-catalog`;

function initialCatalogRoute(area: CatalogArea): CatalogRoute {
  const hash = location.hash;
  if (hash === `#${area}`) {
    try {
      const saved = sessionStorage.getItem(catalogSessionKey(area));
      if (saved && catalogArea(saved) === area) {
        return { ...readCatalogRoute(saved), view: 'catalog', type: 'all', toolId: '', action: 'tool' };
      }
    } catch { /* The URL also works without session storage. */ }
  }
  return { ...readCatalogRoute(hash), type: 'all' };
}

export function SkillsPage({ area = 'skills' }: { area?: CatalogArea }) {
  const w = useWorkspace();
  const [hub, setHub] = useHub();
  const applications = area === 'light-apps';
  const tools = useToolCatalog(applications);
  const [route, setRoute] = useState(() => initialCatalogRoute(area));
  const root = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (options.current?.open && event.target instanceof Node && !options.current.contains(event.target))
        options.current.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  const restoringScroll = useRef(true);
  const routeRef = useRef(route);
  routeRef.current = route;
  const working =
    !!route.toolId || ['upload', 'requests'].includes(route.action);
  const listRoute = { ...route, toolId: '', action: 'tool' };
  const scrollKey = (state: CatalogRoute) =>
    `skills-scroll:${writeCatalogRoute({ ...state, toolId: '', action: 'tool' }, area)}`;
  const scroller = () => {
    let node = root.current?.parentElement;
    while (node) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement as HTMLElement | null;
  };
  const saveScroll = () => {
    if (
      restoringScroll.current ||
      routeRef.current.toolId ||
      ['upload', 'requests'].includes(routeRef.current.action)
    )
      return;
    try {
      sessionStorage.setItem(
        scrollKey(routeRef.current),
        String(scroller()?.scrollTop || 0),
      );
    } catch {
      /* Optional restoration. */
    }
  };
  const navigate = (patch: Partial<CatalogRoute>, replace = false) => {
    saveScroll();
    const next = { ...route, ...patch };
    setRoute(next);
    const hash = writeCatalogRoute(next, area);
    if (replace)
      history.replaceState(
        history.state,
        '',
        `${location.pathname}${location.search}${hash}`,
      );
    else location.hash = hash;
    if (!next.toolId && !['upload', 'requests'].includes(next.action)) {
      try {
        sessionStorage.setItem(catalogSessionKey(area), hash);
      } catch {
        /* URL remains the source of truth. */
      }
    }
  };
  useEffect(() => {
    const onHash = () => {
      if (catalogArea(location.hash) === area) setRoute(initialCatalogRoute(area));
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('scroll', saveScroll, true);
    if (location.hash === `#${area}`) {
      const hash = writeCatalogRoute(routeRef.current, area);
      history.replaceState(
        history.state,
        '',
        `${location.pathname}${location.search}${hash}`,
      );
    }
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('scroll', saveScroll, true);
    };
  }, []);
  const currentScrollKey = scrollKey(route);
  useEffect(() => {
    restoringScroll.current = true;
    if (working) {
      scroller()?.scrollTo({ top: 0 });
      return;
    }
    if (tools.loading) return;
    let releaseFrame = 0;
    const frame = requestAnimationFrame(() => {
      try {
        scroller()?.scrollTo({
          top: Number(sessionStorage.getItem(currentScrollKey) || 0),
        });
      } catch {
        /* Optional restoration. */
      }
      releaseFrame = requestAnimationFrame(() => {
        restoringScroll.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(releaseFrame);
    };
  }, [working, currentScrollKey, tools.loading]);

  const items: CatalogItem[] = applications
    ? tools.items.map((item) => ({ ...item, type: 'tool' as const }))
    : hub.skills.map(skillCatalogItem);
  const visibleItems = filterCatalog(items, route);
  const categoryOptions = [
    '全部分类',
    ...new Set(
      filterCatalog(items, {
        ...route,
        search: '',
        type: 'all',
        category: '全部分类',
        favorites: false,
      }).map((item) => item.category),
    ),
  ];
  const openDetail = (item: CatalogItem) => {
    saveScroll();
    if ((!item.canView && route.view === 'manage') || (route.view === 'catalog' && item.type === 'tool' && item.status !== 'published' && item.canManage)) {
      manage(item);
      return;
    }
    w.openPanel(
      item.type === 'skill'
        ? { kind: 'skill', id: item.id, title: item.name }
        : { kind: 'skill', title: item.name, data: { toolId: item.id } },
    );
  };
  const toggleFavorite = async (item: CatalogItem) => {
    if (item.type === 'tool') {
      try {
        await tools.toggleFavorite(item.id);
      } catch {
        w.notify('收藏保存失败，请重试');
      }
    } else
      setHub((current) => ({
        ...current,
        skills: current.skills.map((skill) =>
          skill.id === item.id
            ? { ...skill, favorite: !skill.favorite }
            : skill,
        ),
      }));
  };
  const openTool = (item: CatalogItem, action = 'tool') =>
    navigate({ toolId: item.id, action });
  const manage = (item: CatalogItem) => {
    const reviewing = route.view === 'manage' && route.management === 'review';
    if (item.type === 'tool')
      openTool(item, reviewing ? 'review' : 'manage');
    else
      w.openPanel({
        kind: 'governance',
        id: item.id,
        title: `${item.name} · ${reviewing ? '审核发布' : '版本管理'}`,
        data: { mode: reviewing ? 'review' : 'manage' },
      });
  };
  const useItem = (item: CatalogItem) => {
    if (!item.canUse) {
      openDetail(item);
      return;
    }
    const skill = hub.skills.find((entry) => entry.id === item.id);
    if (skill) {
      saveScroll();
      selectSkillInConversation(w, skill);
    }
  };
  const clearFilters = () =>
    navigate(
      { search: '', type: 'all', category: '全部分类', favorites: false },
      true,
    );
  const labelForStatus = (value: string) =>
    ({
      draft: '草稿',
      review: '审核中',
      pending: '待审核',
      returned: '已退回',
      rejected: '已退回',
      published: '已发布',
      disabled: '已停用',
      archived: '已停用',
    })[value] || value;

  const assetLabel = applications ? '轻应用' : '技能';
  const hasFilters = route.favorites || route.category !== '全部分类';
  const uploadButton = (!applications || tools.canUpload) && (
    <Button icon="upload" onClick={() => {
      if (applications) navigate({ action: 'upload' });
      else w.openPanel({ kind: 'governance', title: '上传技能', data: { mode: 'upload' } });
    }}>上传{assetLabel}</Button>
  );
  const searchField = (
    <label className={route.view === 'manage' ? 'sc-search' : 'et-search'}>
      <Icon name="search" size={16} />
      <input type="search" aria-label={'搜索' + assetLabel} placeholder={'搜索' + assetLabel + '名称或用途'}
        value={route.search} onChange={(event) => navigate({search: event.target.value}, true)} />
    </label>
  );
  const categoryField = (
    <select aria-label="业务分类" value={route.category}
      onChange={(event) => navigate({category: event.target.value}, true)}>
      {[...new Set([...categoryOptions, route.category])].map(category => <option key={category}>{category}</option>)}
    </select>
  );
  return (
    <div className="skills-catalog" ref={root} data-view={route.view}>
      {working ? (
        <ToolCenterEmbed
          route={
            route.toolId
              ? `${route.action}/${encodeURIComponent(route.toolId)}`
              : route.action
          }
          onBack={() => navigate(listRoute)}
        />
      ) : (
        <>
          {route.view === 'catalog' ? (
            <div className="et-controls sc-catalog-controls">
              <div className="et-filters" role="group" aria-label={assetLabel + '范围'}>
                <button aria-pressed={route.scope === 'all'} onClick={() => navigate({scope:'all'})}>全部</button>
                <button aria-pressed={route.scope === 'mine'} onClick={() => navigate({scope:'mine'})}>我创建的</button>
              </div>
              {searchField}
              <details className="sc-options" ref={options} onKeyDown={event => {
                if (event.key === 'Escape' && event.currentTarget.open) {
                  event.preventDefault();
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }
              }}>
                <summary title="筛选与管理">更多{hasFilters && <span aria-label="已启用筛选" className="sc-active-dot" />}<Icon name="chevron" size={13} /></summary>
                <div className="sc-options-body">
                  <label>业务分类{categoryField}</label>
                  <label className="sc-check"><input type="checkbox" checked={route.favorites}
                    onChange={event => navigate({favorites:event.target.checked}, true)} />仅看收藏</label>
                  <button type="button" onClick={() => navigate({view:'manage', favorites:false})}>
                    <Icon name="settings" size={15} />管理{assetLabel}
                  </button>
                </div>
              </details>
              {uploadButton}
            </div>
          ) : (
            <div className="sc-toolbar">
              <Button variant="ghost" icon="back" onClick={() => navigate({view:'catalog'})}>返回目录</Button>
              <h2>管理</h2>
              <div className="sc-toolbar-actions">
                {applications && tools.identity?.role === 'admin' &&
                  <Button variant="ghost" onClick={() => navigate({action:'requests'})}>访问申请</Button>}
                {uploadButton}
              </div>
            </div>
          )}
          {route.view === 'manage' && (
            <div
              className="sc-management-tabs"
              role="tablist"
              aria-label="管理职责"
            >
              <button
                role="tab"
                aria-selected={route.management === 'mine'}
                onClick={() => navigate({ management: 'mine' })}
              >
                {applications && tools.identity?.role === 'admin' ? '可管理' : '我创建的'}
              </button>
              <button
                role="tab"
                aria-selected={route.management === 'review'}
                onClick={() => navigate({ management: 'review' })}
              >
                审核发布
              </button>
              {route.management === 'review' && (
                <Badge tone="neutral">演示权限</Badge>
              )}
            </div>
          )}
          {route.view === 'manage' && <div className="sc-filters">{searchField}{categoryField}</div>}
          {tools.loading && (
            <div className="sc-feedback" role="status">
              轻应用目录加载中…
            </div>
          )}
          {tools.error && (
            <div className="sc-feedback sc-error" role="alert">
              <span>轻应用目录加载失败</span>
              <Button onClick={() => void tools.refresh()}>重试</Button>
            </div>
          )}
          {route.view === 'catalog' ? (
            <div className="sc-grid">
              {visibleItems.map((item) => (
                <article className={item.type === 'skill' ? 'sc-card sc-skill-card' : 'sc-card'} key={item.id}>
                  <div className="sc-card-heading">
                    <CatalogMark kind={item.type === 'tool' ? 'app' : 'skill'} id={item.id} />
                    <div className="sc-card-identity">
                      <button
                        className="sc-card-name"
                        aria-haspopup={item.type === 'skill' ? 'dialog' : undefined}
                        title={item.type === 'skill' ? item.unavailableReason || undefined : undefined}
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          openDetail(item);
                        }}
                      >{item.name}</button>
                      <small>{item.category} · {item.owner}</small>
                    </div>
                    <button className="sc-star"
                      aria-label={`${item.favorite ? '取消收藏' : '收藏'}${item.name}`}
                      aria-pressed={item.favorite} onClick={() => void toggleFavorite(item)}>
                      <Icon name="star" size={17} />
                    </button>
                  </div>
                  <p className="sc-description">{item.description}</p>
                  {item.formats && (
                    <div className="sc-formats">
                      <span><small>输入</small>{item.formats.input}</span>
                      <Icon name="arrow" size={13} />
                      <span><small>输出</small>{item.formats.output}</span>
                    </div>
                  )}
                  {route.scope === 'mine' && item.canManage && item.status === 'published' && item.latestStatus !== 'published' &&
                    <button className="sc-pending" onClick={() => manage(item)}>v{item.latestVersion} · {labelForStatus(item.latestStatus)}<Icon name="chevron" size={12} /></button>}
                  <div className="sc-card-footer">
                    {item.status !== 'published' ? <span className={'sc-status sc-status-' + item.status}>{labelForStatus(item.status)}</span> : (
                      <span className={`sc-availability ${item.canUse ? 'available' : ''}`} title={item.unavailableReason}>
                        {item.canUse ? '可使用' : item.availabilityState === 'reference' ? '仅供查阅'
                          : item.availabilityState === 'unavailable' ? '暂不可用' : '无使用权限'}
                      </span>
                    )}
                    {item.status !== 'published' && item.canManage ? (
                      <Button variant="ghost" onClick={() => manage(item)}>管理版本<Icon name="chevron" size={14} /></Button>
                    ) : item.type === 'tool' && item.canUse ? (
                      <a className="btn ghost" target="_blank" rel="noopener" title="在新窗口打开" onClick={saveScroll}
                        href={writeCatalogRoute({ ...route, toolId: item.id, action:'tool' }, 'light-apps')}>
                        打开应用<Icon name="external" size={14} />
                      </a>
                    ) : (
                      <Button variant="ghost" onClick={() => useItem(item)}>
                        {item.canUse ? '在对话中使用' : '查看详情'}<Icon name={item.canUse ? 'chat' : 'chevron'} size={14} />
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div
              className="sc-table-wrap"
              tabIndex={0}
              role="region"
              aria-label="资产管理表格"
            >
              <table className="sc-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>现行版本</th>
                    <th>待处理版本</th>
                    <th>发布状态</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => (
                    <tr key={`${item.type}:${item.id}`}>
                      <td>
                        <button
                          className="sc-table-name"
                          onClick={() => openDetail(item)}
                        >
                          {item.name}
                        </button>
                        <small>{item.owner}</small>
                      </td>
                      <td>{item.type === 'skill' ? '技能' : '轻应用'}</td>
                      <td>
                        {item.status === 'published' ? `v${item.version}` : '—'}
                      </td>
                      <td>
                        {item.latestStatus !== 'published'
                          ? `v${item.latestVersion}`
                          : '—'}
                      </td>
                      <td>
                        <span
                          className={`sc-status sc-status-${item.latestStatus}`}
                        >
                          {labelForStatus(item.latestStatus)}
                        </span>
                      </td>
                      <td className="sc-updated">
                        {formatCatalogUpdatedAt(item.updatedAt)}
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => manage(item)}>
                          {route.management === 'review'
                            ? item.latestStatus === 'review' ||
                              item.latestStatus === 'pending'
                              ? '审核'
                              : '查看'
                            : '管理'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!visibleItems.length && !tools.loading && !tools.error && (
            <Empty
              title={
                route.view === 'manage'
                  ? route.management === 'review'
                    ? '暂无可审核的资产'
                    : '暂无符合条件的资产'
                  : route.scope === 'mine' && !route.search && !hasFilters ? '尚未创建' + assetLabel : '未找到符合条件的' + assetLabel
              }
            >
              {(hasFilters || route.search) && <Button variant="ghost" onClick={clearFilters}>清除筛选</Button>}
            </Empty>
          )}
        </>
      )}
    </div>
  );
}

export function ComposerSkillPicker({
  selected,
  onToggle,
  searchRef,
}: {
  selected: ContextRef[];
  onToggle: (ref: ContextRef) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const [hub] = useHub();
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const selectedSkills = selected.filter((ref) => ref.kind === 'skill');
  const visibleSkills = hub.skills.filter((skill) => skill.view);
  const skills = visibleSkills.filter((skill) =>
    `${skill.title} ${skill.category} ${skill.tags.join(' ')}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const unavailableSelections = selectedSkills.filter(
    (ref) =>
      !visibleSkills.some((skill) => skill.id === ref.id) &&
      ref.title.toLocaleLowerCase().includes(search),
  );
  return (
    <div className="composer-skill-picker">
      <input
        ref={searchRef}
        className="shortcut-search"
        type="search"
        aria-label="搜索可选技能"
        placeholder="搜索技能名称或分类"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="composer-skill-list">
        {skills.map((skill) => {
          const selectedRef = selectedSkills.find((ref) => ref.id === skill.id);
          const version = selectedRef?.version
            ? skill.versions.find(
                (item) => item.version === selectedRef.version,
              )
            : currentVersion(skill);
          const canPick = !!version && available(skill, version);
          const status = !version
            ? selectedRef?.version
              ? `v${selectedRef.version} · 版本已不可用`
              : '暂无版本'
            : version.status !== 'published'
              ? statusLabel[version.status]
              : version.mode === 'storage'
                ? '仅存储'
                : !skill.call
                  ? '无调用权限'
                  : !canPick
                    ? '暂不可调用'
                    : `v${version.version}`;
          return (
            <button
              type="button"
              className="composer-skill-option"
              key={skill.id}
              aria-pressed={!!selectedRef}
              disabled={!selectedRef && !canPick}
              onClick={() => {
                if (selectedRef) onToggle(selectedRef);
                else if (version && canPick)
                  onToggle({
                    kind: 'skill',
                    id: skill.id,
                    title: skill.title,
                    version: version.version,
                  });
              }}
            >
              <Icon name={skill.icon} size={17} />
              <span className="composer-skill-info">
                <strong>{skill.title}</strong>
                <small>
                  {skill.category} · {status}
                </small>
              </span>
              <Icon
                name={selectedRef ? 'check' : canPick ? 'plus' : 'lock'}
                size={15}
              />
            </button>
          );
        })}
        {unavailableSelections.map((ref) => (
          <button
            type="button"
            className="composer-skill-option"
            key={ref.id}
            aria-pressed={true}
            onClick={() => onToggle(ref)}
          >
            <Icon name="spark" size={17} />
            <span className="composer-skill-info">
              <strong>{ref.title}</strong>
              <small>{ref.version ? `v${ref.version} · ` : ''}已不可用</small>
            </span>
            <Icon name="check" size={15} />
          </button>
        ))}
        {!skills.length && !unavailableSelections.length && (
          <p className="shortcut-empty">未找到相关技能</p>
        )}
      </div>
    </div>
  );
}

export function SkillPickerPanel() {
  const w = useWorkspace(),
    [hub] = useHub();
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const skills = hub.skills.filter(
    (skill) =>
      skill.view &&
      `${skill.title} ${skill.category} ${skill.tags.join(' ')}`
        .toLocaleLowerCase()
        .includes(search),
  );
  return (
    <div className="skill-picker">
      <label className="sh-search">
        <Icon name="search" size={17} />
        <input
          aria-label="搜索可选技能"
          placeholder="搜索技能名称或分类"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="skill-picker-list">
        {skills.map((skill) => {
          const version = currentVersion(skill);
          const canPick = !!version && available(skill, version);
          const status = !version
            ? '暂无版本'
            : version.status !== 'published'
              ? statusLabel[version.status]
              : version.mode === 'storage'
                ? '仅存储'
                : !skill.call
                  ? '无调用权限'
                  : !canPick
                    ? '暂不可调用'
                    : `v${version.version}`;
          return (
            <button
              className="skill-picker-row"
              key={skill.id}
              disabled={!canPick}
              onClick={() => {
                if (!version || !skill.view || !available(skill, version))
                  return;
                w.selectSkill({
                  kind: 'skill',
                  id: skill.id,
                  title: skill.title,
                  version: version.version,
                });
              }}
            >
              <span className="sh-skill-icon">
                <Icon name={skill.icon} size={20} />
              </span>
              <span className="skill-picker-info">
                <strong>{skill.title}</strong>
                <span className="skill-picker-meta">
                  {skill.category} · {status}
                </span>
              </span>
              <Icon name={canPick ? 'plus' : 'lock'} size={16} />
            </button>
          );
        })}
      </div>
      {!skills.length && <Empty title="未找到可选技能" />}
    </div>
  );
}

export function SkillPanel({ panel }: { panel: PanelSpec }) {
  if (panel.data?.toolId)
    return <ToolDetailPanel id={String(panel.data.toolId)} />;
  return <SkillContent panel={panel} />;
}

const builtInQuestions: Record<string, string> = {
  'monthly-analysis':
    '请汇总市场部 10 月的差旅费用，与 9 月比较，并列出需要核实的变化。',
  'invoice-check':
    '请核对这份报销单和随附票据，列出有疑点的项目以及我还需要补交的材料。',
  'travel-guide':
    '下周从杭州去上海出差两天，住宿费按什么标准报销？请附上制度依据。',
};

function SkillContent({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace();
  const [hub, setHub] = useHub();
  const skill = hub.skills.find(
    (s) => s.id === (panel.id || panel.data?.skillId),
  );
  const [tab, setTab] = useState('overview');
  const [selectedVersion, setSelectedVersion] = useState(
    String(panel.data?.version || ''),
  );
  const readerId = useId();
  const scrollArea = useRef<HTMLDivElement>(null);
  const version =
    skill?.versions.find((v) => v.version === selectedVersion) ||
    (skill ? currentVersion(skill) : undefined);
  if (!skill?.view || !version) return <Empty title="技能不可查看" />;

  const canUse = available(skill, version);
  const downloadLabel = version.file?.id ? '下载原文件' : '下载说明';
  const example = canUse && !version.file && builtInQuestions[skill.id];
  const tabs = [
    { id: 'overview', label: '技能说明' },
    ...(version.file ? [{ id: 'files', label: '技能文件' }] : []),
    { id: 'versions', label: '版本记录' },
    { id: 'access', label: '权限与兼容' },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'overview';
  const switchTab = (value: string) => {
    setTab(value);
    scrollArea.current?.scrollTo({ top: 0 });
  };
  const selectVersion = (value: string) => {
    setSelectedVersion(value);
    if (
      tab === 'files' &&
      !skill.versions.find((v) => v.version === value)?.file
    )
      setTab('overview');
  };

  return (
    <div className="sd-reader">
      <div className="sd-scroll" ref={scrollArea}>
        <header className="sd-summary">
          <div className="sd-identity">
            <CatalogMark kind="skill" id={skill.id} />
            <div>
              <h3>{skill.title}</h3>
              <p>{[skill.category, skill.owner].filter(Boolean).join(' · ')}</p>
            </div>
            <button
              type="button"
              className="sd-favorite"
              aria-pressed={skill.favorite}
              aria-label={skill.favorite ? '取消收藏' : '收藏技能'}
              title={skill.favorite ? '取消收藏' : '收藏技能'}
              onClick={() =>
                setHub((p) => ({
                  ...p,
                  skills: p.skills.map((s) =>
                    s.id === skill.id ? { ...s, favorite: !s.favorite } : s,
                  ),
                }))
              }
            >
              <Icon name="star" size={18} />
            </button>
          </div>
          {skill.description && (
            <p className="sd-description">{skill.description}</p>
          )}
          <div className="sd-meta">
            {skill.versions.length > 1 ? (
              <label className="sd-version-select">
                <select
                  aria-label="技能版本"
                  value={version.version}
                  onChange={(e) => selectVersion(e.target.value)}
                >
                  {skill.versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                    </option>
                  ))}
                </select>
                <Icon name="down" size={13} />
              </label>
            ) : (
              <span className="sd-version-value">v{version.version}</span>
            )}
            {version.updated && (
              <span>
                更新于 <time>{formatCatalogUpdatedAt(version.updated)}</time>
              </span>
            )}
            <span className="sd-state" data-available={canUse}>
              {canUse
                ? '可在对话中使用'
                : version.status === 'published'
                  ? skillUnavailableReason(skill, version)
                  : statusLabel[version.status]}
            </span>
          </div>
        </header>
        <div className="sd-tabs" role="tablist" aria-label="技能详情内容">
          {tabs.map((t, index) => (
            <button
              type="button"
              role="tab"
              key={t.id}
              id={readerId + '-' + t.id}
              aria-selected={activeTab === t.id}
              aria-controls={readerId + '-content'}
              tabIndex={activeTab === t.id ? 0 : -1}
              onClick={() => switchTab(t.id)}
              onKeyDown={(e) => {
                let next;
                if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
                else if (e.key === 'ArrowLeft')
                  next = (index + tabs.length - 1) % tabs.length;
                else if (e.key === 'Home') next = 0;
                else if (e.key === 'End') next = tabs.length - 1;
                else return;
                e.preventDefault();
                switchTab(tabs[next]!.id);
                e.currentTarget.parentElement
                  ?.querySelectorAll('button')
                  [next]?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          id={readerId + '-content'}
          role="tabpanel"
          aria-labelledby={readerId + '-' + activeTab}
          className="sd-content"
          tabIndex={0}
          key={activeTab + version.version}
        >
          {activeTab === 'overview' && (
            <>
              <SkillDocument skill={skill} version={version} />
              {example && (
                <details className="sd-example">
                  <summary>
                    <Icon name="chat" size={16} />
                    提问示例
                    <Icon name="down" size={15} />
                  </summary>
                  <p>{example}</p>
                </details>
              )}
            </>
          )}
          {activeTab === 'files' && version.file && (
            <SkillFiles
              file={version.file}
              instructions={skillDocumentText(skill, version)}
            />
          )}
          {activeTab === 'versions' && (
            <div className="sd-history">
              {skill.versions.map((v) => (
                <button
                  type="button"
                  key={v.version}
                  aria-pressed={v.version === version.version}
                  onClick={() => selectVersion(v.version)}
                >
                  <span className="sd-history-top">
                    <strong>v{v.version}</strong>
                    <VersionBadge version={v} />
                    <time>{formatCatalogUpdatedAt(v.updated)}</time>
                  </span>
                  {v.note && <span>{v.note}</span>}
                </button>
              ))}
              {!!version.events?.length && (
                <section>
                  <h3>v{version.version} 变更记录</h3>
                  <ul>
                    {version.events.map((event, i) => (
                      <li key={i}>{event}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
          {activeTab === 'access' && (
            <div className="sd-access">
              <section>
                <h3>我的权限</h3>
                <dl>
                  {[
                    ['查看内容', skill.view],
                    [downloadLabel, skill.download],
                    ['在对话中调用', canUse],
                  ].map(([label, yes]) => (
                    <div key={String(label)}>
                      <dt>{label}</dt>
                      <dd>
                        <Icon name={yes ? 'check' : 'lock'} size={15} />
                        {yes ? '允许' : '不可用'}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section>
                <h3>版本检查</h3>
                <dl>
                  {[
                    ['发布状态', statusLabel[version.status]],
                    ['业务审核', conclusion(version.business)],
                    ['安全结论', conclusion(version.security)],
                    ['运行兼容', conclusion(version.compatibility)],
                    [
                      '发布方式',
                      version.mode === 'runnable' ? '可调用' : '仅存储',
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          )}
          {version.status === 'returned' && (
            <p className="sd-warning">
              此版本已退回并锁定。请创建新版本后重新申请。{version.note}
            </p>
          )}
        </div>
      </div>
      <footer className="sd-actions">
        <Button
          icon="download"
          disabled={!skill.download}
          title={skill.download ? downloadLabel : '当前账号没有下载权限'}
          onClick={() => downloadSkill(skill, version)}
        >
          {downloadLabel}
        </Button>
        {skill.owner === '我' && (
          <Button
            icon="edit"
            onClick={() =>
              w.openPanel({
                kind: 'governance',
                id: skill.id,
                title: skill.title + ' · 版本管理',
                data: { mode: 'manage', version: version.version },
              })
            }
          >
            管理版本
          </Button>
        )}
        {canUse && (
          <Button
            variant="primary"
            icon="chat"
            onClick={() => selectSkillInConversation(w, skill, version)}
          >
            在对话中使用
          </Button>
        )}
      </footer>
    </div>
  );
}

export function GovernancePanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace(),
    [hub, setHub] = useHub();
  const reviewAccess = panel.data?.mode === 'review' && !panel.data?.readonly;
  const [mode, setMode] = useState(
      String(
        !reviewAccess && panel.id && hub.skillDrafts?.[panel.id]
          ? 'revision'
          : panel.data?.mode || 'list',
      ),
    ),
    [skillId, setSkillId] = useState(panel.id || ''),
    [versionId, setVersionId] = useState(String(panel.data?.version || '')),
    [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [section, setSection] = useState<'business' | 'technical'>('business'),
    [security, setSecurity] = useState<Conclusion>('pending'),
    [compatibility, setCompatibility] = useState<Conclusion>('pending'),
    [uploading, setUploading] = useState(false),
    [uploadPhase, setUploadPhase] = useState<'upload' | 'inspect'>('upload'),
    [checkingVersion, setCheckingVersion] = useState(false);
  const draftKey = skillId || 'new',
    form = hub.skillDrafts?.[draftKey] || emptySkillDraft,
    { name, category, version, description, file } = form;
  const updateForm = (partial: Partial<SkillDraft>) =>
    setHub((p) => ({
      ...p,
      skillDrafts: {
        ...p.skillDrafts,
        [draftKey]: {
          ...(p.skillDrafts?.[draftKey] || emptySkillDraft),
          ...partial,
        },
      },
    }));
  const setName = (name: string) => updateForm({ name }),
    setCategory = (category: string) => updateForm({ category }),
    setVersion = (version: string) => updateForm({ version }),
    setDescription = (description: string) => updateForm({ description }),
    setFile = (file: SkillDraft['file']) => updateForm({ file });
  const clearDraft = () =>
    setHub((p) => {
      const skillDrafts = { ...p.skillDrafts };
      delete skillDrafts[draftKey];
      return { ...p, skillDrafts };
    });
  const skill = hub.skills.find((s) => s.id === skillId),
    selected =
      skill?.versions.find((v) => v.version === versionId) ||
      skill?.versions[0];
  const canMaintain = !!skill?.view && skill.owner === '我' && !reviewAccess;
  const executionBlock = skillExecutionBlock(selected?.file);
  const mutate = (update: (s: Skill, v: SkillVersion) => SkillVersion) => {
    if (!skill || !selected) return;
    setHub((p) => ({
      ...p,
      skills: p.skills.map((s) =>
        s.id === skill.id
          ? {
              ...s,
              versions: s.versions.map((v) =>
                v.version === selected.version ? update(s, v) : v,
              ),
            }
          : s,
      ),
    }));
  };
  const resetForm = () => {
    setSkillId('');
    setError('');
  };
  const inspectDraftFile = async (stored: SkillFile) => {
    setUploadPhase('inspect');
    const { inspection } = await api<{ inspection: SkillInspection }>(
      '/skills/inspect',
      { fileId: stored.id },
    );
    setHub((p) => ({
      ...p,
      skillDrafts: {
        ...p.skillDrafts,
        [draftKey]: inspectedSkillDraft(
          p.skillDrafts?.[draftKey] || emptySkillDraft,
          stored,
          inspection,
        ),
      },
    }));
    await w.flush();
  };
  const retryDraftCheck = async () => {
    if (!file?.id) return;
    setUploading(true);
    setError('');
    try {
      await inspectDraftFile(file);
    } catch {
      setFile({ ...file, inspection: undefined, inspectionError: '检查失败' });
      setError('包检查失败，原文件已保留。请重新检查或作为资料存储。');
    } finally {
      setUploading(false);
    }
  };
  const retryVersionCheck = async () => {
    if (!selected?.file?.id || (!canMaintain && !reviewAccess)) return;
    setCheckingVersion(true);
    setError('');
    try {
      const { inspection } = await api<{ inspection: SkillInspection }>(
        '/skills/inspect',
        { fileId: selected.file.id },
      );
      const checkedFile: SkillFile = {
        ...selected.file,
        text: inspection.instructions,
        inspection,
        inspectionError: undefined,
      };
      const nextCompatibility: Conclusion = skillExecutionBlock(checkedFile)
        ? 'fail'
        : 'pending';
      mutate((_s, v) => ({
        ...v,
        file: checkedFile,
        instructions: inspection.instructions,
        compatibility: nextCompatibility,
        technical: 'pending',
        mode: 'storage',
        events: [...v.events, stamp() + ' · 重新检查技能包'],
      }));
      setCompatibility(nextCompatibility);
      await w.flush();
    } catch {
      setError('包检查失败，请稍后重试。');
    } finally {
      setCheckingVersion(false);
    }
  };
  const open = (s: Skill, v = s.versions[0]!) => {
    setSkillId(s.id);
    setVersionId(v.version);
    setMode('review');
    setNote('');
    setError('');
    setSecurity(v.security);
    setCompatibility(skillExecutionBlock(v.file) ? 'fail' : v.compatibility);
  };
  const startRevision = () => {
    if (!skill || !canMaintain) return;
    if (!hub.skillDrafts?.[skill.id])
      setHub((p) => ({
        ...p,
        skillDrafts: {
          ...p.skillDrafts,
          [skill.id]: {
            name: skill.title,
            category: skill.category,
            description: skill.description,
            version: '',
            file: null,
          },
        },
      }));
    setMode('revision');
    setError('');
  };
  const saveAsset = async () => {
    if (reviewAccess || (mode === 'revision' && !canMaintain)) return;
    const title = name.trim();
    if (!title || !description.trim()) {
      setError('请填写技能名称和用途。');
      return;
    }
    if (!/^v?\d+\.\d+(\.\d+)?$/i.test(version.trim())) {
      setError('版本号需使用 1.0 或 1.0.0 格式。');
      return;
    }
    const existing =
      mode === 'revision' ? skill : hub.skills.find((s) => s.title === title);
    if (
      existing?.versions.some(
        (v) => versionKey(v.version) === versionKey(version),
      )
    ) {
      setError(`版本 v${version} 已存在；1.2 与 1.2.0 视为同一版本。`);
      return;
    }
    if (mode !== 'revision' && existing) {
      setError('同名技能已存在，请从该技能创建新版本。');
      return;
    }
    if (!file?.id) {
      setError('请先上传并保存技能文件。');
      return;
    }
    const v: SkillVersion = {
      version: version.replace(/^v/i, ''),
      status: 'draft',
      business: 'pending',
      security: 'pending',
      compatibility: skillExecutionBlock(file) ? 'fail' : 'pending',
      technical: 'pending',
      mode: 'storage',
      note: '待提交审核。',
      updated: stamp(),
      file,
      instructions: file.text || '',
      events: [stamp() + ' · 记录资产信息'],
    };
    if (mode === 'revision' && skill) {
      setHub((p) => ({
        ...p,
        skills: p.skills.map((s) =>
          s.id === skill.id ? { ...s, versions: [v, ...s.versions] } : s,
        ),
      }));
      setVersionId(v.version);
    } else {
      const id = 'skill-' + crypto.randomUUID();
      const s: Skill = {
        id,
        title,
        category,
        icon: 'file',
        description: description.trim(),
        owner: '我',
        tags: [category],
        favorite: false,
        view: true,
        download: true,
        call: false,
        instructions: file.text || '',
        versions: [v],
      };
      setHub((p) => ({ ...p, skills: [s, ...p.skills] }));
      setSkillId(id);
      setVersionId(v.version);
    }
    clearDraft();
    setMode('review');
    setNote('');
    setError('');
    setSecurity('pending');
    setCompatibility(skillExecutionBlock(file) ? 'fail' : 'pending');
    try {
      await w.flush();
      w.notify('技能文件及资产信息已保存，待申请审核');
    } catch (error) {
      setError(error instanceof Error ? error.message : '技能保存失败');
    }
  };
  const submit = async () => {
    if (!canMaintain || !selected || selected.status !== 'draft') return;
    mutate((_s, v) => ({
      ...v,
      status: 'review',
      note: '待业务和技术审核。',
      events: [...v.events, stamp() + ' · 申请审核'],
    }));
    setError('');
    try {
      await w.flush();
      w.notify('已记录审核申请');
    } catch (error) {
      setError(error instanceof Error ? error.message : '审核申请保存失败');
    }
  };
  const review = async (pass: boolean) => {
    if (
      !reviewAccess ||
      !selected ||
      selected.status !== 'review' ||
      checkingVersion
    )
      return;
    if (!note.trim()) {
      setError('请填写审核意见。');
      return;
    }
    if (
      section === 'technical' &&
      pass &&
      (security !== 'pass' || compatibility === 'pending')
    ) {
      setError('技术通过需安全检查通过，并明确兼容结论。');
      return;
    }
    if (
      section === 'technical' &&
      pass &&
      compatibility === 'pass' &&
      executionBlock
    ) {
      setError(executionBlock);
      return;
    }
    mutate((_s, v) =>
      section === 'business'
        ? {
            ...v,
            business: pass ? 'pass' : 'fail',
            status: pass ? 'review' : 'returned',
            note: note.trim(),
            events: [
              ...v.events,
              `${stamp()} · 业务${pass ? '通过' : '退回'}：${note.trim()}`,
            ],
          }
        : {
            ...v,
            technical: pass ? 'pass' : 'fail',
            security,
            compatibility,
            status: pass ? 'review' : 'returned',
            mode: compatibility === 'pass' ? 'runnable' : 'storage',
            note: note.trim(),
            events: [
              ...v.events,
              `${stamp()} · 技术${pass ? '通过' : '退回'}；安全${conclusion(security)}；兼容${conclusion(compatibility)}：${note.trim()}`,
            ],
          },
    );
    setNote('');
    setError('');
    try {
      await w.flush();
      w.notify(pass ? '审核结论已记录' : '版本已退回并锁定');
    } catch (error) {
      setError(error instanceof Error ? error.message : '审核结论保存失败');
    }
  };
  const publish = async () => {
    if (
      !reviewAccess ||
      checkingVersion ||
      !skill ||
      !selected ||
      selected.status !== 'review' ||
      selected.business !== 'pass' ||
      selected.technical !== 'pass' ||
      selected.security !== 'pass'
    )
      return;
    const canRun = selected.compatibility === 'pass' && !executionBlock;
    setHub((p) => ({
      ...p,
      skills: p.skills.map((s) =>
        s.id === skill.id
          ? {
              ...s,
              call: s.call || canRun,
              versions: s.versions.map((v) =>
                v.version === selected.version
                  ? {
                      ...v,
                      status: 'published',
                      mode: canRun ? 'runnable' : 'storage',
                      events: [
                        ...v.events,
                        stamp() + ` · ${canRun ? '可调用' : '仅存储'}版本上架`,
                      ],
                    }
                  : v,
              ),
            }
          : s,
      ),
    }));
    try {
      await w.flush();
      w.notify(canRun ? '可调用版本已上架' : '仅存储版本已上架，调用保持关闭');
    } catch (error) {
      setError(error instanceof Error ? error.message : '发布保存失败');
    }
  };
  if (skill && !skill.view) return <Empty title="技能不可查看" />;
  if (!reviewAccess && skill && !canMaintain)
    return <Empty title="当前账号没有管理权限" />;
  if (mode === 'upload' || mode === 'revision')
    return (
      <div className="sh-governance" data-mode={mode}>
        <div className="as-detail-heading">
          <Badge>
            {mode === 'revision' ? '创建新版本' : '新增资产'}
            {hub.skillDrafts?.[draftKey] ? ' · 草稿已保留' : ''}
          </Badge>
          <Button
            variant="ghost"
            disabled={uploading}
            onClick={() => {
              setMode(skill ? 'review' : 'list');
              setError('');
            }}
          >
            返回
          </Button>
        </div>
        <Field label="技能名称">
          <input
            aria-label="技能名称"
            value={name}
            disabled={mode === 'revision'}
            onChange={(e) => setName(e.target.value)}
            placeholder="填写技能名称"
          />
        </Field>
        <div className="sh-form-grid">
          <Field label="分类">
            <select
              aria-label="分类"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.slice(1).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="版本号">
            <input
              aria-label="版本号"
              value={version}
              placeholder="1.0.0"
              onChange={(e) => setVersion(e.target.value)}
            />
          </Field>
        </div>
        <Field label="用途与适用范围">
          <textarea
            aria-label="用途与适用范围"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="输入、输出及适用的业务范围"
          />
        </Field>
        <Field label="技能文件">
          <input
            type="file"
            accept=".md,.txt,.json,.zip,.yaml,.yml"
            disabled={uploading}
            onChange={async (event) => {
              const selectedFile = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (!selectedFile) return;
              setUploading(true);
              setUploadPhase('upload');
              setError('');
              let uploaded: SkillFile | undefined;
              try {
                await w.flush();
                const { file: stored } = await uploadFile(selectedFile);
                uploaded = stored;
                await w.refresh();
                setFile(stored);
                await w.flush();
                await inspectDraftFile(stored);
              } catch (error) {
                if (uploaded) {
                  setFile({ ...uploaded, inspectionError: '检查失败' });
                  setError(
                    '包检查失败，原文件已保留。请重新检查或作为资料存储。',
                  );
                } else
                  setError(
                    error instanceof Error
                      ? error.message
                      : '技能文件上传失败，请重试。',
                  );
              } finally {
                setUploading(false);
              }
            }}
          />
        </Field>
        {file && (
          <div className="sh-file-info">
            <Icon name="file" />
            <div>
              <strong>{file.name}</strong>
              <small>
                {(file.size / 1024).toFixed(1)} KB ·{' '}
                {file.type || '未识别文件类型'}
              </small>
            </div>
          </div>
        )}
        {file && (
          <SkillPackageCheck
            file={file}
            busy={uploading}
            onRetry={retryDraftCheck}
          />
        )}
        <p className="as-footnote" role="status">
          {uploading
            ? uploadPhase === 'upload'
              ? '文件上传中…'
              : '正在检查技能包与依赖…'
            : !file
              ? '支持 Markdown、TXT、JSON、YAML 和含 SKILL.md 的 ZIP，最大 10 MB。'
              : '原文件已保存。'}
        </p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="as-panel-footer">
          <Button variant="primary" disabled={uploading} onClick={saveAsset}>
            保存资产信息
          </Button>
        </div>
      </div>
    );
  if (mode === 'list' || !skill || !selected)
    return (
      <div className="sh-governance">
        <div className="as-detail-heading">
          <span>
            {
              hub.skills.filter(
                (s) => s.view && (reviewAccess || s.owner === '我'),
              ).length
            }
            项资产 ·{' '}
            {hub.skills
              .filter((s) => s.view && (reviewAccess || s.owner === '我'))
              .reduce(
                (n, s) =>
                  n + s.versions.filter((v) => v.status === 'review').length,
                0,
              )}
            个版本待审
          </span>
          {!reviewAccess && (
            <Button
              variant="primary"
              icon="upload"
              onClick={() => {
                resetForm();
                setMode('upload');
              }}
            >
              上传技能
            </Button>
          )}
        </div>
        <div className="sh-governance-list">
          {hub.skills
            .filter((s) => s.view && (reviewAccess || s.owner === '我'))
            .map((s) => (
              <button key={s.id} onClick={() => open(s)}>
                <span className="sh-skill-icon">
                  <Icon name={s.icon} />
                </span>
                <span>
                  <strong>{s.title}</strong>
                  <small>
                    {s.owner} · v{s.versions[0]!.version}
                  </small>
                </span>
                <VersionBadge version={s.versions[0]!} />
                <Icon name="chevron" size={16} />
              </button>
            ))}
        </div>
      </div>
    );
  const canPublish =
    reviewAccess &&
    !checkingVersion &&
    selected.status === 'review' &&
    selected.business === 'pass' &&
    selected.technical === 'pass' &&
    selected.security === 'pass';
  return (
    <div className="sh-governance">
      <div className="as-detail-heading">
        <Button
          variant="ghost"
          icon="back"
          disabled={checkingVersion}
          onClick={() => setMode('list')}
        >
          {reviewAccess ? '审核资产' : '我的资产'}
        </Button>
        {reviewAccess && <Badge tone="neutral">演示审核权限</Badge>}
        {canMaintain && (
          <Button
            icon="plus"
            disabled={checkingVersion}
            onClick={startRevision}
          >
            创建新版本
          </Button>
        )}
      </div>
      <div className="sh-review-title">
        <h3>{skill.title}</h3>
        <select
          aria-label="治理版本"
          disabled={checkingVersion}
          value={selected.version}
          onChange={(e) => {
            const v = skill.versions.find((x) => x.version === e.target.value)!;
            open(skill, v);
          }}
        >
          {skill.versions.map((v) => (
            <option value={v.version} key={v.version}>
              v{v.version}
            </option>
          ))}
        </select>
        <VersionBadge version={selected} />
      </div>
      <div className="sh-review-stages">
        <div className="complete">
          <Icon name="folder" size={18} />
          <strong>资产入库</strong>
        </div>
        <div className={reviewStage(selected)}>
          <Icon name="shield" size={18} />
          <strong>
            {reviewStage(selected) === 'active'
              ? '审核中'
              : reviewStage(selected) === 'returned'
                ? '审核退回'
                : '双重审核'}
          </strong>
        </div>
        <div className={selected.status === 'published' ? 'complete' : ''}>
          <Icon name="check" size={18} />
          <strong>目录上架</strong>
        </div>
      </div>
      <div className="sh-review-results">
        <div>
          <span>业务审核</span>
          <Badge
            tone={
              selected.business === 'pass'
                ? 'success'
                : selected.business === 'fail'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {conclusion(selected.business)}
          </Badge>
        </div>
        <div>
          <span>技术审核</span>
          <Badge
            tone={
              selected.technical === 'pass'
                ? 'success'
                : selected.technical === 'fail'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {conclusion(selected.technical)}
          </Badge>
        </div>
        <div>
          <span>安全结论</span>
          <span>{conclusion(selected.security)}</span>
        </div>
        <div>
          <span>运行兼容</span>
          <span>{conclusion(selected.compatibility)}</span>
        </div>
      </div>
      {selected.file && (
        <SkillPackageCheck
          file={selected.file}
          busy={checkingVersion}
          onRetry={
            (canMaintain || reviewAccess) &&
            (selected.status === 'draft' || selected.status === 'review')
              ? retryVersionCheck
              : undefined
          }
        />
      )}
      {selected.status !== 'review' && error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {canMaintain && selected.status === 'draft' && (
        <div className="as-panel-footer">
          <Button variant="primary" disabled={checkingVersion} onClick={submit}>
            申请审核
          </Button>
        </div>
      )}
      {selected.status === 'returned' && (
        <div className="notice warning sh-notice">
          <Icon name="lock" size={18} />
          <div>
            <strong>此版本已退回并锁定</strong>
            <p>{selected.note}</p>
            {canMaintain && (
              <Button variant="ghost" onClick={startRevision}>
                创建新版本后重新申请
              </Button>
            )}
          </div>
        </div>
      )}
      {!reviewAccess && selected.status === 'review' && (
        <p className="sc-detail-availability">待业务与技术审核</p>
      )}
      {reviewAccess && selected.status === 'review' && (
        <>
          <div className="as-tabs">
            <button
              className={section === 'business' ? 'active' : ''}
              onClick={() => {
                setSection('business');
                setError('');
              }}
            >
              业务审核
            </button>
            <button
              className={section === 'technical' ? 'active' : ''}
              onClick={() => {
                setSection('technical');
                setSecurity(selected.security);
                setCompatibility(
                  executionBlock ? 'fail' : selected.compatibility,
                );
                setError('');
              }}
            >
              技术审核
            </button>
          </div>
          {section === 'technical' && (
            <div className="sh-form-grid">
              <Field label="安全检查">
                <select
                  aria-label="安全检查"
                  value={security}
                  onChange={(e) => setSecurity(e.target.value as Conclusion)}
                >
                  <option value="pending">待核验</option>
                  <option value="pass">通过</option>
                  <option value="fail">不通过</option>
                </select>
              </Field>
              <Field label="运行兼容">
                <select
                  aria-label="运行兼容"
                  value={compatibility}
                  onChange={(e) =>
                    setCompatibility(e.target.value as Conclusion)
                  }
                >
                  <option value="pending">待核验</option>
                  <option
                    value="pass"
                    disabled={!!executionBlock || checkingVersion}
                  >
                    兼容
                  </option>
                  <option value="fail">不兼容，仅存储</option>
                </select>
              </Field>
            </div>
          )}
          {section === 'technical' && <SkillEnvironment />}
          <Field label="审核意见">
            <textarea
              aria-label="审核意见"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                section === 'business'
                  ? '业务适用范围、输出质量与修改意见'
                  : '记录检查依据、风险与兼容结论'
              }
            />
          </Field>
          {section === 'technical' && compatibility === 'fail' && (
            <p className="as-footnote">
              安全通过后可按“仅存储”发布，调用权限保持关闭。
            </p>
          )}
          {section === 'technical' && security === 'fail' && (
            <p className="field-error">安全检查不通过，无法批准或上架。</p>
          )}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="sh-review-buttons">
            <Button variant="danger" onClick={() => review(false)}>
              退回修改
            </Button>
            <Button
              variant="primary"
              disabled={
                section === 'technical' &&
                (security !== 'pass' ||
                  compatibility === 'pending' ||
                  checkingVersion ||
                  (compatibility === 'pass' && !!executionBlock))
              }
              onClick={() => review(true)}
            >
              记录{section === 'business' ? '业务' : '技术'}通过
            </Button>
          </div>
          {canPublish && (
            <div className="sh-publish">
              <span>
                <Icon name="check" size={18} />
                业务与技术审核已通过
              </span>
              <Button variant="primary" onClick={publish}>
                {selected.compatibility === 'pass' && !executionBlock
                  ? '上架可调用版本'
                  : '以仅存储方式上架'}
              </Button>
            </div>
          )}
        </>
      )}
      {selected.status === 'published' && (
        <div className="notice sh-notice">
          <Icon
            name={selected.mode === 'runnable' ? 'check' : 'folder'}
            size={18}
          />
          <span>
            {selected.mode === 'runnable'
              ? '该版本已上架，可按调用权限在对话中选择。'
              : '该版本仅存储，调用保持关闭。'}
          </span>
        </div>
      )}
      <Section title="操作记录">
        <ol className="sh-events">
          {selected.events
            .slice()
            .reverse()
            .map((e, i) => (
              <li key={i}>{e}</li>
            ))}
        </ol>
      </Section>
    </div>
  );
}
