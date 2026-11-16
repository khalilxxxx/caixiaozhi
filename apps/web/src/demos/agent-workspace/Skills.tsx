import { useEffect, useState, type RefObject } from 'react';
import {
  useSlice,
  useWorkspace,
  type ContextRef,
  type PanelSpec,
} from './workspace';
import { Badge, Button, Empty, Field, Icon, Section } from './ui';
import './analytics-skills.css';
import { ToolCenterEmbed } from './ToolCenterEmbed';
import { uploadFile } from './runtime-client';

type Conclusion = 'pending' | 'pass' | 'fail';
type VersionStatus = 'draft' | 'review' | 'returned' | 'published';
interface SkillFile {
  id?: string;
  name: string;
  size: number;
  type: string;
  text?: string;
  sha256?: string;
}
interface SkillVersion {
  version: string;
  status: VersionStatus;
  business: Conclusion;
  security: Conclusion;
  compatibility: Conclusion;
  technical: Conclusion;
  mode: 'runnable' | 'storage';
  note: string;
  updated: string;
  file?: SkillFile;
  instructions?: string;
  events: string[];
}
interface Skill {
  id: string;
  title: string;
  category: string;
  icon: string;
  description: string;
  owner: string;
  tags: string[];
  favorite: boolean;
  view: boolean;
  download: boolean;
  call: boolean;
  instructions: string;
  versions: SkillVersion[];
}
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
const currentVersion = (s: Skill) =>
  s.versions.find((v) => v.status === 'published') || s.versions[0]!;
const available = (s: Skill, v = currentVersion(s)) =>
  s.call &&
  v.status === 'published' &&
  v.mode === 'runnable' &&
  v.business === 'pass' &&
  v.technical === 'pass' &&
  v.security === 'pass' &&
  v.compatibility === 'pass';
