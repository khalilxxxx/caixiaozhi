import { useState } from 'react';
import {
  useWorkspace,
  useSlice,
  type PageId,
  type PanelSpec,
} from './workspace';
import { Icon, Button, Badge, Field, Empty } from './ui';
import type { GenericDocument } from '../document-query/document-model';
export const apps: { id: PageId; label: string; icon: string }[] = [
  { id: 'submission', label: '智能提单', icon: 'file' },
  { id: 'documents', label: '单据进展', icon: 'clock' },
  { id: 'analysis', label: '数据分析', icon: 'chart' },
  { id: 'rules', label: '规则中心', icon: 'shield' },
  { id: 'skills', label: '技能·工具', icon: 'spark' },
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
        text: '申请人需对费用真实性与归属负责。票据识别信息需要本人核对，重复票据不得重复报销。查验结果不明确的票据应补充核验。',
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
    { label: '业务应用', ids: ['submission', 'documents', 'analysis'] },
    { label: '能力与资料', ids: ['rules', 'skills', 'knowledge', 'files'] },
  ];
  const matches = apps.filter((app) => app.label.includes(query.trim()));
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
export function HelpPanel() {
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
          等内容可加入对话进行问答、翻译或合同核对；图片未接入
          OCR，无法读取时需手工补充。技能文本经过审核并发布后才可调用，上传代码不会执行。
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
          从侧栏打开技能·工具、规则中心和智能提单，其他应用收纳在「全部应用」。从「最近会话」继续处理已有事项，或打开「全部对话」搜索历史。
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
            <dd>林悦</dd>
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
