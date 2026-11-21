import { useState } from 'react';
import { SkillsGuide } from './SkillsGuide';
import { catalogArea } from './skills-catalog-model';
import {
  useWorkspace,
  useSlice,
  type PageId,
  type PanelSpec,
} from './workspace';
import { Icon, Button, Badge, Field, Empty } from './ui';
import type { GenericDocument } from '../document-query/document-model';
export const apps: { id: PageId; label: string; icon: string; keywords?: string[] }[] = [
  { id: 'submission', label: '智能提单', icon: 'file' },
  { id: 'documents', label: '单据进展', icon: 'clock' },
  { id: 'analysis', label: '数据分析', icon: 'chart' },
  { id: 'rules', label: '规则中心', icon: 'shield' },
  { id: 'skills', label: '能力中心', icon: 'spark' },
  { id: 'light-apps', label: '轻应用', icon: 'layout' },
  { id: 'schedules', label: '自动化', icon: 'clock', keywords: ['定时任务', '定时预审'] },
  { id: 'todos', label: '我的工作', icon: 'tasks' },
  { id: 'knowledge', label: '制度知识', icon: 'book' },
  { id: 'files', label: '材料与文件', icon: 'folder' },
];
export const policies = [
  {
    id: 'travel-policy',
    title: '差旅费用管理办法',
    version: '2026.09',
    date: '2026-09-01',
    dept: '财务共享中心',
    category: '差旅',
    clauses: [
      {
        title: '第十二条 · 住宿费用',
        text: '上海、北京住宿标准为每人每晚 600 元。费用按实际入住间夜计算，发票金额与住宿期间应相互对应。超标准部分需提供专项说明并按审批权限处理。',
      },
      {
        title: '第十六条 · 材料要求',
        text: '住宿费用需提供有效发票及入住期间。交通费用应关联出行日期和行程；开票日期不能直接替代费用发生日期。',
      },
    ],
  },
  {
    id: 'expense-policy',
    title: '费用报销及票据管理细则',
    version: '2026.08',
    date: '2026-08-15',
    dept: '财务共享中心',
    category: '报销',
    clauses: [
      {
        title: '第五条 · 报销资料',
        text: '申请人需对费用真实性与归属负责。票据识别信息需要本人核对，重复票据不得重复报销。费用信息不完整的材料应补充后核对。',
      },
      {
        title: '第九条 · 审批与支付',
        text: '报销申请经业务与财务审核后进入资金支付。审批完成不代表已支付，以业务系统支付回执为准。',
      },
    ],
  },
  {
    id: 'hospitality-policy',
    title: '业务招待管理规范',
    version: '2026.06',
    date: '2026-06-01',
    dept: '综合管理部',
    category: '招待',
    clauses: [
      {
        title: '第七条 · 前置申请',
        text: '业务招待需关联已批准的前置申请。申请中应明确招待事由、人员及预算，实际费用应与关联申请的适用范围一致。',
      },
    ],
  },
];
export function KnowledgePage() {
  const w = useWorkspace(),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState('全部');
  const records = (w.state.data.policies ?? []) as typeof policies;
  const items = records.filter(
    (p) =>
      (category === '全部' || category === p.category) &&
      p.title.includes(query),
  );
  return (
    <>
      <div className="toolbar">
        <input
          className="search-field"
          aria-label="搜索制度"
          placeholder="搜索制度名称"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="制度分类"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {['全部', '差旅', '报销', '招待'].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="knowledge-list">
        {items.map((p) => (
          <button
            className="knowledge-row"
            key={p.id}
            onClick={() =>
              w.openPanel({ kind: 'knowledge', id: p.id, title: p.title })
            }
          >
            <span className="row-icon">
              <Icon name="book" size={19} />
            </span>
            <span className="knowledge-info">
              <strong>{p.title}</strong>
              <small>
                {p.dept} · {p.date} 生效 · v{p.version}
              </small>
            </span>
            <Badge tone="green">生效中</Badge>
            <Icon name="chevron" size={16} />
          </button>
        ))}
        {!items.length && <Empty title="未找到相关制度" />}
      </div>
    </>
  );
}
export function KnowledgePanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace();
  const records = (w.state.data.policies ?? []) as typeof policies;
  const p = records.find((p) => p.id === panel.id);
  if (!p) return <Empty title="未找到这份制度" />;
  return (
    <>
      <Badge tone="green">生效中</Badge>
      <dl className="data-grid">
        <div>
          <dt>发布部门</dt>
          <dd>{p.dept}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{p.version}</dd>
        </div>
        <div>
          <dt>生效日期</dt>
          <dd>{p.date}</dd>
        </div>
        <div>
          <dt>适用范围</dt>
          <dd>华川科技 · 全体员工</dd>
        </div>
        <div>
          <dt>数据来源</dt>
          <dd>本地模拟制度资料</dd>
        </div>
      </dl>
      <div className="knowledge-doc">
        {p.clauses.map((c) => (
          <section key={c.title}>
            <h3>{c.title}</h3>
            <p>{c.text}</p>
          </section>
        ))}
      </div>
      <div className="inline-actions">
        <Button
          icon="link"
          onClick={() =>
            w.attach({
              kind: 'knowledge',
              id: p.id,
              title: p.title,
              version: p.version,
            })
          }
        >
          引用到对话
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            w.closePanel();
            w.send('上海出差的住宿标准是多少？', [
              {
                kind: 'knowledge',
                id: p.id,
                title: p.title,
                version: p.version,
              },
            ]);
          }}
        >
          基于此制度提问
        </Button>
      </div>
    </>
  );
}
export function AppsPanel() {
  const w = useWorkspace();
  const [query, setQuery] = useState('');
  const groups = [
    { label: '业务应用', ids: ['todos', 'submission', 'documents', 'analysis'] },
    { label: '能力与资料', ids: ['rules', 'skills', 'light-apps', 'schedules', 'knowledge', 'files'] },
  ];
  const term = query.trim();
  const matches = apps.filter((app) => app.label.includes(term) || app.keywords?.some(word => word.includes(term)));
  return (
    <div className="app-directory-panel">
      <input
        className="search-field"
        aria-label="搜索应用"
        placeholder="搜索应用"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.map((group) => {
        const items = matches.filter((app) => group.ids.includes(app.id));
        return items.length ? (
          <section className="app-directory-group" key={group.label}>
            <h3>{group.label}</h3>
            <div className="app-directory">
              {items.map((app) => (
                <button
                  key={app.id}
                  onClick={() => {
                    w.closePanel();
                    w.navigate(app.id);
                  }}
                >
                  <span className="row-icon">
                    <Icon name={app.icon} />
                  </span>
                  {app.label}
                  <Icon name="chevron" size={14} />
                </button>
              ))}
            </div>
          </section>
        ) : null;
      })}
      {!matches.length && <Empty title="未找到相关应用" />}
    </div>
  );
}
export function ContextPanel() {
  const w = useWorkspace();
  const [query, setQuery] = useState('');
  return (
    <>
      <input
        aria-label="搜索业务对象"
        style={{ width: '100%' }}
        placeholder="搜索单据或制度"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="search-results">
        {((w.state.data.documents ?? []) as GenericDocument[])
          .filter((d) => (d.title + d.id).includes(query))
          .map((d) => (
            <button
              className="search-result"
              key={d.key}
              onClick={() =>
                w.attach({ kind: 'document', id: d.key, title: d.title })
              }
            >
              <Icon name="file" />
              <span>
                <strong>{d.title}</strong>
                <small>
                  {d.id} · {d.source.label}
                </small>
              </span>
              <Icon name="plus" size={15} />
            </button>
          ))}
        {((w.state.data.policies ?? []) as typeof policies)
          .filter((p) => p.title.includes(query))
          .map((p) => (
            <button
              className="search-result"
              key={p.id}
              onClick={() =>
                w.attach({
                  kind: 'knowledge',
                  id: p.id,
                  title: p.title,
                  version: p.version,
                })
              }
            >
              <Icon name="book" />
              <span>
                <strong>{p.title}</strong>
                <small>v{p.version}</small>
              </span>
              <Icon name="plus" size={15} />
            </button>
          ))}
      </div>
    </>
  );
}
export function SearchPanel({ onTask }: { onTask: (id: string) => void }) {
  const w = useWorkspace();
  const [query, setQuery] = useState('');
  const matches = [
    ...w.state.tasks
      .filter((t) => t.title.includes(query))
      .map((t) => ({
        id: t.id,
        title: t.title,
        detail: `会话 · ${t.status}`,
        icon: 'chat',
        action: () => {
          w.closePanel();
          onTask(t.id);
        },
      })),
    ...((w.state.data.documents ?? []) as GenericDocument[])
      .filter((d) => (d.title + d.id).includes(query))
      .map((d) => ({
        id: d.key,
        title: d.title,
        detail: `${d.source.label} · ${d.sourceStatus}`,
        icon: 'file',
        action: () =>
          w.openPanel({ kind: 'document', id: d.key, title: d.title }),
      })),
    ...((w.state.data.policies ?? []) as typeof policies)
      .filter((p) => p.title.includes(query))
      .map((p) => ({
        id: p.id,
        title: p.title,
        detail: `制度 · v${p.version}`,
        icon: 'book',
        action: () =>
          w.openPanel({ kind: 'knowledge', id: p.id, title: p.title }),
      })),
    ...apps
      .filter((a) => a.label.includes(query))
      .map((a) => ({
        id: a.id,
        title: a.label,
        detail: '应用',
        icon: a.icon,
        action: () => {
          w.closePanel();
          w.navigate(a.id);
        },
      })),
  ];
  return (
    <>
      <input
        autoFocus
        aria-label="搜索会话、单据与应用"
        style={{ width: '100%' }}
        placeholder="搜索会话、单据、制度或应用"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="search-results">
        {matches.map((m) => (
          <button className="search-result" key={m.id} onClick={m.action}>
            <Icon name={m.icon} />
            <span>
              <strong>{m.title}</strong>
              <small>{m.detail}</small>
            </span>
            <Icon name="chevron" size={14} />
          </button>
        ))}
        {!matches.length && <Empty title="没有找到相关结果" />}
      </div>
    </>
  );
}
interface WorkspaceNotification {
  id: string;
  title: string;
  text: string;
  createdAt: string;
  read: boolean;
  kind?: string;
  panel?: PanelSpec;
}
export function NotificationsPanel() {
  const w = useWorkspace();
  const [items, setItems] = useSlice<WorkspaceNotification[]>(
    'notifications',
    [],
  );
  const markRead = async (id?: string) => {
    setItems((previous) =>
      previous.map((item) =>
        !id || item.id === id ? { ...item, read: true } : item,
      ),
    );
    try {
      await w.flush();
    } catch (error) {
      w.notify(error instanceof Error ? error.message : '通知状态保存失败');
    }
  };
  return (
    <>
      <div className="section-heading">
        <Badge tone="blue">
          {items.filter((item) => !item.read).length} 条未读
        </Badge>
        <Button
          variant="ghost"
          disabled={!items.some((item) => !item.read)}
          onClick={() => markRead()}
        >
          全部已读
        </Button>
      </div>
      {items.length === 0 && <Empty title="暂无通知" />}
      {items.map((item) => (
        <div className="notification-row" key={item.id}>
          <span className="row-icon">
            <Icon name={item.read ? 'check' : 'bell'} size={16} />
          </span>
          <div>
            <strong>{item.title}</strong>
            <p>{item.text}</p>
            {(item.panel || item.kind === 'audit') && (
              <Button
                variant="ghost"
                onClick={() => {
                  void markRead(item.id);
                  w.openPanel(
                    item.panel ?? {
                      kind: 'audit',
                      id: 'batch',
                      title: '待办预审',
                    },
                  );
                }}
              >
                查看详情
                <Icon name="chevron" size={12} />
              </Button>
            )}
          </div>
          <time>
            {new Date(item.createdAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </time>
        </div>
      ))}
    </>
  );
}
export function HelpPanel({ skillsContext = false, onClose, toolPanel }: { skillsContext?: boolean; onClose?: () => void; toolPanel?: { kind: string | null; toolId?: string } } = {}) {
  const area = catalogArea(location.hash);
  if (skillsContext || area) return <SkillsGuide area={area || 'skills'} onClose={onClose} toolPanel={toolPanel} />;
  if (location.hash.split('?')[0] === '#schedules') return <>
    <section className="help-section">
      <h3>执行时间</h3>
      <p>任务按北京时间执行。关闭浏览器后，电脑和本地服务仍需保持运行。错过计划时间超过 15 分钟时，运行记录会标记为「已错过」。</p>
    </section>
    <section className="help-section">
      <h3>查看结果</h3>
      <p>展开任务的「运行记录」可查看结果。遇到需要确认的事项，从该条记录打开会话即可继续处理。</p>
    </section>
  </>;
  if (location.hash === '#todos') return <>
    <section className="help-section">
      <h3>核对待办单据</h3>
      <ol>
        <li>打开待办后，点选风险事项可定位关联费用。同一事项涉及多笔费用时，会一起标出。</li>
        <li>费用报销单中，切换到“发票影像”可按关联费用找票。打开有影像的票据可以放大核对。</li>
        <li>在“规则执行结果”中选择通过、警告或禁止，可核对对应规则的执行依据。</li>
        <li>“查看单据”在新窗口打开原单。“加入对话”引用当前单据，可继续追问费用、行程和风险原因。</li>
        <li>点“审批”选择同意或退回。提交后，办理结果和审批意见可在原单中查看。</li>
      </ol>
    </section>
    <section className="help-section">
      <h3>预审设置</h3>
      <p>规则由规则中心管理。预审计划、执行时间与运行记录可在定时任务中查看。</p>
      <a href="#schedules" onClick={onClose}>前往定时任务</a>
    </section>
  </>;
  if (location.hash === '#analysis') return <>
    <section className="help-section">
      <h3>公开财报</h3>
      <ol>
        <li>选择年度，查看营收、归母净利润、经营现金流、成本费用与原始指标。</li>
        <li>展开数据来源与计算口径，可核查巨潮资讯法定披露年报、逐年指标页码及数据版本。</li>
        <li>生成报告后可在分析报告列表重开，下载 HTML 或三年指标 CSV。</li>
        <li>使用“在对话中分析”继续查询，报告中的“继续分析”会引用已保存快照。</li>
      </ol>
    </section>
    <section className="help-section">
      <h3>数据覆盖</h3>
      <p>公开财报采用海康威视法定披露年报中的 2023—2025 年度合并财务指标，金额以人民币计量，原值保留两位小数，图表按亿元展示。企业报销样例保留在“报销费用 · 示例数据”入口。</p>
    </section>
  </>;
  return (
    <>
      <section className="help-section">
        <h3>开始会话</h3>
        <ol>
          <li>在对话里提出事项，或从左侧应用进入。</li>
          <li>点击概要卡查看完整内容。补充、修改与保存不会自动提交。</li>
          <li>引用单据、制度或技能后，发送消息才开始下一步。</li>
        </ol>
      </section>
      <section className="help-section">
        <h3>业务流程</h3>
        <ul>
          <li>票据：核对业务信息 → 保存费用 → 生成报销草稿。</li>
          <li>提单：编辑草稿 → 预检 → 查看问题与依据 → 确认提交。</li>
          <li>审单：查看汇总 → 筛选需要关注的单据 → 逐项核实。</li>
          <li>分析：选择期间与组织 → 图表下钻 → 生成并编辑报告。</li>
        </ul>
      </section>
      <section className="help-section">
        <h3>规则配置</h3>
        <ol>
          <li>从规则中心新增规则，或打开已有规则进行编辑。</li>
          <li>
            填写业务逻辑后生成规则，核对只读的适用条件、证据要求和输出结果。
          </li>
          <li>核对后本地保存，再按需启用；修改业务逻辑后须重新生成并核对。</li>
        </ol>
        <p>
          规则由模型解析为可执行的检查条件，保存后进入本地规则库。公司规则按内置定义执行；个人规则补充提醒。无法表达的复杂条件不会自动发布。
        </p>
      </section>
      <section className="help-section">
        <h3>智能提单</h3>
        <ol>
          <li>
            描述行程后，在单据卡片中查看摘要，打开右侧抽屉补齐实际业务字段。
          </li>
          <li>
            可继续说“返程改到11月26日”“往返改为飞机”或“事由改为客户拜访”。修改基于当前草稿，旧卡片只供查看。
          </li>
          <li>保存草稿后检查完整性和规则，核对本次提交内容，再确认提交。</li>
        </ol>
        <p>
          对话通过 Agno
          调用真实模型和本地业务工具。草稿及回执保存在本机服务；确认提交后产生可查询的本地业务单号，尚未发送到外部审批或支付系统。
        </p>
      </section>
      <section className="help-section">
        <h3>文件与技能</h3>
        <p>
          上传的文件原件保存在本机。可读取的文本、PDF、Word
          等内容可加入对话进行问答或合同核对。选择“附件翻译”后，可打开翻译窗口，上传票据图片或
          PDF
          并翻译成中文；点击译文可定位原图文字，点击原图标注可查看对应译文。模糊文字和金额请对照原件核对。上传本身不会运行代码；已审核发布且环境可用的技能，可在任务隔离环境执行脚本。
        </p>
      </section>
      <section className="help-section">
        <h3>本地运行</h3>
        <p>
          会话与业务数据由本机服务持久保存。单据、制度和统计采用本地合成资料，结果详情标注来源。模型或业务接口故障会显示失败，可在恢复后重试；定时预审需要本机服务持续运行。
        </p>
      </section>
      <section className="help-section">
        <h3>会话与应用</h3>
        <p>
          在「能力中心」选择会话技能、专家团和连接器，在「轻应用」打开独立应用，在「自动化」管理定时任务。「常用应用」收纳我的工作、规则中心、数据分析和全部工具。从「最近会话」继续处理已有事项。
        </p>
      </section>
      <section className="help-section">
        <h3>快捷操作</h3>
        <ul>
          <li>Enter 发送，Shift + Enter 换行。</li>
          <li>⌘ / Ctrl + K 打开全部对话。</li>
          <li>Esc 关闭详情，返回原位置。</li>
        </ul>
      </section>
    </>
  );
}
export function PreferencesPanel({
  mode,
  setMode,
  compact,
  setCompact,
}: {
  mode: string;
  setMode: (v: 'assistant' | 'operations') => void;
  compact: boolean;
  setCompact: (v: boolean) => void;
}) {
  const [preferences, setPreferences] = useSlice('preferences', {
    report: '先给结论，再列依据',
    reminder: false,
  });
  return (
    <>
      <section>
        <h3>工作空间</h3>
        <div
          className="layout-options"
          style={{ gridTemplateColumns: '1fr 1fr' }}
        >
          {[
            { id: 'assistant', title: '统一助手', icon: 'chat' },
            { id: 'operations', title: '集中处理台', icon: 'layout' },
          ].map((m) => (
            <button
              key={m.id}
              className={`layout-option ${mode === m.id ? 'active' : ''}`}
              onClick={() => setMode(m.id as 'assistant' | 'operations')}
            >
              <Icon name={m.icon} size={25} />
              <span>{m.title}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="business-section">
        <h3>显示偏好</h3>
        <div className="choice-row">
          <span>紧凑间距</span>
          <button
            className="switch"
            role="switch"
            aria-label="紧凑间距"
            aria-checked={compact}
            onClick={() => setCompact(!compact)}
          />
        </div>
        <div className="choice-row">
          <span>回复偏好</span>
          <select
            aria-label="回复偏好"
            value={preferences.report}
            onChange={(e) =>
              setPreferences({ ...preferences, report: e.target.value })
            }
          >
            <option>先给结论，再列依据</option>
            <option>展开数据与分析过程</option>
          </select>
        </div>
      </section>
      <section className="business-section">
        <h3>我的工作信息</h3>
        <dl className="data-grid">
          <div>
            <dt>姓名</dt>
            <dd>吴侠</dd>
          </div>
          <div>
            <dt>部门</dt>
            <dd>财务部</dd>
          </div>
          <div>
            <dt>公司</dt>
            <dd>华川科技</dd>
          </div>
          <div>
            <dt>时区</dt>
            <dd>北京时间 UTC+8</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
export function RenamePanel({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Field label="会话名称">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={60}
        />
      </Field>
      <div className="panel-footer">
        <Button
          variant="primary"
          disabled={!value.trim()}
          onClick={() => onSave(value.trim())}
        >
          保存名称
        </Button>
      </div>
    </>
  );
}