function useHub() {
  return useSlice<Hub>('skillsHub', initialHub);
}
function VersionBadge({ version }: { version: SkillVersion }) {
  return (
    <Badge
      tone={
        version.status === 'published'
          ? version.mode === 'runnable'
            ? 'success'
            : 'neutral'
          : version.status === 'returned'
            ? 'danger'
            : 'warning'
      }
    >
      {version.status === 'published'
        ? version.mode === 'runnable'
          ? '可调用'
          : '仅存储'
        : statusLabel[version.status]}
    </Badge>
  );
}
function downloadSkill(skill: Skill, v: SkillVersion) {
  if (v.file?.id) {
    const link = document.createElement('a');
    link.href = `/api/local/files/${encodeURIComponent(v.file.id)}/download`;
    link.download = v.file.name;
    link.click();
    return;
  }
  const content = `# ${skill.title}\n\n版本：${v.version}\n类别：${skill.category}\n维护者：${skill.owner}\n发布方式：${v.mode === 'runnable' ? '可调用' : '仅存储'}\n\n${v.instructions || skill.instructions}\n\n${v.note}\n`;
  const url = URL.createObjectURL(
    new Blob([content], { type: 'text/markdown;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${skill.title}-v${v.version}-说明.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SkillsPage() {
  const w = useWorkspace(),
    [hub, setHub] = useHub();
  const [view, setView] = useState<'catalog' | 'mine' | 'team' | 'tools'>(() =>
      new URLSearchParams(location.hash.split('?')[1] || '').get('tab') ===
      'tools'
        ? 'tools'
        : 'catalog',
    ),
    [search, setSearch] = useState(''),
    [category, setCategory] = useState('全部分类'),
    [favorites, setFavorites] = useState(false);
  const switchView = (next: 'catalog' | 'mine' | 'team' | 'tools') => {
    setView(next);
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search}#skills${next === 'tools' ? '?tab=tools' : ''}`,
    );
  };
  useEffect(() => {
    const onHash = () => {
      if (location.hash.split('?')[0] === '#skills')
        setView(
          new URLSearchParams(location.hash.split('?')[1] || '').get('tab') ===
            'tools'
            ? 'tools'
            : 'catalog',
        );
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const skills = hub.skills.filter(
    (s) =>
      (view !== 'catalog' ||
        s.versions.some((v) => v.status === 'published')) &&
      (view !== 'mine' || s.owner === '我') &&
      (!favorites || s.favorite) &&
      (category === '全部分类' || s.category === category) &&
      `${s.title} ${s.description} ${s.tags.join(' ')}`.includes(search),
  );
  const favorite = (id: string) =>
    setHub((p) => ({
      ...p,
      skills: p.skills.map((s) =>
        s.id === id ? { ...s, favorite: !s.favorite } : s,
      ),
    }));
  return (
    <div
      className={`as-page sh-page${view === 'tools' ? ' sh-tools-view' : ''}`}
    >
      <div className="as-page-tabs">
        <div className="as-tabs">
          <button
            className={view === 'catalog' ? 'active' : ''}
            onClick={() => switchView('catalog')}
          >
            技能目录
          </button>
          <button
            className={view === 'tools' ? 'active' : ''}
            onClick={() => switchView('tools')}
          >
            小工具
          </button>
          <button
            className={view === 'mine' ? 'active' : ''}
            onClick={() => switchView('mine')}
          >
            我的技能
          </button>
          <button
            className={view === 'team' ? 'active' : ''}
            onClick={() => switchView('team')}
          >
            团队资产
          </button>
        </div>
        <div className="as-actions">
          {view === 'team' && (
            <Button
              icon="shield"
              variant="ghost"
              onClick={() =>
                w.openPanel({ kind: 'governance', title: '技能治理' })
              }
            >
              审核与治理
            </Button>
          )}
          {view !== 'tools' && (
            <Button
              variant="primary"
              icon="plus"
              onClick={() =>
                w.openPanel({
                  kind: 'governance',
                  title: '添加技能',
                  data: { mode: 'upload' },
                })
              }
            >
              添加技能
            </Button>
          )}
        </div>
      </div>
      {view === 'tools' ? (
        <ToolCenterEmbed onOpenSkills={() => switchView('catalog')} />
      ) : (
        <>
          <div className="sh-filterbar">
            <label className="sh-search">
              <Icon name="search" size={17} />
              <input
                aria-label="搜索技能"
                placeholder="搜索技能名称或用途"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="技能分类"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button
              className={`sh-favorite-filter ${favorites ? 'active' : ''}`}
              aria-pressed={favorites}
              onClick={() => setFavorites(!favorites)}
            >
              <Icon name="star" size={16} />
              仅看收藏
            </button>
          </div>
          {view === 'team' ? (
            <div className="sh-assets-table">
              <table className="as-table">
                <thead>
                  <tr>
                    <th>技能</th>
                    <th>维护者</th>
                    <th>最新版本</th>
                    <th>状态</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <button
                          className="sh-table-title"
                          onClick={() =>
                            w.openPanel({
                              kind: 'skill',
                              id: s.id,
                              title: s.title,
                            })
                          }
                        >
                          {s.title}
                          <small>{s.category}</small>
                        </button>
                      </td>
                      <td>{s.owner}</td>
                      <td>v{s.versions[0]!.version}</td>
                      <td>
                        <VersionBadge version={s.versions[0]!} />
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            w.openPanel({
                              kind: 'governance',
                              id: s.id,
                              title: s.title + ' · 治理',
                              data: { mode: 'review' },
                            })
                          }
                        >
                          管理
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="sh-grid">
              {skills.map((s) => {
                const v = currentVersion(s);
                return (
                  <article className="sh-card" key={s.id}>
                    <div className="sh-card-top">
                      <span
                        className={`sh-skill-icon ${s.category === '知识问答' ? 'purple' : s.category === '单据处理' ? 'teal' : ''}`}
                      >
                        <Icon name={s.icon} size={22} />
                      </span>
                      <button
                        className={`sh-star ${s.favorite ? 'selected' : ''}`}
                        aria-label={`${s.favorite ? '取消收藏' : '收藏'}${s.title}`}
                        aria-pressed={s.favorite}
                        onClick={() => favorite(s.id)}
                      >
                        <Icon name="star" size={17} />
                      </button>
                    </div>
                    <button
                      className="sh-card-title"
                      onClick={() =>
                        w.openPanel({ kind: 'skill', id: s.id, title: s.title })
                      }
                    >
                      {s.title}
                      <Icon name="chevron" size={16} />
                    </button>
                    <p>{s.description}</p>
                    <div className="sh-tags">
                      {s.tags.map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                    </div>
                    <div className="sh-card-meta">
                      <span>{s.owner}</span>
                      <span>v{v.version}</span>
                    </div>
                    <div className="sh-card-bottom">
                      <VersionBadge version={v} />
                      <Button
                        variant="ghost"
                        onClick={() =>
                          w.openPanel({
                            kind: 'skill',
                            id: s.id,
                            title: s.title,
                          })
                        }
                      >
                        {available(s) ? '查看与选择' : '查看详情'}
                        <Icon name="arrow" size={14} />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {skills.length === 0 && (
            <Empty title="没有符合条件的技能">
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setCategory('全部分类');
                  setFavorites(false);
                }}
              >
                清除筛选
              </Button>
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
                w.attach({
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
  const w = useWorkspace(),
    [hub, setHub] = useHub();
  const skill =
    hub.skills.find((s) => s.id === (panel.id || panel.data?.skillId)) ||
    hub.skills[0]!;
  const [tab, setTab] = useState('overview'),
    [selectedVersion, setSelectedVersion] = useState(
      String(panel.data?.version || ''),
    );
  const version =
    skill.versions.find((v) => v.version === selectedVersion) ||
    currentVersion(skill);
  const pick = () => {
    if (!available(skill, version)) return;
    w.attach({
      kind: 'skill',
      id: skill.id,
      title: skill.title,
      version: version.version,
    });
    w.closePanel();
    w.navigate('chat');
    w.notify('已加入当前对话，发送后使用');
  };
  return (
    <div className="sh-detail">
      <div className="sh-detail-intro">
        <span className="sh-skill-icon">
          <Icon name={skill.icon} size={26} />
        </span>
        <div>
          <strong>{skill.title}</strong>
          <p>
            {skill.owner} · {skill.category}
          </p>
        </div>
        <button
          className={`sh-star ${skill.favorite ? 'selected' : ''}`}
          aria-label={skill.favorite ? '取消收藏' : '收藏技能'}
          onClick={() =>
            setHub((p) => ({
              ...p,
              skills: p.skills.map((s) =>
                s.id === skill.id ? { ...s, favorite: !s.favorite } : s,
              ),
            }))
          }
        >
          <Icon name="star" size={19} />
        </button>
      </div>
      <p>{skill.description}</p>
      <div className="sh-versionline">
        <select
          aria-label="技能版本"
          value={version.version}
          onChange={(e) => setSelectedVersion(e.target.value)}
        >
          {skill.versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} · {statusLabel[v.status]}
            </option>
          ))}
        </select>
        <VersionBadge version={version} />
      </div>
      <div className="as-tabs">
        <button
          className={tab === 'overview' ? 'active' : ''}
          onClick={() => setTab('overview')}
        >
          技能说明
        </button>
        <button
          className={tab === 'versions' ? 'active' : ''}
          onClick={() => setTab('versions')}
        >
          版本记录
        </button>
        <button
          className={tab === 'access' ? 'active' : ''}
          onClick={() => setTab('access')}
        >
          权限与兼容
        </button>
      </div>
      {tab === 'overview' ? (
        <>
          <Section title="输入与输出">
            <div className="sh-instructions">
              {version.instructions || skill.instructions}
            </div>
          </Section>
          <Section title="版本备注">
            <p>{version.note}</p>
          </Section>
          {version.file && (
            <div className="sh-file-info">
              <Icon name="file" />
              <div>
                <strong>{version.file.name}</strong>
                <small>
                  {(version.file.size / 1024).toFixed(1)} KB ·
                  {version.file.id ? '原文件已保存' : '内置技能资料'}
                </small>
              </div>
            </div>
          )}
        </>
      ) : tab === 'versions' ? (
        <div className="sh-version-list">
          {skill.versions.map((v) => (
            <button
              key={v.version}
              className={v.version === version.version ? 'active' : ''}
              onClick={() => setSelectedVersion(v.version)}
            >
              <div>
                <strong>v{v.version}</strong>
                <VersionBadge version={v} />
                <time>{v.updated}</time>
              </div>
              <p>{v.note}</p>
            </button>
          ))}
        </div>
      ) : (
        <>
          <Section title="我的权限">
            <div className="sh-permissions">
              {[
                ['查看内容', skill.view],
                ['下载说明', skill.download],
                ['在对话中调用', available(skill, version)],
              ].map(([label, yes]) => (
                <div key={String(label)}>
                  <Icon name={yes ? 'check' : 'lock'} size={16} />
                  <span>{label}</span>
                  <Badge tone={yes ? 'success' : 'neutral'}>
                    {yes ? '允许' : '不可用'}
                  </Badge>
                </div>
              ))}
            </div>
          </Section>
          <Section title="版本检查">
            <dl className="as-basis">
              <dt>业务审核</dt>
              <dd>{conclusion(version.business)}</dd>
              <dt>安全结论</dt>
              <dd>{conclusion(version.security)}</dd>
              <dt>运行兼容</dt>
              <dd>{conclusion(version.compatibility)}</dd>
              <dt>发布方式</dt>
              <dd>{version.mode === 'runnable' ? '可调用' : '仅存储'}</dd>
            </dl>
          </Section>
        </>
      )}
      {version.mode === 'storage' && (
        <div className="notice sh-notice">
          <Icon name="folder" size={17} />
          <span>此版本仅存储，可查看资料，暂不可在对话中调用。</span>
        </div>
      )}
      {!skill.download && <p className="as-footnote">当前账号没有下载权限。</p>}
      {version.status === 'returned' && (
        <div className="notice warning sh-notice">
          <Icon name="lock" size={17} />
          <span>此版本已退回并锁定。修改后需创建新版本重新申请。</span>
        </div>
      )}
      <div className="as-panel-footer sh-detail-actions">
        <Button
          icon="download"
          disabled={!skill.download || !skill.view}
          onClick={() => downloadSkill(skill, version)}
        >
          下载说明
        </Button>
        {skill.owner === '我' && (
          <Button
            icon="edit"
            onClick={() =>
              w.openPanel({
                kind: 'governance',
                id: skill.id,
                title: skill.title + ' · 治理',
                data: { mode: 'review', version: version.version },
              })
            }
          >
            管理版本
          </Button>
        )}
        <Button
          variant="primary"
          icon="plus"
          disabled={!available(skill, version)}
          onClick={pick}
        >
          选择技能
        </Button>
      </div>
    </div>
  );
}

export function GovernancePanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace(),
    [hub, setHub] = useHub();
  const [mode, setMode] = useState(
      String(
        panel.id && hub.skillDrafts?.[panel.id]
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
    [uploading, setUploading] = useState(false);
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
  const open = (s: Skill, v = s.versions[0]!) => {
    setSkillId(s.id);
    setVersionId(v.version);
    setMode('review');
    setNote('');
    setError('');
    setSecurity(v.security);
    setCompatibility(v.compatibility);
  };
  const startRevision = () => {
    if (!skill) return;
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
      compatibility: 'pending',
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
    setCompatibility('pending');
    try {
      await w.flush();
      w.notify('技能文件及资产信息已保存，待申请审核');
    } catch (error) {
      setError(error instanceof Error ? error.message : '技能保存失败');
    }
  };
  const submit = async () => {
    if (!selected || selected.status !== 'draft') return;
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
    if (!selected || selected.status !== 'review') return;
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
      selected.file &&
      !(selected.instructions || selected.file.text)?.trim()
    ) {
      setError('未读取到技能指令文本，此文件只能作为资料存储。');
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
      !skill ||
      !selected ||
      selected.status !== 'review' ||
      selected.business !== 'pass' ||
      selected.technical !== 'pass' ||
      selected.security !== 'pass'
    )
      return;
    const canRun = selected.compatibility === 'pass';
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
  if (mode === 'upload' || mode === 'revision')
    return (
      <div className="sh-governance">
        <div className="as-detail-heading">
          <Badge>
            {mode === 'revision' ? '创建新版本' : '新增资产'}
            {hub.skillDrafts?.[draftKey] ? ' · 草稿已保留' : ''}
          </Badge>
          <Button
            variant="ghost"
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
              placeholder="例如 1.3.0"
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
              setError('');
              try {
                await w.flush();
                const { file: stored } = await uploadFile(selectedFile);
                await w.refresh();
                setFile(stored);
                await w.flush();
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : '技能文件上传失败',
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
        <p className="as-footnote">
          {uploading
            ? '文件上传中…'
            : file?.text
              ? '已读取技能指令文本，审核发布后可在对话中调用。'
              : file
                ? '已保存原文件；未提取到指令文本，仅支持资料存储。'
                : '支持 Markdown、TXT、JSON、YAML；压缩包仅作为资料存储。'}
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
            {hub.skills.length}项资产 ·{' '}
            {hub.skills.reduce(
              (n, s) =>
                n + s.versions.filter((v) => v.status === 'review').length,
              0,
            )}
            个版本待审
          </span>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              resetForm();
              setMode('upload');
            }}
          >
            添加技能
          </Button>
        </div>
        <div className="sh-governance-list">
          {hub.skills.map((s) => (
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
    selected.status === 'review' &&
    selected.business === 'pass' &&
    selected.technical === 'pass' &&
    selected.security === 'pass';
  return (
    <div className="sh-governance">
      <div className="as-detail-heading">
        <Button variant="ghost" icon="back" onClick={() => setMode('list')}>
          全部资产
        </Button>
        <Button icon="plus" onClick={startRevision}>
          创建新版本
        </Button>
      </div>
      <div className="sh-review-title">
        <h3>{skill.title}</h3>
        <select
          aria-label="治理版本"
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
        <div className={selected.status !== 'draft' ? 'complete' : ''}>
          <Icon name="shield" size={18} />
          <strong>双重审核</strong>
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
      {selected.status === 'draft' && (
        <div className="as-panel-footer">
          <Button variant="primary" onClick={submit}>
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
            <Button variant="ghost" onClick={startRevision}>
              创建新版本后重新申请
            </Button>
          </div>
        </div>
      )}
      {selected.status === 'review' && (
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
                setCompatibility(selected.compatibility);
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
                  <option value="pass">兼容</option>
                  <option value="fail">不兼容，仅存储</option>
                </select>
              </Field>
            </div>
          )}
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
                (security !== 'pass' || compatibility === 'pending')
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
                {selected.compatibility === 'pass'
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
