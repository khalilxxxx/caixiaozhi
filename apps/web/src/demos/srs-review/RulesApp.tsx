import { useEffect, useId, useMemo, useState } from 'react';
import type { Metric, Rule, Scope, SystemKey } from './model.js';
import {
  metricNames,
  ruleCondition,
  scopeNames,
  systemNames,
} from './model.js';
import { Button, Drawer, Icon } from './ui.js';
import './rules-app.css';

type NumericMetric = Extract<Metric, 'amount' | 'meal' | 'hotelNight' | 'days'>;
type RuleForm = {
  id?: string;
  name: string;
  system: SystemKey;
  scope: Scope;
  metric: NumericMetric;
  threshold: string;
};
type FormErrors = Partial<
  Record<'name' | 'threshold' | 'metric' | 'system' | 'scope', string>
>;

export interface RulesAppProps {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
  onToast: (text: string) => void;
  focusRuleId?: string;
  onFocusConsumed: () => void;
  createOnOpen?: boolean;
  onCreateConsumed: () => void;
}

const allowedMetrics: Record<SystemKey, NumericMetric[]> = {
  expense: ['amount', 'meal', 'hotelNight'],
  oa: ['days'],
};
const blankForm = (): RuleForm => ({
  name: '',
  system: 'expense',
  scope: 'review',
  metric: 'meal',
  threshold: '',
});
const thresholdUnit = (metric: Metric) =>
  metric === 'days' ? '天' : metric === 'hotelNight' ? '元 / 间夜' : '元';
const ruleForm = (rule: Rule): RuleForm => ({
  id: rule.id,
  name: rule.name,
  system: rule.system,
  scope: rule.scope,
  metric: (allowedMetrics[rule.system].includes(rule.metric as NumericMetric)
    ? rule.metric
    : allowedMetrics[rule.system][0]) as NumericMetric,
  threshold: rule.threshold === undefined ? '' : String(rule.threshold),
});
const scopeDescription = (scope: Scope) =>
  scope === 'both'
    ? '本人提单及待本人审核的单据'
    : scope === 'submit'
      ? '本人的提单'
      : '待本人审核的单据';
const descriptionFor = (form: RuleForm, threshold: number) =>
  `${metricNames[form.metric]}严格大于${threshold}${thresholdUnit(form.metric)}时，在${scopeNames[form.scope]}时提醒本人。`;

// The prototype accepts a bounded set of threshold statements, not arbitrary policy language.
function parseIntent(text: string): { form?: RuleForm; error?: string } {
  const normalized = text.trim().replace(/[\s，,。！!]/g, '');
  if (!normalized) return { error: '请先描述要检查的内容。' };
  const match = normalized.match(
    /^(?:(?:费用报销|报销系统|OA办公|OA系统|OA)中?)?(单据金额|报销金额|餐饮合计|餐饮费用|餐饮费|住宿单价|住宿费|每间夜住宿费用|申请天数|出差天数)(?:严格)?(?:超过|大于)(\d+(?:\.\d{1,2})?)(元\/间夜|元每间夜|元|天)?(?:时)?(?:(?:在)?(提单和审单|提单、审单|提交和审批|审单|审批|提单|提交)(?:时)?)?(?:提醒我|提醒本人|提醒|重点关注)$/i,
  );
  if (!match)
    return {
      error:
        '当前 Demo 仅支持单个金额或天数阈值。可参考“餐饮合计超过1500元时，审单时提醒我”；组合条件、例外和其他表达请直接填写下方表单。',
    };
  const field = match[1] ?? '';
  const metric: NumericMetric = /天数/.test(field)
    ? 'days'
    : /餐饮/.test(field)
      ? 'meal'
      : /住宿/.test(field)
        ? 'hotelNight'
        : 'amount';
  const system: SystemKey = metric === 'days' ? 'oa' : 'expense';
  const source = match[4] ?? '';
  const scope: Scope = /和|、/.test(source)
    ? 'both'
    : /提单|提交/.test(source)
      ? 'submit'
      : 'review';
  const value = Number(match[2]);
  if (!Number.isFinite(value) || value <= 0 || value > 100000000)
    return { error: '阈值须大于 0 且不超过 100,000,000。' };
  if (metric === 'days' && match[3] && match[3] !== '天')
    return { error: '申请天数请使用“天”作为单位。' };
  if (metric !== 'days' && match[3] === '天')
    return { error: '金额条件请使用“元”，住宿单价使用“元 / 间夜”。' };
  if (/^OA/i.test(normalized) && system !== 'oa')
    return {
      error:
        '当前 OA 办公示例只提供“申请天数”字段。金额条件请使用费用报销系统。',
    };
  if (/^(费用报销|报销系统)/.test(normalized) && system !== 'expense')
    return {
      error:
        '当前费用报销示例提供金额、餐饮合计和住宿单价；申请天数请使用 OA 办公系统。',
    };
  return {
    form: {
      name: `${metricNames[metric]}超过${value}${metric === 'days' ? '天' : '元'}提醒`,
      system,
      scope,
      metric,
      threshold: String(value),
    },
  };
}

