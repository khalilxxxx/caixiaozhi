import { businessTime } from './time-format';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWorkspace, type PanelSpec } from './workspace';
import { Badge, Button, Empty, Icon } from './ui';
import {
  CATEGORY_LABELS,
  RULE_CENTER_KEY,
  RULE_EXAMPLES,
  publishDemoRule,
  readRuleCenter,
  toWorkspaceRule,
  type DemoRule,
  type DemoRuleDraft,
  type RuleCenterState,
} from './rule-center-model';
import {
  INITIAL_RULES_SUBMISSION,
  RULES_SUBMISSION_KEY,
  workspaceRuleCondition,
  type RulesSubmissionState,
} from './RulesSubmission';
import './rule-center.css';
import { api } from './runtime-client';
import { RuleSampleTest } from './RuleSampleTest';

const systemNames = { expense: '费用报销', oa: 'OA办公' };
const scopeNames = { review: '审单时', submit: '提单时', both: '提单、审单时' };
const semanticExamples = [
  {
    id: 'entertainment-risk',
    title: '业务招待高档消费',
    text: '业务招待事由中包含高档消费时，例如高档酒、高档消费娱乐场所等等，需要提示风险。',
  },
  {
    id: 'travel-purpose',
    title: '差旅事由明确性',
    text: '差旅申请的事由只有“出差”“办事”等笼统描述，无法明确业务对象和任务时，提单和审单时提醒本人。',
  },
  {
    id: 'expense-purpose',
    title: '费用用途一致性',
    text: '费用明细的实际用途与本次报销事由明显不一致，且没有合理业务说明时，审单时提醒本人。',
  },
];
const editableLogic = (rule?: DemoRule) =>
  rule?.source === '场景示例'
    ? rule.instruction || rule.logic
    : (rule?.logic ?? '');
const originName = (rule: DemoRule) =>
  rule.origin === 'builtin' ? '公司规则' : '个人规则';
const timeNow = () =>
  new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
const freshDraft = (rule?: DemoRule): DemoRuleDraft => ({
  text: editableLogic(rule),
  generated: rule ?? null,
  generatedFrom: editableLogic(rule),
  savedAt: '',
  baseVersion: rule?.version ?? null,
});
const currentDraft = (draft: DemoRuleDraft) =>
  !!draft.generated && draft.text.trim() === draft.generatedFrom;
const hasDraft = (draft: DemoRuleDraft | undefined, rule?: DemoRule) =>
  !!draft?.text.trim() &&
  (!rule || !!draft.savedAt || draft.text !== editableLogic(rule));

function useRuleCenter() {
  const w = useWorkspace();
  const state = readRuleCenter(w.state.data);
  useEffect(() => {
    if (!w.state.data[RULE_CENTER_KEY]) {
      w.updateData<RuleCenterState>(
        RULE_CENTER_KEY,
        (previous) => previous ?? state,
      );
    }
  }, [w.state.data[RULE_CENTER_KEY]]);
  const update = (fn: (previous: RuleCenterState) => RuleCenterState) =>
    w.updateData<RuleCenterState>(RULE_CENTER_KEY, (previous) =>
      fn(previous ?? readRuleCenter(w.state.data)),
    );
  const syncActive = (rule: DemoRule) => {
    w.updateData<RulesSubmissionState>(RULES_SUBMISSION_KEY, (previous) => {
      const old = previous ?? INITIAL_RULES_SUBMISSION;
      const projected = toWorkspaceRule(rule);
      return {
        ...old,
        rules: old.rules.some((r) => r.id === rule.id)
          ? old.rules.map((r) => (r.id === rule.id ? projected : r))
          : [...old.rules, projected],
      };
    });
  };
  const startEdit = (id: string) => {
    update((previous) => ({
      ...previous,
      editingId: id,
      drafts: {
        ...previous.drafts,
        [id]:
          previous.drafts[id] ??
          freshDraft(previous.rules.find((r) => r.id === id)),
      },
    }));
    w.closePanel();
    w.navigate('rules');
  };
  return { w, state, update, syncActive, startEdit };
}

function Risk({ rule }: { rule: DemoRule }) {
  return (
    <span className={`rc-risk ${rule.effect === 'block' ? 'block' : 'warn'}`}>
      <Icon name={rule.effect === 'block' ? 'shield' : 'bell'} size={14} />
      {rule.effect === 'block' ? '禁止' : '提醒'}
    </span>
  );
}

function ReadonlySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rc-read-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function EvidenceList({ rule }: { rule: DemoRule }) {
  return (
    <div className="rc-evidence-list">
      {rule.evidence.map((item, index) => (
        <div className="rc-evidence-item" key={`${item.name}-${index}`}>
          <div>
            <strong>{item.name}</strong>
            <span>{item.source}</span>
          </div>
          <p>{item.purpose}</p>
        </div>
      ))}
    </div>
  );
}

function ParsedRule({ rule }: { rule: DemoRule }) {
  return (
    <>
      <div className="rc-parsed-title">
        <h3>{rule.name}</h3>
        <Risk rule={rule} />
      </div>
      <dl className="rc-meta-grid">
        <div>
          <dt>业务分类</dt>
          <dd>{CATEGORY_LABELS[rule.category]}</dd>
        </div>
        <div>
          <dt>规则归属</dt>
          <dd>{originName(rule)}</dd>
        </div>
        <div>
          <dt>业务系统</dt>
          <dd>{systemNames[rule.system]}</dd>
        </div>
        <div>
          <dt>执行场景</dt>
          <dd>{scopeNames[rule.scope]}</dd>
        </div>
      </dl>
      <ReadonlySection title="判断标准">
        <p>{rule.instruction || workspaceRuleCondition(rule)}</p>
      </ReadonlySection>
      <ReadonlySection title="适用条件">
        <ul className="rc-conditions">
          {rule.applicability.map((item, index) => (
            <li key={index}>
              <Icon name="check" size={14} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </ReadonlySection>
      <ReadonlySection title="证据字段">
        <EvidenceList rule={rule} />
      </ReadonlySection>
      <ReadonlySection title="结论输出">
        <p>{rule.output}</p>
      </ReadonlySection>
      <ReadonlySection title="信息缺失时">
        <p>{rule.missing}</p>
      </ReadonlySection>
    </>
  );
}

function ConfirmDialog({
  title,
  label,
  danger,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  label: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="rc-confirm"
      ref={ref}
      aria-labelledby="rc-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onCancel();
        }
      }}
    >
      <header>
        <h2 id="rc-confirm-title">{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭确认"
          onClick={onCancel}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="rc-confirm-body">{children}</div>
      <footer>
        <Button onClick={onCancel}>取消</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {label}
        </Button>
      </footer>
    </dialog>
  );
}

export function RuleCenterPage() {
  const { w, state, update, syncActive, startEdit } = useRuleCenter();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [risk, setRisk] = useState('all');
  const [status, setStatus] = useState('all');
  const [tab, setTab] = useState('all');
  const [toggle, setToggle] = useState<DemoRule | null>(null);
  const drafts = Object.entries(state.drafts).filter(([id, draft]) =>
    hasDraft(
      draft,
      state.rules.find((rule) => rule.id === id),
    ),
  );
  const list = state.rules.filter(
    (rule) =>
      (tab === 'all' || rule.origin === tab) &&
      (category === 'all' || rule.category === category) &&
      (risk === 'all' || rule.effect === risk) &&
      (status === 'all' || rule.enabled === (status === 'enabled')) &&
      `${rule.name} ${rule.id} ${rule.logic}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const reset = () => {
    setQuery('');
    setCategory('all');
    setRisk('all');
    setStatus('all');
    setTab('all');
  };
  if (state.editingId)
    return <RuleEditor key={state.editingId} id={state.editingId} />;
  return (
    <div className="rc-page">
      <div className="rc-list-top">
        <div className="rc-view-tabs" aria-label="规则范围">
          {[
            ['all', '全部规则', state.rules.length],
            [
              'builtin',
              '公司规则',
              state.rules.filter((r) => r.origin === 'builtin').length,
            ],
            [
              'personal',
              '个人规则',
              state.rules.filter((r) => r.origin === 'personal').length,
            ],
            ['drafts', '草稿', drafts.length],
          ].map(([id, label, count]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? 'active' : ''}
              aria-pressed={tab === id}
              onClick={() => setTab(String(id))}
            >
              {label}
              <span>{count}</span>
            </button>
          ))}
        </div>
        <Button variant="primary" icon="plus" onClick={() => startEdit('new')}>
          新增规则
        </Button>
      </div>
      {w.state.data.ruleMigration?.decisions?.length > 0 && (
        <details className="rc-migration-history">
          <summary>规则整理记录</summary>
          <ul>
            {w.state.data.ruleMigration.decisions.map(
              (
                decision: {
                  id: string;
                  name: string;
                  action: string;
                  reason: string;
                },
                index: number,
              ) => (
                <li key={`${decision.id}-${decision.action}-${index}`}>
                  <strong>{decision.name}</strong>
                  <span>
                    {decision.action === 'disabled'
                      ? '已停用'
                      : decision.action === 'added'
                        ? '已新增'
                        : decision.action === 'updated'
                          ? '已更新'
                          : '已保留'}
                  </span>
                  <p>{decision.reason}</p>
                </li>
              ),
            )}
          </ul>
        </details>
      )}
      {tab !== 'drafts' ? (
        <>
          <div className="rc-toolbar">
            <label className="rc-search">
              <Icon name="search" size={17} />
              <input
                aria-label="搜索规则"
                placeholder="搜索规则名称、编号或业务逻辑"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <select
              aria-label="业务分类"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">全部分类</option>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="风险等级"
              value={risk}
              onChange={(event) => setRisk(event.target.value)}
            >
              <option value="all">全部风险</option>
              <option value="warn">提醒</option>
              <option value="block">禁止</option>
            </select>
            <select
              aria-label="启用状态"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="enabled">已启用</option>
              <option value="disabled">已停用</option>
            </select>
          </div>
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr>
                  <th>规则名称</th>
                  <th>业务分类</th>
                  <th>风险等级</th>
                  <th>状态</th>
                  <th>版本</th>
                  <th>最近更新</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <button
                        type="button"
                        className="rc-rule-name"
                        onClick={() =>
                          w.openPanel({
                            kind: 'rule',
                            id: rule.id,
                            title: '规则详情',
                          })
                        }
                      >
                        {rule.name}
                      </button>
                      <div className="rc-rule-sub">
                        <span>{rule.id}</span>
                        <span>{originName(rule)}</span>
                        {hasDraft(state.drafts[rule.id], rule) && (
                          <span className="rc-draft-mark">有草稿</span>
                        )}
                      </div>
                    </td>
                    <td>{CATEGORY_LABELS[rule.category]}</td>
                    <td>
                      <Risk rule={rule} />
                    </td>
                    <td>
                      <span
                        className={`rc-status ${rule.enabled ? 'enabled' : ''}`}
                      >
                        <i />
                        {rule.enabled ? '已启用' : '已停用'}
                      </span>
                    </td>
                    <td>
                      <span className="rc-version">v{rule.version}</span>
                    </td>
                    <td className="rc-updated">
                      {businessTime(rule.updatedAt)}
                    </td>
                    <td>
                      <div className="rc-row-actions">
                        <button
                          type="button"
                          onClick={() => startEdit(rule.id)}
                          aria-label={`编辑${rule.name}`}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => setToggle(rule)}
                          aria-label={`${rule.enabled ? '停用' : '启用'}${rule.name}`}
                        >
                          {rule.enabled ? '停用' : '启用'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!list.length && (
              <Empty title="没有匹配的规则">
                <Button onClick={reset}>清除筛选</Button>
              </Empty>
            )}
          </div>
        </>
      ) : (
        <div className="rc-drafts">
          {drafts.length ? (
            drafts.map(([id, draft]) => {
              const rule = state.rules.find((r) => r.id === id);
              return (
                <div className="rc-draft-row" key={id}>
                  <Icon name="edit" size={20} />
                  <div>
                    <button
                      type="button"
                      className="rc-rule-name"
                      onClick={() => startEdit(id)}
                    >
                      {rule?.name ?? draft.generated?.name ?? '新规则草稿'}
                    </button>
                    <p>{draft.text}</p>
                    <small>
                      {currentDraft(draft) ? '已生成解析' : '解析待更新'}
                      {draft.savedAt
                        ? ` · 保存于 ${draft.savedAt}`
                        : ' · 内容已保留'}
                    </small>
                  </div>
                  <Button onClick={() => startEdit(id)}>继续编辑</Button>
                </div>
              );
            })
          ) : (
            <Empty title="暂无规则草稿">
              <Button onClick={() => startEdit('new')}>新增规则</Button>
            </Empty>
          )}
        </div>
      )}
      <footer className="rc-list-footer">
        <span>
          {tab === 'drafts'
            ? `共 ${drafts.length} 份草稿`
            : `共 ${list.length} 条规则`}
          <span className="rc-footer-separator">·</span>本地规则库
        </span>
        <Button
          variant="ghost"
          icon="link"
          onClick={() => {
            w.attach({ kind: 'rule', id: 'list', title: '规则中心' });
            w.navigate('chat');
          }}
        >
          加入对话
        </Button>
      </footer>
      {toggle && (
        <ConfirmDialog
          title={toggle.enabled ? '停用规则' : '启用规则'}
          label={toggle.enabled ? '确认停用' : '确认启用'}
          danger={toggle.enabled}
          onCancel={() => setToggle(null)}
          onConfirm={async () => {
            const next = { ...toggle, enabled: !toggle.enabled };
            update((previous) => ({
              ...previous,
              rules: previous.rules.map((rule) =>
                rule.id === next.id ? next : rule,
              ),
            }));
            syncActive(next);
            setToggle(null);
            try {
              await w.flush();
              w.notify(`${next.name}已${next.enabled ? '启用' : '停用'}`);
            } catch (error) {
              w.notify(
                error instanceof Error ? error.message : '规则状态保存失败',
              );
            }
          }}
        >
          <p>
            确认{toggle.enabled ? '停用' : '启用'}「{toggle.name}」？
          </p>
          <p className="rc-muted">
            {toggle.enabled
              ? '后续检查将不再执行此规则，已保存的结果保持不变。'
              : '后续检查将使用此规则，已有结果可重新检查。'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function RuleEditor({ id }: { id: string }) {
  const { w, state, update, syncActive } = useRuleCenter();
  const base = state.rules.find((rule) => rule.id === id);
  const draft = state.drafts[id] ?? freshDraft(base);
  const [error, setError] = useState('');
  const [examples, setExamples] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [generating, setGenerating] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [id],
  );
  const invalidateGeneration = () => {
    generation.current += 1;
    setGenerating(false);
  };
  const valid = currentDraft(draft);
  const changed = !base || draft.generated?.logic !== base.logic;
  const patch = (change: Partial<DemoRuleDraft>) => {
    if ('text' in change) invalidateGeneration();
    update((previous) => ({
      ...previous,
      drafts: {
        ...previous.drafts,
        [id]: { ...(previous.drafts[id] ?? freshDraft(base)), ...change },
      },
    }));
  };
  const leave = () => {
    invalidateGeneration();
    update((previous) => ({ ...previous, editingId: null }));
  };
  const generate = async () => {
    if (generating || !draft.text.trim()) return;
    const requestId = ++generation.current;
    setGenerating(true);
    setError('');
    const text = draft.text.trim();
    const baseVersion = base?.version ?? null;
    try {
      await w.flush();
      if (generation.current !== requestId) return;
      const result = await api<{ rule: DemoRule }>('/generate/rule', {
        text,
        base,
      });
      if (generation.current !== requestId) return;
      if (!result.rule) throw new Error('未获得有效规则，请补充业务逻辑后重试');
      update((previous) => {
        const current = previous.drafts[id];
        const currentBase = previous.rules.find((rule) => rule.id === id);
        if (
          generation.current !== requestId ||
          previous.editingId !== id ||
          !current ||
          current.text.trim() !== text ||
          current.baseVersion !== draft.baseVersion ||
          (currentBase?.version ?? null) !== baseVersion
        )
          return previous;
        return {
          ...previous,
          drafts: {
            ...previous.drafts,
            [id]: {
              ...current,
              generated: result.rule,
              generatedFrom: text,
              baseVersion,
            },
          },
        };
      });
      await w.flush();
    } catch (error) {
      if (generation.current === requestId)
        setError(
          error instanceof Error ? error.message : '规则生成失败，请重试',
        );
    } finally {
      if (generation.current === requestId) setGenerating(false);
    }
  };
  const save = async () => {
    if (!valid || !draft.generated) return;
    if ((base?.version ?? null) !== draft.baseVersion) {
      setError('规则版本已更新，请重新生成后保存。');
      setConfirm(false);
      return;
    }
    const next = publishDemoRule(draft.generated, base);
    update((previous) => {
      const remaining = { ...previous.drafts };
      delete remaining[id];
      return {
        ...previous,
        editingId: null,
        drafts: remaining,
        rules: base
          ? previous.rules.map((rule) => (rule.id === id ? next : rule))
          : [...previous.rules, next],
      };
    });
    syncActive(next);
    try {
      await w.flush();
    } catch (error) {
      setError(error instanceof Error ? error.message : '规则保存失败');
      return;
    }
    w.notify(
      base
        ? `已保存 v${next.version}，${next.enabled ? '新版本已启用' : '规则保持停用'}`
        : '规则已保存并启用',
    );
  };
  return (
    <div className="rc-editor">
      <div className="rc-editor-nav">
        <Button variant="ghost" icon="back" onClick={leave}>
          返回规则列表
        </Button>
        <span>本地规则库</span>
      </div>
      <div className="rc-editor-heading">
        <div>
          <h2>{base ? base.name : '新增规则'}</h2>
          <div className="rc-editor-meta">
            {base ? (
              <>
                <span>{base.id}</span>
                <Badge>v{base.version}</Badge>
                <span>{originName(base)}</span>
              </>
            ) : (
              <Badge>个人规则</Badge>
            )}
            <span className="rc-editor-draft-status">
              {draft.savedAt ? `草稿已保存 ${draft.savedAt}` : '草稿'}
            </span>
          </div>
        </div>
        <div className="rc-editor-actions">
          <Button
            disabled={!draft.text.trim()}
            onClick={async () => {
              patch({ savedAt: timeNow() });
              try {
                await w.flush();
                w.notify('规则草稿已保存');
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : '规则草稿保存失败',
                );
              }
            }}
          >
            保存草稿
          </Button>
          <Button
            variant="primary"
            disabled={!valid || !changed}
            onClick={() => setConfirm(true)}
          >
            {base ? '保存新版本' : '保存并启用'}
          </Button>
        </div>
      </div>
      <div className="rc-editor-columns">
        <section className="rc-business-editor">
          <header>
            <h3>业务逻辑</h3>
            <button
              className="rc-text-button"
              type="button"
              aria-expanded={examples}
              onClick={() => setExamples(!examples)}
            >
              引用示例
              <Icon name={examples ? 'up' : 'down'} size={14} />
            </button>
          </header>
          {examples && (
            <div className="rc-example-list">
              {[...semanticExamples, ...RULE_EXAMPLES].map((example) => (
                <button
                  type="button"
                  key={example.id}
                  onClick={() => {
                    patch({ text: example.text });
                    setExamples(false);
                    setError('');
                    input.current?.focus();
                  }}
                >
                  <span>{example.title}</span>
                  <Icon name="arrow" size={15} />
                </button>
              ))}
            </div>
          )}
          <label className="rc-logic-label" htmlFor="rule-business-logic">
            规则内容
          </label>
          <textarea
            ref={input}
            id="rule-business-logic"
            value={draft.text}
            maxLength={2000}
            onChange={(event) => {
              patch({ text: event.target.value });
              setError('');
            }}
            placeholder="描述检查对象、判断标准和异常后的处理方式"
          />
          <div className="rc-input-foot">
            <span>{draft.text.length} / 2000</span>
            <Button
              icon="spark"
              disabled={!draft.text.trim() || generating}
              onClick={generate}
            >
              {generating
                ? '生成中…'
                : draft.generated
                  ? '重新生成'
                  : '生成规则'}
            </Button>
          </div>
          {error && (
            <div className="rc-feedback error" role="alert">
              <Icon name="alert" size={17} />
              <span>{error}</span>
            </div>
          )}
          {draft.generated && !valid && (
            <div className="rc-feedback" role="status">
              <Icon name="refresh" size={17} />
              <span>业务逻辑已修改，请重新生成解析后保存。</span>
            </div>
          )}
          {base && (
            <details className="rc-current-logic">
              <summary>
                查看当前版本 <span>v{base.version}</span>
              </summary>
              <p>{base.logic}</p>
            </details>
          )}
          <div className="rc-editor-secondary">
            <button
              type="button"
              disabled={!draft.text.trim()}
              className="rc-text-button muted"
              onClick={() => setDiscard(true)}
            >
              放弃草稿
            </button>
            <span>
              {base ? '保存前，现行版本保持不变' : '生成后核对规则，再保存启用'}
            </span>
          </div>
        </section>
        <section
          className={`rc-generated ${draft.generated && !valid ? 'stale' : ''}`}
          aria-label="规则解析"
        >
          <header>
            <h3>规则解析</h3>
            <span className="rc-readonly-label">
              <Icon name="lock" size={13} />
              {draft.generated && !valid ? '待更新' : '只读'}
            </span>
          </header>
          {draft.generated ? (
            <div className="rc-generated-body">
              <ParsedRule rule={draft.generated} />
              <RuleSampleTest
                key={draft.generated.id}
                rule={draft.generated}
                disabled={!valid || generating}
              />
            </div>
          ) : (
            <div className="rc-preview-empty">
              <Icon name="file" size={28} />
              <h3>尚未生成规则</h3>
              <p>填写业务逻辑后，生成适用条件、证据字段和结论输出方式。</p>
            </div>
          )}
        </section>
      </div>
      {confirm && draft.generated && (
        <ConfirmDialog
          title={base ? `保存为 v${base.version + 1}` : '保存并启用规则'}
          label={base ? '确认保存' : '确认启用'}
          onCancel={() => setConfirm(false)}
          onConfirm={save}
        >
          <p className="rc-confirm-rule-name">{draft.generated.name}</p>
          {base ? (
            <div className="rc-change-comparison">
              <section>
                <h3>当前版本 · v{base.version}</h3>
                <p>{base.logic}</p>
              </section>
              <section>
                <h3>新版本 · v{base.version + 1}</h3>
                <p>{draft.generated.logic}</p>
              </section>
            </div>
          ) : (
            <p>{draft.generated.logic}</p>
          )}
          <dl className="rc-confirm-facts">
            <div>
              <dt>适用范围</dt>
              <dd>{draft.generated.applicability.join('；')}</dd>
            </div>
            <div>
              <dt>生效状态</dt>
              <dd>
                {base?.enabled === false ? '保存后仍为停用' : '保存后启用'}
              </dd>
            </div>
          </dl>
        </ConfirmDialog>
      )}
      {discard && (
        <ConfirmDialog
          title="放弃规则草稿"
          label="放弃草稿"
          danger
          onCancel={() => setDiscard(false)}
          onConfirm={() => {
            invalidateGeneration();
            update((previous) => {
              const remaining = { ...previous.drafts };
              delete remaining[id];
              return { ...previous, drafts: remaining, editingId: null };
            });
            w.notify('草稿已放弃');
          }}
        >
          <p>
            {base
              ? '当前规则的修改将被移除，现行版本保持不变。'
              : '这份新规则草稿将被移除。'}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function RuleCenterPanel({ panel }: { panel: PanelSpec }) {
  const { w, state, startEdit } = useRuleCenter();
  const [tab, setTab] = useState('logic');
  const rule = state.rules.find((item) => item.id === panel.id);
  useEffect(() => {
    setTab('logic');
  }, [panel.id]);
  useEffect(() => {
    if (panel.id === 'new') startEdit('new');
  }, [panel.id]);
  if (panel.id === 'new') return null;
  if (panel.id === 'list')
    return (
      <div className="rc-panel">
        <div className="rc-panel-rule-list">
          {state.rules.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() =>
                w.openPanel({ kind: 'rule', id: item.id, title: '规则详情' })
              }
            >
              <div>
                <strong>{item.name}</strong>
                <span>
                  {CATEGORY_LABELS[item.category]} · {originName(item)} · v
                  {item.version}
                </span>
              </div>
              <Badge tone={item.enabled ? 'success' : 'neutral'}>
                {item.enabled ? '已启用' : '已停用'}
              </Badge>
              <Icon name="chevron" size={15} />
            </button>
          ))}
        </div>
        <div className="rc-panel-footer">
          <Button
            variant="primary"
            onClick={() => {
              w.closePanel();
              w.navigate('rules');
            }}
          >
            打开规则中心
          </Button>
        </div>
      </div>
    );
  if (!rule)
    return (
      <Empty title="规则不存在">
        <Button
          onClick={() => {
            w.closePanel();
            w.navigate('rules');
          }}
        >
          返回规则中心
        </Button>
      </Empty>
    );
  return (
    <div className="rc-panel">
      <div className="rc-detail-heading">
        <div>
          <span>
            {rule.id} · v{rule.version}
          </span>
          <Badge tone={rule.enabled ? 'success' : 'neutral'}>
            {rule.enabled ? '已启用' : '已停用'}
          </Badge>
        </div>
        <h2>{rule.name}</h2>
        <div className="rc-detail-metadata">
          <span>{originName(rule)}</span>
          <span>{CATEGORY_LABELS[rule.category]}</span>
          <Risk rule={rule} />
        </div>
      </div>
      <div className="rc-detail-tabs" aria-label="规则详情内容">
        {[
          ['logic', '规则逻辑'],
          ['applicability', '适用条件'],
          ['evidence', '证据字段'],
          ['history', '变更记录'],
        ].map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={tab === key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(key!)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="rc-detail-content">
        {tab === 'logic' && (
          <>
            <ReadonlySection title="业务逻辑">
              <p className="rc-logic-copy">
                {rule.source === '场景示例'
                  ? rule.instruction || rule.logic
                  : rule.logic}
              </p>
            </ReadonlySection>
            {rule.metric === 'semantic' &&
              rule.source !== '场景示例' &&
              rule.instruction && (
                <ReadonlySection title="判断标准">
                  <p>{rule.instruction}</p>
                </ReadonlySection>
              )}
            <dl className="rc-meta-grid">
              <div>
                <dt>业务系统</dt>
                <dd>{systemNames[rule.system]}</dd>
              </div>
              <div>
                <dt>执行场景</dt>
                <dd>{scopeNames[rule.scope]}</dd>
              </div>
              <div>
                <dt>规则来源</dt>
                <dd>{rule.source}</dd>
              </div>
              <div>
                <dt>最近更新</dt>
                <dd>{businessTime(rule.updatedAt)}</dd>
              </div>
            </dl>
            <ReadonlySection title="结论输出">
              <p>{rule.output}</p>
            </ReadonlySection>
            <ReadonlySection title="信息缺失时">
              <p>{rule.missing}</p>
            </ReadonlySection>
            <RuleSampleTest key={`${rule.id}:${rule.version}`} rule={rule} />
          </>
        )}
        {tab === 'applicability' && (
          <>
            <ReadonlySection title="适用条件">
              <ul className="rc-conditions">
                {rule.applicability.map((condition, index) => (
                  <li key={index}>
                    <Icon name="check" size={15} />
                    <span>{condition}</span>
                  </li>
                ))}
              </ul>
            </ReadonlySection>
            <dl className="rc-meta-grid">
              <div>
                <dt>业务系统</dt>
                <dd>{systemNames[rule.system]}</dd>
              </div>
              <div>
                <dt>执行场景</dt>
                <dd>{scopeNames[rule.scope]}</dd>
              </div>
            </dl>
            <p className="rc-generated-note">
              <Icon name="lock" size={14} />
              根据业务逻辑生成
            </p>
          </>
        )}
        {tab === 'evidence' && (
          <>
            <ReadonlySection title="证据字段">
              <EvidenceList rule={rule} />
            </ReadonlySection>
            <ReadonlySection title="结论输出">
              <p>{rule.output}</p>
            </ReadonlySection>
            <p className="rc-generated-note">
              <Icon name="lock" size={14} />
              根据业务逻辑生成
            </p>
          </>
        )}
        {tab === 'history' && (
          <div className="rc-history">
            {[...rule.revisions].reverse().map((revision) => (
              <section key={revision.version}>
                <div>
                  <strong>v{revision.version}</strong>
                  {revision.version === rule.version && <Badge>当前版本</Badge>}
                  <time>{revision.at}</time>
                </div>
                <p>{revision.summary}</p>
                <details>
                  <summary>查看业务逻辑</summary>
                  <p>{revision.logic}</p>
                </details>
              </section>
            ))}
          </div>
        )}
      </div>
      <div className="rc-detail-data-label">本地规则库</div>
      <div className="rc-panel-footer">
        {panel.data?.fromAudit && (
          <Button
            onClick={() =>
              w.openPanel({
                kind: 'audit',
                id: panel.data!.fromAudit,
                title: '单据审查',
              })
            }
          >
            返回单据
          </Button>
        )}
        <Button
          variant="ghost"
          icon="link"
          onClick={() => {
            w.attach({
              kind: 'rule',
              id: rule.id,
              title: rule.name,
              version: `v${rule.version}`,
            });
            w.closePanel();
            w.navigate('chat');
          }}
        >
          加入对话
        </Button>
        <Button
          variant="primary"
          icon="edit"
          onClick={() => startEdit(rule.id)}
        >
          {hasDraft(state.drafts[rule.id], rule) ? '继续编辑' : '编辑规则'}
        </Button>
      </div>
    </div>
  );
}
