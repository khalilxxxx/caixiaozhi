import { useEffect, useState } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import type { SkillManifest } from '@caixiaozhi/contracts/skills';
import type { InteractiveConfirmationReview } from '@caixiaozhi/contracts/actions';
import { api } from '../../api.js';
import { Drawer, Empty, ErrorNotice, Field, SectionTitle } from '../../ui.js';
import { ConfirmationPanel } from '../business/ConfirmationPanel.js';
type SkillSummary = {
  id: string;
  owner_id: string;
  title: string;
  summary: string;
  scope: string;
  state: string;
  version: number;
  status: string;
  usable: boolean;
};
type SkillDetail = SkillSummary & {
  can_maintain: boolean;
  can_source_read: boolean;
  version_id?: string;
  version_number?: number;
  version_state_version?: number;
  tools?: Array<{ capability_version_id: string; required: boolean }>;
  input_schema?: unknown;
  output_schema?: unknown;
  versions?: Array<{
    id: string;
    version_number: number;
    status: string;
    version: number;
  }>;
  reviews?: Array<{
    id: string;
    skill_version_id: string;
    status: string;
    version: number;
    decision_reason: string | null;
  }>;
};
type Source = {
  id: string;
  manifest: SkillManifest;
  markdown: string;
  content_hash: string;
  status: string;
  version: number;
};
type Capability = {
  id: string;
  name: string;
  title: string;
  description: string;
  current_version_id: string | null;
  effect: string | null;
  status: string;
};
type Validation = {
  validation_id: string;
  status: string;
  checks: Array<{ name: string; status: string; message?: string }>;
  error_code: string | null;
  synthetic: boolean;
};
type ReviewTask = {
  review_id: string;
  skill_version_id: string;
  skill_id: string;
  title: string;
  summary: string;
  status: string;
  version: number;
  requested_scope: unknown;
};
const states: Record<string, string> = {
  pending_validation: '待验证',
  draft: '待验证草稿',
  validating: '正在检查',
  validated: '个人验证通过',
  review_pending: '待独立审查',
  approved: '审查已通过',
  rejected: '审查已驳回',
  published: '已发布',
  blocked: '验证受阻',
  passed: '检查通过',
  failed: '检查失败',
  queued: '排队中',
  running: '检查中',
  disabled: '已停用',
  enabled: '已启用',
};
const operationOptions: [string, string][] = [
  ['approval.approve', '单笔批准'],
  ['approval.return', '退回补正'],
  ['approval.batch_approve', '低风险批量批准'],
  ['travel.submit', '提交差旅'],
  ['travel.resubmit', '重提差旅'],
  ['travel.withdraw', '撤回差旅'],
  ['expense.submit', '提交报销'],
  ['expense.resubmit', '重提报销'],
  ['expense.withdraw', '撤回报销'],
  ['rule.enable', '启用规则'],
  ['rule.publish', '发布公司规则'],
];
const markdownTemplate = [
  '## 任务目标\n说明要协助用户完成的具体任务。',
  '## 适用范围\n仅使用当前用户实时业务授权。',
  '## 工作步骤\n核对任务参数，通过已登记工具读取事实，保存必要来源。',
  '## 需要询问的情况\n任务对象、日期或范围不清楚时先询问。',
  '## 输出要求\n数据结论附来源，未知项明确说明。',
  '## 禁止事项\n不得执行代码、扩大权限、自动确认或编造工具事实。',
].join('\n\n');
function baseManifest(): SkillManifest {
  return {
    manifest_schema_version: 1,
    title: '新的个人能力',
    summary: '说明任务目的与适用范围',
    intent_examples: ['请协助完成此任务'],
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['question'],
    },
    output_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string', maxLength: 4000 },
        evidence_refs: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', maxLength: 200 },
        },
      },
      required: ['answer', 'evidence_refs'],
    },
    tools: [],
    scope_policy: { preset: 'self' },
    allowed_action_operations: [],
    output_card_types: ['skill_result'],
    examples: [
      {
        name: '信息不足时澄清',
        input: { question: '请帮我处理' },
        expected: { answer: '请补充本次任务对象。', evidence_refs: [] },
        expected_tool_names: [],
        expectation: 'clarify',
      },
    ],
  };
}
export function SkillsWorkspace({ me }: { me: Me }) {
  const [items, setItems] = useState<SkillSummary[]>([]),
    [query, setQuery] = useState(''),
    [tab, setTab] = useState<'available' | 'mine' | 'reviews'>('available'),
    [reviews, setReviews] = useState<ReviewTask[]>([]),
    [selectedReview, setSelectedReview] = useState<ReviewTask | null>(null),
    [detail, setDetail] = useState<SkillDetail | null>(null),
    [source, setSource] = useState<Source | null>(null);
  const [editor, setEditor] = useState(false),
    [title, setTitle] = useState(''),
    [summary, setSummary] = useState(''),
    [markdown, setMarkdown] = useState(markdownTemplate),
    [manifestText, setManifestText] = useState(
      JSON.stringify(baseManifest(), null, 2),
    ),
    [selectedTools, setSelectedTools] = useState<string[]>([]),
    [allowedOperations, setAllowedOperations] = useState<string[]>([]),
    [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [validation, setValidation] = useState<Validation | null>(null),
    [validationId, setValidationId] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(''),
    [reason, setReason] = useState(''),
    [reviewerId, setReviewerId] = useState(''),
    [groupId, setGroupId] = useState(''),
    [people, setPeople] = useState<Array<{ id: string; display_name: string }>>(
      [],
    ),
    [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]),
    [confirmation, setConfirmation] =
      useState<InteractiveConfirmationReview | null>(null);
  const canManage = me.actor.permissions.includes('skill.manage');
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, tasks] = await Promise.all([
        api<{ items: SkillSummary[] }>(
          `/skills${query ? `?q=${encodeURIComponent(query)}` : ''}`,
        ),
        api<{ items: ReviewTask[] }>('/skills/reviews'),
      ]);
      setItems(list.items);
      setReviews(tasks.items);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    if (canManage)
      void Promise.all([
        api<Capability[]>('/integrations/capabilities'),
        api<{ items: Array<{ id: string; display_name: string }> }>(
          '/directory/people?limit=100',
        ),
        api<{ items: Array<{ id: string; name: string }> }>(
          '/directory/groups?limit=100',
        ),
      ])
        .then(([tools, directory, grants]) => {
          setCapabilities(
            tools.filter(
              (t) => t.status === 'published' && t.effect !== 'write',
            ),
          );
          setPeople(directory.items.filter((p) => p.id !== me.actor.user_id));
          setGroups(grants.items);
        })
        .catch(setError);
  }, []);
  useEffect(() => {
    if (
      !validationId ||
      !detail ||
      !['queued', 'running'].includes(validation?.status ?? 'queued')
    )
      return;
    let live = true;
    const timer = setTimeout(() => {
      void api<Validation>(`/skills/${detail.id}/validations/${validationId}`)
        .then(async (value) => {
          if (!live) return;
          setValidation(value);
          if (!['queued', 'running'].includes(value.status)) {
            const current = await api<SkillDetail>(`/skills/${detail.id}`);
            if (live) setDetail(current);
            if (source && current.version_id) {
              const next = await api<Source>(
                `/skills/${detail.id}/versions/${source.id}/source`,
              );
              if (live) setSource(next);
            }
            void load();
          }
        })
        .catch((e) => {
          if (live) setError(e);
        });
    }, 1200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [validationId, validation?.status, detail?.id]);
  const open = async (id: string) => {
    setBusy(true);
    setError(null);
    setSource(null);
    setValidation(null);
    setValidationId(null);
    setSelectedReview(null);
    setEditor(false);
    try {
      setDetail(await api(`/skills/${id}`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const readSource = async (versionId = detail?.version_id) => {
    if (!detail || !versionId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<Source>(
        `/skills/${detail.id}/versions/${versionId}/source`,
      );
      setSource(result);
      setTitle(result.manifest.title);
      setSummary(result.manifest.summary);
      setMarkdown(result.markdown);
      setManifestText(JSON.stringify(result.manifest, null, 2));
      setSelectedTools(
        result.manifest.tools.map((t) => t.capability_version_id),
      );
      setAllowedOperations(result.manifest.allowed_action_operations);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const create = () => {
    setDetail(null);
    setSource(null);
    setSelectedReview(null);
    setTitle('');
    setSummary('');
    setMarkdown(markdownTemplate);
    setManifestText(JSON.stringify(baseManifest(), null, 2));
    setSelectedTools([]);
    setAllowedOperations([]);
    setValidation(null);
    setValidationId(null);
    setEditor(true);
    setError(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = JSON.parse(manifestText) as SkillManifest,
        manifest = {
          ...parsed,
          title,
          summary,
          tools: selectedTools.map((capability_version_id) => ({
            capability_version_id,
            required: true,
          })),
          allowed_action_operations: allowedOperations,
        };
      let current = detail;
      if (!current) {
        const created = await api<{ id: string; version: number }>('/skills', {
          method: 'POST',
          body: { slug: `skill-${crypto.randomUUID()}`, title, summary },
        });
        current = {
          ...created,
          owner_id: me.actor.user_id,
          title,
          summary,
          scope: 'personal',
          state: 'enabled',
          status: 'draft',
          usable: false,
          can_maintain: true,
          can_source_read: true,
        };
      }
      const saved = await api<{ id: string }>(
        `/skills/${current.id}/versions`,
        {
          method: 'POST',
          body: {
            expected_version: current.version,
            manifest,
            markdown,
            ...(source ? { base_version_id: source.id } : {}),
          },
        },
      );
      const next = await api<SkillDetail>(
        `/skills/${current.id}?version_id=${saved.id}`,
      );
      setDetail(next);
      setSource(await api(`/skills/${current.id}/versions/${saved.id}/source`));
      setEditor(false);
      setValidation(null);
      setValidationId(null);
      setNotice('新内容版本已保存，需重新验证后才能启用。');
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    if (!detail || !source) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api<{ validation_id: string; status: string }>(
        `/skills/${detail.id}/versions/${source.id}/validate`,
        { method: 'POST', body: { expected_version: source.version } },
      );
      setValidationId(value.validation_id);
      setValidation({
        validation_id: value.validation_id,
        status: value.status,
        checks: [],
        error_code: null,
        synthetic: false,
      });
      setNotice('检查任务已保存，将核对声明、工具、范围、示例与真实受控模型。');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const activate = async () => {
    if (!detail || !source) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/skills/${detail.id}/activate`, {
        method: 'POST',
        body: {
          expected_version: detail.version,
          version_id: source.id,
          selection_policy: 'pin',
        },
      });
      setDetail(await api(`/skills/${detail.id}`));
      setNotice('此版本已仅为本人启用。');
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const setState = async (operation: 'disable' | 'enable') => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/skills/${detail.id}/${operation}`, {
        method: 'POST',
        body: { expected_version: detail.version, reason },
      });
      setDetail(await api(`/skills/${detail.id}`));
      setNotice(
        operation === 'disable'
          ? '后续调用已停止；已有业务回执继续保留。'
          : '能力已重新启用，旧任务不会自动重启。',
      );
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const requestReview = async () => {
    if (!detail || !source) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/skills/${detail.id}/reviews`, {
        method: 'POST',
        body: {
          expected_version: detail.version,
          version_id: source.id,
          requested_scope: groupId
            ? { scope: 'group', group_ids: [groupId] }
            : { scope: 'tenant' },
          grants: [
            {
              subject_type: groupId ? 'group' : 'tenant',
              subject_id: groupId || me.actor.tenant_id,
              action: 'use',
            },
          ],
          reviewer_id: reviewerId,
        },
      });
      setDetail(await api(`/skills/${detail.id}`));
      setNotice('共享候选已交独立审查，目标用户尚不能调用。');
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const openReview = async (task: ReviewTask) => {
    setBusy(true);
    setError(null);
    try {
      const value = await api<Source>(
        `/skills/${task.skill_id}/versions/${task.skill_version_id}/source`,
      );
      setSelectedReview(task);
      setDetail(null);
      setSource(value);
      setEditor(false);
      setReason('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!selectedReview) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/skills/${selectedReview.skill_id}/reviews/${selectedReview.review_id}/decide`,
        {
          method: 'POST',
          body: { expected_version: selectedReview.version, decision, reason },
        },
      );
      setSelectedReview(null);
      setSource(null);
      setNotice(
        decision === 'approved'
          ? '审查已通过，仍需发布者本人确认发布。'
          : '已保存驳回意见。',
      );
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const publication = async (reviewId: string, versionId: string) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await api<{ confirmation_id: string }>(
        `/skills/${detail.id}/publication-intents`,
        {
          method: 'POST',
          body: {
            expected_version: detail.version,
            version_id: versionId,
            review_id: reviewId,
          },
        },
      );
      setConfirmation(await api(`/confirmations/${prepared.confirmation_id}`));
      setDetail(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const useSkill = () => {
    if (!detail?.version_id) return;
    sessionStorage.setItem(
      'caixiaozhi.selected_skill_version',
      detail.version_id,
    );
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('page', 'assistant');
    url.searchParams.set('skill_version', detail.version_id);
    history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(
      new CustomEvent('select-finance-skill', {
        detail: { skill_version_id: detail.version_id, title: detail.title },
      }),
    );
  };
  const visible =
    tab === 'mine'
      ? items.filter((item) => item.owner_id === me.actor.user_id)
      : items;
  return (
    <>
      <SectionTitle
        title="Skills"
        description="选择经过验证的工作方法；业务权限与本人确认始终有效。"
        actions={
          canManage && (
            <button className="primary-button" onClick={create}>
              创建个人能力
            </button>
          )
        }
      />
      <div className="finance-tabs" role="tablist" aria-label="能力目录">
        <button
          role="tab"
          aria-selected={tab === 'available'}
          onClick={() => setTab('available')}
        >
          能力目录
        </button>
        {canManage && (
          <button
            role="tab"
            aria-selected={tab === 'mine'}
            onClick={() => setTab('mine')}
          >
            我创建的
          </button>
        )}
        <button
          role="tab"
          aria-selected={tab === 'reviews'}
          onClick={() => setTab('reviews')}
        >
          待我审查{reviews.length > 0 ? `（${reviews.length}）` : ''}
        </button>
      </div>
      <ErrorNotice error={error} />
      <div role="status" aria-live="polite" className="finance-live">
        {notice}
        {loading && '正在按当前授权读取能力…'}
      </div>
      {tab === 'reviews' ? (
        reviews.length ? (
          <div className="finance-skill-list">
            {reviews.map((task) => (
              <article className="finance-skill" key={task.review_id}>
                <h2>{task.title}</h2>
                <p>{task.summary}</p>
                <span className="finance-skill-state">待独立审查</span>
                <button onClick={() => void openReview(task)}>
                  查看候选与审查范围
                </button>
              </article>
            ))}
          </div>
        ) : (
          <Empty>暂无分配给本人的审查任务。</Empty>
        )
      ) : (
        <>
          <form
            className="finance-skill-search"
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <label className="sr-only" htmlFor="skill-query">
              搜索当前授权能力
            </label>
            <input
              id="skill-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索名称或用途"
              maxLength={100}
            />
            <button disabled={busy}>搜索</button>
          </form>
          {visible.length ? (
            <div className="finance-skill-list">
              {visible.map((item) => (
                <article className="finance-skill" key={item.id}>
                  <header>
                    <h2>{item.title}</h2>
                    <span className="finance-skill-state">
                      {states[
                        item.state === 'disabled' ? 'disabled' : item.status
                      ] ?? '待核对'}
                    </span>
                  </header>
                  <p>{item.summary}</p>
                  <footer>
                    <small>
                      {item.scope === 'personal'
                        ? '仅本人'
                        : item.scope === 'group'
                          ? '授权组'
                          : '当前租户'}{' '}
                      · {item.usable ? '可使用' : '验证或权限尚未就绪'}
                    </small>
                    <button disabled={busy} onClick={() => void open(item.id)}>
                      查看能力
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            !loading && (
              <Empty>
                没有找到当前授权范围内的能力。可清空搜索或继续使用基础助手。
              </Empty>
            )
          )}
        </>
      )}
      {(detail || editor || selectedReview) && (
        <Drawer
          title={
            editor
              ? '编辑个人能力'
              : selectedReview
                ? '共享候选审查'
                : (detail?.title ?? '能力详情')
          }
          subtitle={selectedReview?.title ?? detail?.summary}
          onClose={() => {
            setDetail(null);
            setEditor(false);
            setSelectedReview(null);
            setSource(null);
          }}
          dirty={editor}
          wide={editor}
        >
          <ErrorNotice error={error} />
          {editor ? (
            <>
              <p className="finance-note">
                只保存任务说明与受控工具范围，不上传代码，不安装依赖。
              </p>
              <Field label="能力名称">
                <input
                  maxLength={32}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="用途简介">
                <textarea
                  rows={2}
                  maxLength={120}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </Field>
              <fieldset className="finance-tool-choices">
                <legend>选择已发布工具（最多 12 个）</legend>
                {capabilities.map((tool) => (
                  <label key={tool.id}>
                    <input
                      type="checkbox"
                      disabled={
                        !tool.current_version_id ||
                        (!selectedTools.includes(tool.current_version_id) &&
                          selectedTools.length >= 12)
                      }
                      checked={
                        !!tool.current_version_id &&
                        selectedTools.includes(tool.current_version_id)
                      }
                      onChange={(e) => {
                        const id = tool.current_version_id;
                        if (id)
                          setSelectedTools((v) =>
                            e.target.checked
                              ? [...v, id]
                              : v.filter((x) => x !== id),
                          );
                      }}
                    />
                    <span>
                      <strong>{tool.title}</strong>
                      <small>{tool.description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              {selectedTools.some(
                (id) =>
                  capabilities.find((c) => c.current_version_id === id)
                    ?.name === 'finance.action.prepare',
              ) && (
                <fieldset className="finance-inline-choices">
                  <legend>允许准备的业务操作</legend>
                  {operationOptions.map(([id, label]) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={allowedOperations.includes(id)}
                        onChange={(e) =>
                          setAllowedOperations((v) =>
                            e.target.checked
                              ? [...v, id]
                              : v.filter((x) => x !== id),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              <Field
                label="工作说明（Markdown）"
                hint="保留任务目标、适用范围、工作步骤、需要询问的情况、输出要求、禁止事项六节。"
              >
                <textarea
                  className="finance-editor"
                  rows={16}
                  value={markdown}
                  onChange={(e) => setMarkdown(e.target.value)}
                />
              </Field>
              <details className="finance-schema-editor">
                <summary>输入、输出与测试样例约束</summary>
                <p>
                  作者可编辑声明式配置；工具范围和名称使用上方选择。外部引用与执行声明会被拒绝。
                </p>
                <textarea
                  aria-label="能力输入输出与样例配置"
                  className="finance-editor"
                  rows={20}
                  value={manifestText}
                  onChange={(e) => setManifestText(e.target.value)}
                />
              </details>
              <button
                className="primary-button"
                disabled={busy || !title.trim() || !summary.trim()}
                onClick={() => void save()}
              >
                {busy ? '正在保存…' : '保存新版本'}
              </button>
            </>
          ) : selectedReview && source ? (
            <>
              <p className="finance-note">
                只审查当前候选内容与范围。批准后仍需另行确认发布，不会自动授予业务权限。
              </p>
              <h3>拟共享范围</h3>
              <p>{JSON.stringify(selectedReview.requested_scope)}</p>
              <h3>工具影响</h3>
              <ul>
                {source.manifest.tools.map((t) => (
                  <li key={t.capability_version_id}>
                    {t.capability_version_id}
                  </li>
                ))}
              </ul>
              <h3>候选工作说明</h3>
              <pre className="finance-source-context">{source.markdown}</pre>
              <details>
                <summary>查看输入输出与三类样例</summary>
                <pre className="finance-source-context">
                  {JSON.stringify(source.manifest, null, 2)}
                </pre>
              </details>
              <Field label="审查意见">
                <textarea
                  value={reason}
                  maxLength={1000}
                  rows={3}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="button-row">
                <button
                  disabled={busy || !reason.trim()}
                  onClick={() => void decide('rejected')}
                >
                  驳回并保存意见
                </button>
                <button
                  disabled={busy || !reason.trim()}
                  className="primary-button"
                  onClick={() => void decide('approved')}
                >
                  批准当前候选
                </button>
              </div>
            </>
          ) : (
            detail && (
              <>
                <div className="finance-detail-status">
                  <span>{states[detail.status] ?? '待验证'}</span>
                  <span>
                    {detail.version_number
                      ? `内容版本 ${detail.version_number}`
                      : '尚无可运行版本'}
                  </span>
                </div>
                {!detail.usable && (
                  <p className="finance-note">
                    此能力尚未通过真实验证、未激活或缺少所需业务权限。不会作为已接通能力运行。
                  </p>
                )}
                <div className="button-row">
                  <button
                    className="primary-button"
                    disabled={!detail.usable}
                    onClick={useSkill}
                  >
                    选择此能力
                  </button>
                  {detail.can_source_read && detail.version_id && (
                    <button disabled={busy} onClick={() => void readSource()}>
                      查看本人有权的工作说明
                    </button>
                  )}
                  {detail.can_maintain && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (source) setEditor(true);
                        else void readSource().then(() => setEditor(true));
                      }}
                    >
                      编辑为新版本
                    </button>
                  )}
                </div>
                {detail.tools && (
                  <section className="finance-detail-section">
                    <h3>使用的工具</h3>
                    <ul className="finance-tool-list">
                      {detail.tools.map((t) => (
                        <li key={t.capability_version_id}>
                          <span>
                            {capabilities.find(
                              (c) =>
                                c.current_version_id ===
                                t.capability_version_id,
                            )?.title ?? t.capability_version_id.split('@')[0]}
                          </span>
                          <small>{t.required ? '必需' : '可选'}</small>
                        </li>
                      ))}
                    </ul>
                    <p className="muted">
                      工具会再次校验当前权限，能力本身不扩大数据范围。
                    </p>
                  </section>
                )}
                {source && (
                  <section className="finance-detail-section">
                    <h3>工作说明</h3>
                    <pre className="finance-source-context">
                      {source.markdown}
                    </pre>
                    {detail.can_maintain && (
                      <div className="button-row">
                        <button
                          disabled={busy || source.status === 'validating'}
                          onClick={() => void validate()}
                        >
                          检查此版本
                        </button>
                        <button
                          disabled={busy || source.status !== 'validated'}
                          onClick={() => void activate()}
                        >
                          仅为本人启用
                        </button>
                      </div>
                    )}
                  </section>
                )}
                {validation && (
                  <section
                    className="finance-tests"
                    role="status"
                    aria-live="polite"
                  >
                    <h3>{states[validation.status] ?? '正在检查'}</h3>
                    {validation.checks.map((check, i) => (
                      <p key={i}>
                        <span>
                          {(
                            {
                              static: '声明与内容',
                              capabilities: '工具与版本',
                              examples: '受控样例',
                              model: '真实模型验证',
                              validation: '验证结果',
                            } as Record<string, string>
                          )[check.name] ?? '验证检查'}
                        </span>
                        <strong>{states[check.status] ?? check.status}</strong>
                        {check.message && <small>{check.message}</small>}
                      </p>
                    ))}
                    {validation.status === 'blocked' && (
                      <p>
                        真实模型或受控样例尚未配置。请保留此草稿，配置完成后重新检查。
                      </p>
                    )}
                  </section>
                )}
                {detail.can_maintain && source && (
                  <section className="finance-detail-section">
                    <h3>共享审查与发布</h3>
                    <p className="muted">
                      共享需要真实验证、独立审查与发布确认。
                    </p>
                    <Field label="共享范围">
                      <select
                        value={groupId}
                        onChange={(e) => setGroupId(e.target.value)}
                      >
                        <option value="">当前租户</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="指定独立审查人">
                      <select
                        value={reviewerId}
                        onChange={(e) => setReviewerId(e.target.value)}
                      >
                        <option value="">选择组织成员</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.display_name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button
                      disabled={
                        busy || source.status !== 'validated' || !reviewerId
                      }
                      onClick={() => void requestReview()}
                    >
                      提交共享审查
                    </button>
                    {detail.reviews?.map((r) => (
                      <div className="finance-version-row" key={r.id}>
                        <span>{states[r.status] ?? '待审查'}</span>
                        {r.decision_reason && (
                          <small>{r.decision_reason}</small>
                        )}
                        {r.status === 'approved' && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void publication(r.id, r.skill_version_id)
                            }
                          >
                            核对并发布此版本
                          </button>
                        )}
                      </div>
                    ))}
                  </section>
                )}
                {detail.can_maintain && (
                  <section className="finance-detail-section">
                    <h3>调用控制</h3>
                    <Field label="停用或恢复说明">
                      <input
                        value={reason}
                        maxLength={1000}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </Field>
                    <button
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        void setState(
                          detail.state === 'disabled' ? 'enable' : 'disable',
                        )
                      }
                    >
                      {detail.state === 'disabled'
                        ? '重新校验并启用'
                        : '停止后续调用'}
                    </button>
                  </section>
                )}
              </>
            )
          )}
        </Drawer>
      )}
      {confirmation && (
        <ConfirmationPanel
          initial={confirmation}
          actorName={me.display_name}
          onClose={() => setConfirmation(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}