export function RulesApp({
  rules,
  onChange,
  onToast,
  focusRuleId,
  onFocusConsumed,
  createOnOpen,
  onCreateConsumed,
}: RulesAppProps) {
  const formId = useId();
  const [query, setQuery] = useState('');
  const [systemFilter, setSystemFilter] = useState<'all' | SystemKey>('all');
  const [originFilter, setOriginFilter] = useState<'all' | Rule['origin']>(
    'all',
  );
  const [drawer, setDrawer] = useState<'edit' | 'view' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm>(blankForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [intent, setIntent] = useState('');
  const [intentError, setIntentError] = useState('');
  const [intentResult, setIntentResult] = useState('');
  const [naturalOpen, setNaturalOpen] = useState(false);

  const selected = rules.find((rule) => rule.id === selectedId);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rules.filter(
      (rule) =>
        (systemFilter === 'all' || rule.system === systemFilter) &&
        (originFilter === 'all' || rule.origin === originFilter) &&
        (!needle ||
          `${rule.name} ${ruleCondition(rule)} ${rule.id}`
            .toLocaleLowerCase()
            .includes(needle)),
    );
  }, [rules, query, systemFilter, originFilter]);

  function openCreate() {
    setForm(blankForm());
    setSelectedId(null);
    setErrors({});
    setIntent('');
    setIntentError('');
    setIntentResult('');
    setNaturalOpen(false);
    setDrawer('edit');
  }

  function openRule(rule: Rule) {
    setSelectedId(rule.id);
    setErrors({});
    setIntent('');
    setIntentError('');
    setIntentResult('');
    setNaturalOpen(false);
    if (rule.origin === 'builtin') setDrawer('view');
    else {
      setForm(ruleForm(rule));
      setDrawer('edit');
    }
  }

  useEffect(() => {
    if (!focusRuleId) return;
    const rule = rules.find((item) => item.id === focusRuleId);
    if (rule) openRule(rule);
    else onToast('这条规则已不存在，请在规则列表中重新选择。');
    onFocusConsumed();
  }, [focusRuleId]); // An external focus request is consumed once, never replayed by list edits.

  useEffect(() => {
    if (!createOnOpen) return;
    openCreate();
    onCreateConsumed();
  }, [createOnOpen]);

  function updateForm<K extends keyof RuleForm>(key: K, value: RuleForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setIntentResult('');
  }

  function changeSystem(system: SystemKey) {
    setForm((current) => ({
      ...current,
      system,
      metric: allowedMetrics[system][0]!,
      threshold: '',
    }));
    setErrors((current) => ({
      ...current,
      system: undefined,
      metric: undefined,
      threshold: undefined,
    }));
    setIntentResult('');
  }

  function generateForm() {
    const parsed = parseIntent(intent);
    if (parsed.error || !parsed.form) {
      setIntentError(parsed.error ?? '无法生成，请使用下方表单。');
      setIntentResult('');
      return;
    }
    setForm((current) => ({
      ...parsed.form!,
      ...(current.id ? { id: current.id } : {}),
    }));
    setErrors({});
    setIntentError('');
    setIntentResult(
      '已填入下方表单。请核对系统、执行场景和计量口径；尚未保存。',
    );
  }

  function validateForm() {
    const next: FormErrors = {};
    if (!form.name.trim()) next.name = '请输入规则名称。';
    else if (form.name.trim().length > 60) next.name = '规则名称最多 60 个字。';
    if (!(form.system in allowedMetrics))
      next.system = '请选择有效的业务系统。';
    else if (!allowedMetrics[form.system].includes(form.metric))
      next.metric = '所选字段在当前业务系统中不可用，请重新选择。';
    if (!['both', 'review', 'submit'].includes(form.scope))
      next.scope = '请选择执行场景。';
    const amount = Number(form.threshold);
    if (
      !form.threshold.trim() ||
      !/^\d+(?:\.\d{1,2})?$/.test(form.threshold.trim()) ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 100000000
    ) {
      next.threshold =
        '请输入大于 0、不超过 100,000,000 的数值，最多两位小数。';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function save(enabled: boolean) {
    if (!validateForm()) return;
    const existing = form.id
      ? rules.find((rule) => rule.id === form.id)
      : undefined;
    if (form.id && (!existing || existing.origin !== 'personal')) {
      onToast('当前规则无法编辑，请关闭后重新选择。');
      return;
    }
    const threshold = Number(form.threshold);
    const next: Rule = {
      id:
        existing?.id ??
        `P-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      name: form.name.trim(),
      system: form.system,
      origin: 'personal',
      scope: form.scope,
      metric: form.metric,
      threshold,
      effect: 'warn',
      enabled,
      version: (existing?.version ?? 0) + 1,
      description: descriptionFor(form, threshold),
    };
    onChange(
      existing
        ? rules.map((rule) => (rule.id === existing.id ? next : rule))
        : [...rules, next],
    );
    setDrawer(null);
    onToast(
      existing
        ? `“${next.name}”已更新为 v${next.version}，${enabled ? '保持启用' : '保持停用'}。`
        : enabled
          ? '个人规则已保存并启用，下次审查时生效。'
          : '规则已保存为未启用草稿。',
    );
  }

  function toggleRule(rule: Rule) {
    if (rule.origin !== 'personal') return;
    onChange(
      rules.map((item) =>
        item.id === rule.id
          ? { ...item, enabled: !item.enabled, version: item.version + 1 }
          : item,
      ),
    );
    onToast(
      `“${rule.name}”已${rule.enabled ? '停用' : '启用'}，不改变通用规则。`,
    );
  }

  const formValidThreshold =
    Number(form.threshold) > 0 && Number.isFinite(Number(form.threshold));
  return (
    <section className="r-app" aria-label="规则中心">
      <header className="r-page-header">
        <div>
          <h1>规则中心</h1>
          <p>通用规则默认执行。添加个人规则，补充你关心的检查。</p>
        </div>
        <Button className="primary" onClick={openCreate}>
          <Icon name="plus" size={16} />
          新增规则
        </Button>
      </header>

      <div className="r-toolbar">
        <label className="r-search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索规则名称或条件"
            placeholder="搜索规则名称、检查条件"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="清除规则搜索"
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <label className="r-filter">
          <span>系统</span>
          <select
            aria-label="按业务系统筛选"
            value={systemFilter}
            onChange={(event) =>
              setSystemFilter(event.target.value as 'all' | SystemKey)
            }
          >
            <option value="all">全部系统</option>
            <option value="expense">费用报销</option>
            <option value="oa">OA办公</option>
          </select>
        </label>
        <label className="r-filter">
          <span>来源</span>
          <select
            aria-label="按规则来源筛选"
            value={originFilter}
            onChange={(event) =>
              setOriginFilter(event.target.value as 'all' | Rule['origin'])
            }
          >
            <option value="all">全部来源</option>
            <option value="builtin">通用规则</option>
            <option value="personal">我的规则</option>
          </select>
        </label>
        <span className="r-result-count">{filtered.length} 条规则</span>
      </div>

      <div className="r-table-container">
        <table className="r-table">
          <thead>
            <tr>
              <th scope="col">规则名称 / 检查条件</th>
              <th scope="col">适用系统</th>
              <th scope="col">执行场景</th>
              <th scope="col">来源</th>
              <th scope="col">状态</th>
              <th scope="col">
                <span className="r-sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((rule) => (
              <tr key={rule.id}>
                <td>
                  <button
                    type="button"
                    className="r-rule-name"
                    onClick={() => openRule(rule)}
                  >
                    {rule.name}
                  </button>
                  <div className="r-condition" title={ruleCondition(rule)}>
                    {ruleCondition(rule)}
                  </div>
                </td>
                <td>
                  <span
                    className={`r-system-mark ${rule.system}`}
                    aria-hidden="true"
                  >
                    {rule.system === 'expense' ? '报' : 'OA'}
                  </span>
                  {systemNames[rule.system]}
                </td>
                <td>{scopeNames[rule.scope]}</td>
                <td>
                  <span
                    className={
                      rule.origin === 'builtin'
                        ? 'r-origin-default'
                        : 'r-origin-personal'
                    }
                  >
                    {rule.origin === 'builtin' ? (
                      <Icon name="shield" size={12} />
                    ) : null}
                    {rule.origin === 'builtin' ? '通用规则' : '我的规则'}
                  </span>
                </td>
                <td>
                  {rule.origin === 'builtin' ? (
                    <span className="r-enabled">
                      <i />
                      默认启用
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`r-status-toggle ${rule.enabled ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={rule.enabled}
                      aria-label={`${rule.enabled ? '停用' : '启用'}${rule.name}`}
                      onClick={() => toggleRule(rule)}
                    >
                      <span className="r-switch-track" aria-hidden="true">
                        <i />
                      </span>
                      <span>{rule.enabled ? '已启用' : '未启用'}</span>
                    </button>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="r-row-action"
                    onClick={() => openRule(rule)}
                    aria-label={`${rule.origin === 'builtin' ? '查看' : '编辑'}${rule.name}`}
                  >
                    {rule.origin === 'builtin' ? '查看' : '编辑'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="r-empty">
            <Icon name="search" size={24} />
            <h2>没有匹配的规则</h2>
            <p>试试其他关键词，或调整系统和来源筛选。</p>
            <Button
              className="subtle"
              onClick={() => {
                setQuery('');
                setSystemFilter('all');
                setOriginFilter('all');
              }}
            >
              清除筛选
            </Button>
          </div>
        )}
      </div>
      <div className="r-list-footer">
        <Icon name="shield" size={14} />
        <span>
          通用规则由平台统一维护，个人规则不能将其停用或覆盖。个人规则只提醒本人。
        </span>
      </div>

      {drawer === 'view' && selected && (
        <Drawer
          title="规则详情"
          eyebrow={`${selected.id} · v${selected.version}`}
          width={520}
          onClose={() => setDrawer(null)}
          footer={
            <Button className="subtle" onClick={() => setDrawer(null)}>
              关闭
            </Button>
          }
        >
          <div className="r-readonly-summary">
            <span className="r-origin-default">
              <Icon name="shield" size={13} />
              通用规则
            </span>
            <h2>{selected.name}</h2>
            <p>{selected.description}</p>
          </div>
          <dl className="r-detail-list">
            <div>
              <dt>适用系统</dt>
              <dd>{systemNames[selected.system]}</dd>
            </div>
            <div>
              <dt>执行场景</dt>
              <dd>{scopeNames[selected.scope]}</dd>
            </div>
            <div>
              <dt>检查条件</dt>
              <dd>{ruleCondition(selected)}</dd>
            </div>
            <div>
              <dt>异常处理</dt>
              <dd>
                {selected.effect === 'block'
                  ? '提单时阻断提交；审单时展示异常及处理建议。'
                  : '提示关注，由用户核实后继续。'}
              </dd>
            </div>
            <div>
              <dt>规则状态</dt>
              <dd>
                <span className="r-enabled">
                  <i />
                  默认启用
                </span>
              </dd>
            </div>
            <div>
              <dt>依据来源</dt>
              <dd>
                平台预置通用规则（演示）<small>{selected.description}</small>
              </dd>
            </div>
            <div>
              <dt>当前版本</dt>
              <dd>v{selected.version}</dd>
            </div>
          </dl>
          <div className="r-help-note">
            <Icon name="shield" size={16} />
            <p>
              当前身份仅可查看。个人规则用于补充关注，不能修改或关闭这条通用规则。
            </p>
          </div>
        </Drawer>
      )}

      {drawer === 'edit' && (
        <Drawer
          title={form.id ? '编辑个人规则' : '新增个人规则'}
          eyebrow={
            form.id
              ? `${form.id} · 当前 v${selected?.version ?? 1}`
              : '只对本人有效'
          }
          width={560}
          onClose={() => setDrawer(null)}
          footer={
            <div className="r-drawer-actions">
              <Button className="subtle" onClick={() => setDrawer(null)}>
                取消
              </Button>
              <span />
              {form.id ? (
                <Button
                  className="primary"
                  onClick={() => save(selected?.enabled ?? false)}
                >
                  保存修改
                </Button>
              ) : (
                <>
                  <Button className="subtle" onClick={() => save(false)}>
                    保存草稿
                  </Button>
                  <Button className="primary" onClick={() => save(true)}>
                    保存并启用
                  </Button>
                </>
              )}
            </div>
          }
        >
          <div className="r-form-content">
            <details
              className="r-natural"
              open={naturalOpen}
              onToggle={(event) => setNaturalOpen(event.currentTarget.open)}
            >
              <summary>
                <Icon name="edit" size={15} />
                <span>用一句话生成规则</span>
                <Icon name="chevron" size={14} />
              </summary>
              <div className="r-natural-body">
                <label htmlFor={`${formId}-intent`}>描述要提醒你的情况</label>
                <textarea
                  id={`${formId}-intent`}
                  value={intent}
                  onChange={(event) => {
                    setIntent(event.target.value);
                    setIntentError('');
                  }}
                  rows={2}
                  placeholder="餐饮合计超过1500元时，审单时提醒我"
                />
                <div className="r-natural-bottom">
                  <span>支持金额、餐饮、住宿单价或申请天数阈值。</span>
                  <Button className="subtle" onClick={generateForm}>
                    生成表单
                  </Button>
                </div>
                {intentError && (
                  <p className="r-error" role="alert">
                    {intentError}
                  </p>
                )}
                {intentResult && (
                  <p className="r-success-note" role="status">
                    <Icon name="check" size={14} />
                    {intentResult}
                  </p>
                )}
              </div>
            </details>

            <label className="r-field" htmlFor={`${formId}-name`}>
              <span>
                规则名称 <em>*</em>
              </span>
              <input
                id={`${formId}-name`}
                value={form.name}
                onChange={(event) => updateForm('name', event.target.value)}
                placeholder="例如：大额餐饮提醒"
                maxLength={60}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={
                  errors.name ? `${formId}-name-error` : undefined
                }
              />
              {errors.name && (
                <small className="r-error" id={`${formId}-name-error`}>
                  {errors.name}
                </small>
              )}
            </label>
            <div className="r-form-row">
              <label className="r-field" htmlFor={`${formId}-system`}>
                <span>
                  适用系统 <em>*</em>
                </span>
                <select
                  id={`${formId}-system`}
                  value={form.system}
                  onChange={(event) =>
                    changeSystem(event.target.value as SystemKey)
                  }
                  aria-invalid={Boolean(errors.system)}
                >
                  <option value="expense">费用报销</option>
                  <option value="oa">OA办公</option>
                </select>
                {errors.system && (
                  <small className="r-error">{errors.system}</small>
                )}
              </label>
              <label className="r-field" htmlFor={`${formId}-scope`}>
                <span>
                  执行场景 <em>*</em>
                </span>
                <select
                  id={`${formId}-scope`}
                  value={form.scope}
                  onChange={(event) =>
                    updateForm('scope', event.target.value as Scope)
                  }
                  aria-invalid={Boolean(errors.scope)}
                >
                  <option value="review">审单时</option>
                  <option value="submit">提单时</option>
                  <option value="both">提单和审单时</option>
                </select>
                {errors.scope && (
                  <small className="r-error">{errors.scope}</small>
                )}
              </label>
            </div>
            <fieldset className="r-condition-fields">
              <legend>
                检查条件 <em>*</em>
              </legend>
              <div className="r-condition-inputs">
                <label className="r-field">
                  <span className="r-sr-only">检查字段</span>
                  <select
                    value={form.metric}
                    onChange={(event) =>
                      updateForm('metric', event.target.value as NumericMetric)
                    }
                    aria-label="检查字段"
                    aria-invalid={Boolean(errors.metric)}
                  >
                    {allowedMetrics[form.system].map((metric) => (
                      <option value={metric} key={metric}>
                        {metricNames[metric]}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="r-operator">严格大于</span>
                <label className="r-field r-threshold">
                  <span className="r-sr-only">提醒阈值</span>
                  <input
                    value={form.threshold}
                    onChange={(event) =>
                      updateForm('threshold', event.target.value)
                    }
                    aria-label="提醒阈值"
                    inputMode="decimal"
                    placeholder="输入数值"
                    aria-invalid={Boolean(errors.threshold)}
                  />
                  <span className="r-input-unit">
                    {thresholdUnit(form.metric)}
                  </span>
                </label>
              </div>
              {errors.metric && (
                <small className="r-error">{errors.metric}</small>
              )}
              {errors.threshold && (
                <small className="r-error" role="alert">
                  {errors.threshold}
                </small>
              )}
              <p className="r-field-hint">
                {form.metric === 'meal'
                  ? '按单张报销单的餐饮费用合计判断，不按单张发票。'
                  : form.metric === 'hotelNight'
                    ? '按住宿金额 / 间夜判断，币种为人民币。'
                    : form.metric === 'amount'
                      ? '按单张报销单的总金额判断，币种为人民币。'
                      : '按单张 OA 申请的申请天数判断。'}
                等于阈值时不触发。
              </p>
            </fieldset>
            <div className="r-effect">
              <span>触发后</span>
              <strong>提醒本人</strong>
              <p>不阻断提单，不自动批准或退回单据。</p>
            </div>
            <div className="r-form-preview">
              <h3>规则预览</h3>
              <p>
                {scopeDescription(form.scope)}中，{metricNames[form.metric]}
                严格大于{' '}
                <strong>
                  {formValidThreshold ? form.threshold : '—'}{' '}
                  {thresholdUnit(form.metric)}
                </strong>{' '}
                时，提醒本人关注。
              </p>
              {form.id && (
                <small>
                  保存后生成 v{(selected?.version ?? 0) + 1}，
                  {selected?.enabled ? '继续启用' : '保持未启用'}
                  。原审查结果需按新规则重新检查。
                </small>
              )}
            </div>
          </div>
        </Drawer>
      )}
    </section>
  );
}
