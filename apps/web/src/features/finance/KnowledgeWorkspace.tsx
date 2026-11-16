import { useEffect, useRef, useState } from 'react';
import type { Department, Me } from '@caixiaozhi/contracts/identity';
import type {
  PolicyView,
  PolicyCitation,
  RetrievalSnapshot,
} from '@caixiaozhi/contracts/knowledge';
import type { InteractiveConfirmationReview } from '@caixiaozhi/contracts/actions';
import {
  RuleDslSchema,
  type RuleDraftInput,
  type RuleDsl,
  type RuleTestProof,
  type RuleTestTaskAccepted,
  type RuleTestTaskView,
} from '@caixiaozhi/contracts/rules';
import { api, uploadBytes } from '../../api.js';
import {
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  SectionTitle,
  Status,
} from '../../ui.js';
import {
  ConfirmationPanel,
  prepareConfirmation,
} from '../business/ConfirmationPanel.js';
import { MappingsWorkspace } from './MappingsWorkspace.js';
type RuleCategory = RuleDraftInput['category'];
type Rule = {
  id: string;
  name: string;
  level: 'personal' | 'company';
  category: RuleCategory;
  version: number;
  lifecycle: string;
  owner_id: string;
  active_version_id: string | null;
  draft_version_id: string | null;
  versions: Array<{
    id: string;
    version_number: number;
    dsl_json: RuleDsl;
    content_hash: string;
    source_citation_ids: string[];
    source_kind: 'policy' | 'manual_company_decision' | 'personal';
    publication_state: string;
    explanation: string;
  }>;
};
type TestTask = {
  task_id: string;
  rule_id: string;
  status: RuleTestTaskView['status'];
  completed_cases: number;
  total_cases: number;
};
type RuleTestSet = {
  id: string;
  rule_id: string;
  draft_version_id: string;
  draft_hash: string;
  name: string;
  cases: Array<{
    name: string;
    input: unknown;
    expected_truth: 'true' | 'false' | 'unknown';
  }>;
  case_count: number;
  status: 'current' | 'stale';
};
type RuleDiff = {
  message: string;
  warnings: string[];
  changes: Array<{ kind: string; path: string; explanation: string }>;
};
const categoryLabels: Record<RuleCategory, string> = {
  invoice: '票据',
  transport: '交通',
  lodging: '住宿',
  meals: '餐饮',
  itinerary: '行程',
  general: '通用',
};
const currentRuleVersion = (rule: Rule | null) =>
  rule?.versions.find(
    (v) => v.id === (rule.draft_version_id ?? rule.active_version_id),
  );
export function KnowledgeWorkspace({ me }: { me: Me }) {
  const [tab, setTab] = useState<'policies' | 'rules' | 'mappings'>('policies'),
    [policies, setPolicies] = useState<PolicyView[]>([]),
    [rules, setRules] = useState<Rule[]>([]),
    [query, setQuery] = useState(''),
    [date, setDate] = useState('2026-11-05'),
    [retrieval, setRetrieval] = useState<RetrievalSnapshot | null>(null),
    [citation, setCitation] = useState<
      (PolicyCitation & { context: string }) | null
    >(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null),
    [review, setReview] = useState<InteractiveConfirmationReview | null>(null),
    [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false),
    [importTitle, setImportTitle] = useState(''),
    [policyCode, setPolicyCode] = useState(''),
    [existingPolicy, setExistingPolicy] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [effective, setEffective] = useState('2026-11-05'),
    [importTask, setImportTask] = useState<{
      id: string;
      stage: string;
    } | null>(null);
  const manageableDepartments = [
    ...new Set(
      me.grants
        .filter(
          (g) =>
            g.capability === 'knowledge.manage' &&
            g.scope_type === 'department',
        )
        .flatMap((g) => g.scope_ids),
    ),
  ];
  const companyDepartments = [
    ...new Set(
      me.grants
        .filter(
          (g) =>
            g.capability === 'rule.manage.company' &&
            g.scope_type === 'department',
        )
        .flatMap((g) => g.scope_ids),
    ),
  ];
  const canManageCompany =
    me.actor.permissions.includes('rule.manage.company') &&
    companyDepartments.length > 0;
  const mayEditCompany = (rule: Rule | null) =>
    canManageCompany &&
    (!rule ||
      !!currentRuleVersion(rule)?.dsl_json.applicability.department_ids.every(
        (id) => companyDepartments.includes(id),
      ));
  const [ruleLevel, setRuleLevel] = useState<'company' | 'personal'>(
      'personal',
    ),
    [ruleCategory, setRuleCategory] = useState<RuleCategory>('general'),
    [companyDsl, setCompanyDsl] = useState(''),
    [ruleDepartments, setRuleDepartments] = useState(companyDepartments),
    [ruleSources, setRuleSources] = useState<string[]>([]),
    [sourceQuery, setSourceQuery] = useState(''),
    [sourceRetrieval, setSourceRetrieval] = useState<RetrievalSnapshot | null>(
      null,
    ),
    [ruleNotice, setRuleNotice] = useState(''),
    [departments, setDepartments] = useState<Department[]>([]),
    [ruleDiff, setRuleDiff] = useState<RuleDiff | null>(null),
    [diffError, setDiffError] = useState<unknown>(null),
    [diffReload, setDiffReload] = useState(0);
  const [testSets, setTestSets] = useState<RuleTestSet[]>([]),
    [selectedTestSet, setSelectedTestSet] = useState('boundary-v1'),
    [testSetsLoading, setTestSetsLoading] = useState(false),
    [testSetsError, setTestSetsError] = useState<unknown>(null),
    [testSetName, setTestSetName] = useState(''),
    [testCasesText, setTestCasesText] = useState('[]'),
    [sampleDirty, setSampleDirty] = useState(false),
    [testSetNotice, setTestSetNotice] = useState(''),
    [testSetsReload, setTestSetsReload] = useState(0);
  const [selectedDepartments, setSelectedDepartments] = useState(
      manageableDepartments,
    ),
    [editingRule, setEditingRule] = useState<Rule | null>(null),
    [ruleOpen, setRuleOpen] = useState(false),
    [ruleName, setRuleName] = useState('餐饮费用提醒'),
    [threshold, setThreshold] = useState('1000'),
    [purpose, setPurpose] = useState(
      me.actor.roles.includes('manager')
        ? 'manager_review'
        : 'employee_precheck',
    ),
    [test, setTest] = useState<RuleTestProof | null>(null),
    [testTask, setTestTask] = useState<TestTask | null>(null),
    [ruleDirty, setRuleDirty] = useState(false);
  const openEpoch = useRef(0),
    testEpoch = useRef(0),
    clearTest = () => {
      testEpoch.current++;
      setTest(null);
      setTestTask(null);
    };
  const editRule = () => {
    setRuleDirty(true);
    setRuleNotice('');
    clearTest();
    setSelectedTestSet('boundary-v1');
  };
  const companyEditor = ruleLevel === 'company' && mayEditCompany(editingRule);
  const load = async () => {
    setLoading(true);
    try {
      const values = await Promise.all([
        api<{ items: PolicyView[] }>('/knowledge/policies'),
        api<{ items: Rule[] }>('/rules'),
        api<{ items: Department[] }>('/directory/departments'),
      ]);
      setPolicies(values[0].items);
      setRules(values[1].items);
      setDepartments(values[2].items);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      openEpoch.current++;
    };
  }, []);
  useEffect(() => {
    setTestSets([]);
    setSelectedTestSet('boundary-v1');
    setTestSetsError(null);
    setTestSetsLoading(false);
    if (!ruleOpen || !companyEditor || !editingRule?.draft_version_id) return;
    const draft = currentRuleVersion(editingRule);
    if (!draft) return;
    let live = true;
    setTestSetsLoading(true);
    void api<{ items: RuleTestSet[] }>(`/rules/${editingRule.id}/test-sets`)
      .then((value) => {
        if (live)
          setTestSets(
            value.items.filter(
              (item) =>
                item.status === 'current' &&
                item.rule_id === editingRule.id &&
                item.draft_version_id === draft.id &&
                item.draft_hash === draft.content_hash,
            ),
          );
      })
      .catch((failure) => {
        if (live) setTestSetsError(failure);
      })
      .finally(() => {
        if (live) setTestSetsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [ruleOpen, editingRule, companyEditor, testSetsReload]);
  useEffect(() => {
    setRuleDiff(null);
    setDiffError(null);
    if (
      !ruleOpen ||
      editingRule?.level !== 'company' ||
      !editingRule.active_version_id ||
      !editingRule.draft_version_id
    )
      return;
    const from = editingRule.versions.find(
        (v) => v.id === editingRule.active_version_id,
      ),
      to = editingRule.versions.find(
        (v) => v.id === editingRule.draft_version_id,
      );
    if (!from || !to) return;
    let live = true;
    void api<RuleDiff>(
      `/rules/${editingRule.id}/diff?from_version=${from.version_number}&to_version=${to.version_number}`,
    )
      .then((value) => {
        if (live) setRuleDiff(value);
      })
      .catch((failure) => {
        if (live) setDiffError(failure);
      });
    return () => {
      live = false;
    };
  }, [ruleOpen, editingRule, test?.test_run_id, diffReload]);
  useEffect(() => {
    if (!importTask || ['ready', 'failed'].includes(importTask.stage)) return;
    let live = true;
    const timer = setTimeout(() => {
      void api<{ id: string; stage: string }>(
        `/knowledge/imports/${importTask.id}`,
      )
        .then((value) => {
          if (live) {
            setImportTask(value);
            if (value.stage === 'ready') {
              setNotice('制度原文已解析，请核对版本与适用范围后发布。');
              void load();
            }
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
  }, [importTask]);
  useEffect(() => {
    if (
      !ruleOpen ||
      !testTask ||
      !['queued', 'running'].includes(testTask.status)
    )
      return;
    let live = true;
    const epoch = testEpoch.current,
      timer = setTimeout(() => {
        void api<RuleTestTaskView>(
          `/rules/${testTask.rule_id}/tests/${testTask.task_id}`,
        )
          .then((value) => {
            if (live && epoch === testEpoch.current) {
              setTestTask(value);
              setTest(value.status === 'completed' ? value.proof : null);
              if (value.status === 'completed')
                setNotice(
                  value.proof?.passed
                    ? '所选样例已完成验证，请核对后确认生效。'
                    : '样例尚未全部通过，请检查规则。',
                );
            }
          })
          .catch((e) => {
            if (live && epoch === testEpoch.current) setError(e);
          });
      }, 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ruleOpen, testTask]);
  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setRetrieval(
        await api('/knowledge/search', {
          method: 'POST',
          body: { query, business_date: date, top_k: 6 },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const openCitation = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setCitation(await api(`/knowledge/citations/${id}`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const publish = async (
    policy: PolicyView,
    v: PolicyView['versions'][number],
    withdraw = false,
  ) => {
    setBusy(true);
    setError(null);
    try {
      setReview(
        await prepareConfirmation({
          action: withdraw ? 'policy.withdraw' : 'policy.publish',
          resource_refs: [
            { type: 'policy', id: policy.id, version: v.version_no },
          ],
          args: {
            policy_id: policy.id,
            version_id: v.id,
            expected_version: v.version,
            withdraw,
          },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const importPolicy = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await file.arrayBuffer(),
        mime = file.name.endsWith('.md') ? 'text/markdown' : 'text/plain';
      const registration = await api<{
        file: { id: string; version: number };
        upload_target: {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
      }>('/files', {
        method: 'POST',
        body: {
          filename: file.name,
          mime_type: mime,
          size_bytes: file.size,
          profile: 'policy-text-v1',
        },
      });
      const uploaded = await uploadBytes(registration.upload_target, bytes),
        digest = await crypto.subtle.digest('SHA-256', bytes),
        hash = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      await api(`/files/${registration.file.id}/finalize`, {
        method: 'POST',
        body: { expected_version: uploaded.version, sha256: hash },
      });
      const prior = policies.find((p) => p.id === existingPolicy),
        orgs = prior?.versions.at(-1)?.organization_ids ?? selectedDepartments;
      const result = await api<{ import_id: string; stage: string }>(
        '/knowledge/policies',
        {
          method: 'POST',
          body: {
            policy_id: prior?.id ?? `pol-${crypto.randomUUID()}`,
            policy_code: prior?.policy_code ?? policyCode,
            title: prior?.title ?? importTitle,
            source_file_id: registration.file.id,
            organization_ids: orgs,
            effective_from: effective,
            effective_to: null,
            topic_tags: [],
            supersedes_version_id:
              prior?.versions
                .filter((v) => v.publication_state === 'published')
                .at(-1)?.id ?? null,
          },
        },
      );
      setImportTask({ id: result.import_id, stage: result.stage });
      setNotice('原文已保存，正在解析。解析完成后仍需本人确认发布。');
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const openRule = async (
    value: Rule | null,
    level: Rule['level'] = 'personal',
  ) => {
    if (busy) return;
    const epoch = ++openEpoch.current;
    if (value) {
      setBusy(true);
      setError(null);
      try {
        value = await api<Rule>(`/rules/${value.id}`);
      } catch (failure) {
        if (epoch === openEpoch.current) setError(failure);
        return;
      } finally {
        if (epoch === openEpoch.current) setBusy(false);
      }
      if (epoch !== openEpoch.current) return;
    }
    clearTest();
    setRuleDirty(false);
    setRuleNotice('');
    setError(null);
    setEditingRule(value);
    const nextLevel = value?.level ?? level;
    setRuleLevel(nextLevel);
    setRuleName(
      value?.name ??
        (nextLevel === 'company' ? '公司单据金额上限' : '餐饮费用提醒'),
    );
    setRuleCategory(value?.category ?? 'general');
    setThreshold('1000');
    const v = currentRuleVersion(value);
    setCompanyDsl(v ? JSON.stringify(v.dsl_json, null, 2) : '');
    setRuleDepartments(
      v?.dsl_json.applicability.department_ids ?? companyDepartments,
    );
    setRuleSources(v?.source_citation_ids ?? []);
    setSourceQuery('');
    setSourceRetrieval(null);
    setTestSets([]);
    setSelectedTestSet('boundary-v1');
    setTestSetName('');
    setTestCasesText('[]');
    setSampleDirty(false);
    setTestSetNotice('');
    if (
      v?.dsl_json.predicate.op === 'compare' &&
      v.dsl_json.predicate.right.op === 'literal' &&
      typeof v.dsl_json.predicate.right.value === 'object' &&
      !Array.isArray(v.dsl_json.predicate.right.value) &&
      'amount_minor' in v.dsl_json.predicate.right.value
    ) {
      const cents = BigInt(v.dsl_json.predicate.right.value.amount_minor);
      setThreshold(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
    }
    setPurpose(
      v?.dsl_json.applicability.purposes[0] ??
        (nextLevel === 'company'
          ? 'finance_review'
          : me.actor.roles.includes('manager')
            ? 'manager_review'
            : 'employee_precheck'),
    );
    setRuleOpen(true);
  };
  const searchRuleSources = async () => {
    setBusy(true);
    setError(null);
    try {
      setSourceRetrieval(
        await api('/knowledge/search', {
          method: 'POST',
          body: { query: sourceQuery, business_date: date, top_k: 6 },
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const saveRule = async () => {
    clearTest();
    setBusy(true);
    setError(null);
    try {
      if (
        (!editingRule || ruleLevel === 'personal') &&
        !/^\d+(?:\.\d{1,2})?$/.test(threshold)
      )
        throw new Error('请输入最多两位小数的人民币金额。');
      const [yuan, cents = ''] = threshold.split('.'),
        amount = (
          BigInt(yuan!) * 100n +
          BigInt(cents.padEnd(2, '0'))
        ).toString();
      const dsl: RuleDsl = {
        dsl_version: 1,
        outcome_mode: 'attention_trigger',
        applicability: {
          modules: ['expense_claim'],
          department_ids: [me.department_id],
          purposes: [
            purpose as
              'employee_precheck' | 'manager_review' | 'finance_review',
          ],
          basis: 'submitted_date',
          unit: 'document_category_total',
          effective_from: '2026-01-01',
          effective_to: null,
        },
        predicate: {
          op: 'compare',
          comparator: 'gt',
          left: {
            op: 'sum',
            collection: 'expense_items',
            where: {
              op: 'compare',
              comparator: 'eq',
              left: { op: 'field', path: 'item.category' },
              right: { op: 'literal', value: 'meals' },
            },
            value: { op: 'field', path: 'item.amount' },
          },
          right: {
            op: 'literal',
            value: { amount_minor: amount, currency: 'CNY' },
          },
        },
      };
      let body: RuleDraftInput = {
        name: ruleName,
        level: 'personal',
        category: 'meals',
        dsl_json: dsl,
        source_kind: 'personal',
        source_citation_ids: [],
      };
      if (ruleLevel === 'company') {
        if (!companyEditor)
          throw new Error('当前身份没有此组织范围的公司规则管理授权。');
        if (!ruleSources.length)
          throw new Error('请从真实制度检索中至少选择一条原文依据。');
        let nextDsl: RuleDsl;
        if (editingRule) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(companyDsl);
          } catch {
            throw new Error(
              '检查条件不是有效的 JSON，请保留声明式规则结构后重试。',
            );
          }
          const parsed = RuleDslSchema.safeParse(parsedJson);
          if (!parsed.success)
            throw new Error(
              '检查条件不符合声明式规则格式，请核对字段、比较条件与适用范围。',
            );
          nextDsl = parsed.data;
        } else {
          nextDsl = {
            dsl_version: 1,
            outcome_mode: 'mandatory_check',
            failure_kind: 'violation',
            applicability: {
              modules: ['expense_claim'],
              department_ids: ruleDepartments,
              purposes: [
                purpose as
                  'employee_precheck' | 'manager_review' | 'finance_review',
              ],
              basis: 'submitted_date',
              unit: 'document',
              effective_from: '2026-01-01',
              effective_to: null,
            },
            predicate: {
              op: 'compare',
              comparator: 'lte',
              left: { op: 'field', path: 'total_amount' },
              right: {
                op: 'literal',
                value: { amount_minor: amount, currency: 'CNY' },
              },
            },
          };
        }
        if (nextDsl.outcome_mode !== 'mandatory_check')
          throw new Error('公司规则必须保留必查模式，不能改为个人提醒。');
        if (
          !nextDsl.applicability.department_ids.length ||
          nextDsl.applicability.department_ids.some(
            (id) => !companyDepartments.includes(id),
          )
        )
          throw new Error('适用部门必须在当前公司规则管理授权范围内。');
        body = {
          name: ruleName,
          level: 'company',
          category: ruleCategory,
          dsl_json: nextDsl,
          source_kind: 'policy',
          source_citation_ids: ruleSources,
        };
      }
      const value = editingRule
        ? await api<Rule>(`/rules/${editingRule.id}/draft`, {
            method: 'PATCH',
            body: { expected_version: editingRule.version, ...body },
          })
        : await api<Rule>('/rules', { method: 'POST', body });
      setEditingRule(value);
      const savedVersion = currentRuleVersion(value);
      if (savedVersion)
        setCompanyDsl(JSON.stringify(savedVersion.dsl_json, null, 2));
      setRuleDirty(false);
      const message =
        ruleLevel === 'company'
          ? value.active_version_id
            ? '公司草稿已保存，已发布版本继续生效。'
            : '公司规则草稿已保存。先验证边界，再由本人确认发布。'
          : '个人规则草稿已保存。先验证边界，再确认启用。';
      setRuleNotice(message);
      setNotice(message);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const registerTestSet = async () => {
    if (!companyEditor || !editingRule?.draft_version_id || ruleDirty) return;
    clearTest();
    setBusy(true);
    setTestSetsError(null);
    try {
      let cases: unknown;
      try {
        cases = JSON.parse(testCasesText);
      } catch {
        throw new Error('人工样例不是有效 JSON，请核对后重新登记。');
      }
      if (!Array.isArray(cases) || cases.length < 4 || cases.length > 100)
        throw new Error('专用样例集需要 4–100 项完整合成输入和人工预期。');
      const registered = await api<RuleTestSet>(
        `/rules/${editingRule.id}/test-sets`,
        {
          method: 'POST',
          body: {
            expected_version: editingRule.version,
            name: testSetName,
            cases,
          },
        },
      );
      setTestSets((items) => [
        ...items.filter((item) => item.id !== registered.id),
        registered,
      ]);
      setSelectedTestSet(registered.id);
      setTestCasesText(JSON.stringify(registered.cases, null, 2));
      setSampleDirty(false);
      setTestSetNotice(
        `“${registered.name}”已登记并绑定当前草稿，共 ${registered.case_count} 项。请运行所选样例测试。`,
      );
    } catch (failure) {
      setTestSetsError(failure);
    } finally {
      setBusy(false);
    }
  };
  const testRule = async () => {
    if (!editingRule || ruleDirty || (ruleLevel === 'company' && sampleDirty))
      return;
    clearTest();
    const epoch = testEpoch.current;
    setBusy(true);
    setError(null);
    try {
      const accepted = await api<RuleTestTaskAccepted>(
        `/rules/${editingRule.id}/tests`,
        {
          method: 'POST',
          body: {
            expected_version: editingRule.version,
            test_set_id:
              ruleLevel === 'company' ? selectedTestSet : 'boundary-v1',
          },
        },
      );
      if (epoch === testEpoch.current)
        setTestTask({
          task_id: accepted.task_id,
          rule_id: editingRule.id,
          status: 'queued',
          completed_cases: 0,
          total_cases:
            ruleLevel === 'company'
              ? (testSets.find((set) => set.id === selectedTestSet)
                  ?.case_count ?? 4)
              : 4,
        });
    } catch (e) {
      if (epoch === testEpoch.current) setError(e);
    } finally {
      setBusy(false);
    }
  };
  const enableRule = async () => {
    if (
      !editingRule ||
      !test?.passed ||
      testTask?.status !== 'completed' ||
      ruleDirty ||
      sampleDirty ||
      (editingRule.level === 'company' &&
        !!editingRule.active_version_id &&
        !ruleDiff)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      setReview(
        await prepareConfirmation({
          action:
            editingRule.level === 'company' ? 'rule.publish' : 'rule.enable',
          resource_refs: [
            { type: 'rule', id: editingRule.id, version: editingRule.version },
          ],
          args: {
            rule_id: editingRule.id,
            expected_version: editingRule.version,
            draft_hash: test.draft_hash,
            test_run_id: test.test_run_id,
          },
        }),
      );
      clearTest();
      setRuleOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const mayDisableRule = (rule: Rule) =>
    !!rule.active_version_id &&
    (rule.level === 'company'
      ? mayEditCompany(rule)
      : rule.owner_id === me.actor.user_id &&
        me.actor.permissions.includes('rule.manage.personal'));
  const disableRule = async (rule: Rule) => {
    if (!mayDisableRule(rule)) return;
    setBusy(true);
    setError(null);
    try {
      setReview(
        await prepareConfirmation({
          action: 'rule.disable',
          resource_refs: [{ type: 'rule', id: rule.id, version: rule.version }],
          args: { rule_id: rule.id, expected_version: rule.version },
        }),
      );
      clearTest();
      setRuleOpen(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const truthLabel = (truth: string) =>
    truth === 'unknown'
      ? '保留未知'
      : ruleLevel === 'company'
        ? truth === 'true'
          ? '检查通过'
          : '检查不通过'
        : truth === 'true'
          ? '命中提醒'
          : '不命中';
  const renderVerification = () => (
    <>
      {ruleNotice && <p className="finance-note">{ruleNotice}</p>}
      {companyEditor && (
        <section aria-label="公司规则测试样例">
          <h3>测试样例</h3>
          <Field
            label="测试样例集"
            hint="专用样例集只适用于登记时的当前草稿。保存规则修改后，请重新登记或选择匹配草稿的样例集。"
          >
            <select
              value={selectedTestSet}
              disabled={
                testSetsLoading || ruleDirty || !editingRule?.draft_version_id
              }
              onChange={(event) => {
                const id = event.target.value,
                  selected = testSets.find((item) => item.id === id);
                clearTest();
                setSelectedTestSet(id);
                setTestSetName(selected?.name ?? '');
                setTestCasesText(
                  selected ? JSON.stringify(selected.cases, null, 2) : '[]',
                );
                setSampleDirty(false);
                setTestSetNotice('');
              }}
            >
              <option value="boundary-v1">
                金额边界：阈值上下 1 分、等于、未知（4 项）
              </option>
              {testSets.map((set) => (
                <option key={set.id} value={set.id}>
                  {set.name}（{set.case_count} 项人工样例）
                </option>
              ))}
            </select>
          </Field>
          {testSetsLoading && (
            <p className="finance-note">正在读取当前草稿已登记的样例集…</p>
          )}
          <details className="finance-rule-test-set">
            <summary>高级：人工专用样例集</summary>
            <p>
              用于住宿逐项检查、票据等复杂声明式规则。请维护 4–100
              项合成测试数据与独立人工预期，再登记到当前草稿。
            </p>
            <p className="finance-note">
              每项包含唯一名称 name、完整的 SRS 输入 input，以及
              expected_truth（true、false 或
              unknown）。实际结果由持久任务运行规则后给出；预期不匹配时不能发布。
            </p>
            <ErrorNotice error={testSetsError} />
            {!!testSetsError && (
              <button
                onClick={() => {
                  clearTest();
                  setTestSetsReload((value) => value + 1);
                }}
              >
                重新读取已登记样例集
              </button>
            )}
            <Field label="样例集名称">
              <input
                maxLength={120}
                value={testSetName}
                onChange={(event) => {
                  setTestSetName(event.target.value);
                  setSampleDirty(true);
                  setTestSetNotice('');
                  clearTest();
                }}
              />
            </Field>
            <Field
              label="人工样例（JSON）"
              hint="仅接受符合服务端严格结构的数据，不执行脚本。输入应明确给出金额、组织、日期、费用行与字段缺失状态。"
            >
              <textarea
                rows={18}
                spellCheck={false}
                value={testCasesText}
                onChange={(event) => {
                  setTestCasesText(event.target.value);
                  setSampleDirty(true);
                  setTestSetNotice('');
                  clearTest();
                }}
              />
            </Field>
            <button
              disabled={
                busy ||
                testSetsLoading ||
                ruleDirty ||
                !editingRule?.draft_version_id ||
                !testSetName.trim() ||
                !testCasesText.trim()
              }
              onClick={() => void registerTestSet()}
            >
              登记当前草稿样例集
            </button>
            {sampleDirty && (
              <p className="finance-note">
                样例输入尚未登记。登记成功后再运行测试，发布依据以所选持久样例集为准。
              </p>
            )}
            {testSetNotice && (
              <p className="finance-note" aria-live="polite">
                {testSetNotice}
              </p>
            )}
          </details>
        </section>
      )}
      <div className="button-row">
        <button
          className="primary-button"
          disabled={
            busy ||
            !ruleName.trim() ||
            (ruleLevel === 'company' &&
              (!ruleSources.length ||
                (!editingRule && !ruleDepartments.length)))
          }
          onClick={() => void saveRule()}
        >
          {ruleLevel === 'company' ? '保存公司草稿' : '保存草稿'}
        </button>
        <button
          disabled={
            busy ||
            ruleDirty ||
            (ruleLevel === 'company' && sampleDirty) ||
            !editingRule?.draft_version_id ||
            (!!testTask && ['queued', 'running'].includes(testTask.status))
          }
          onClick={() => void testRule()}
        >
          {ruleLevel === 'company' && selectedTestSet !== 'boundary-v1'
            ? '运行所选样例测试'
            : '验证金额边界'}
        </button>
      </div>
      {ruleDirty && (
        <p className="finance-note">修改后请先保存草稿，再验证所选样例。</p>
      )}
      {testTask && (
        <p role="status" aria-live="polite">
          {testTask.status === 'queued'
            ? '样例测试已排队'
            : testTask.status === 'running'
              ? '正在验证所选样例'
              : testTask.status === 'completed'
                ? '样例验证完成'
                : testTask.status === 'stale'
                  ? '规则或映射已变化，请重新验证'
                  : '样例验证未完成，请重试'}{' '}
          · {testTask.completed_cases}/{testTask.total_cases}
        </p>
      )}
      {test && (
        <section className="finance-tests">
          <h3>
            {test.passed
              ? ruleLevel === 'company' && selectedTestSet !== 'boundary-v1'
                ? '专用样例通过'
                : '边界样例通过'
              : '样例尚未全部通过'}
          </h3>
          {test.results.map((r, i) => (
            <div key={i}>
              <p>
                <span>{r.name}</span>
                <strong>{truthLabel(r.truth)}</strong>
              </p>
              <details>
                <summary>查看本项解释轨迹</summary>
                <p>
                  期望：
                  {truthLabel(r.expected_truth)}
                </p>
                <p>检查字段：{r.field_refs.join('、') || '无'}</p>
                {r.unknown_reasons.length > 0 && (
                  <p>未知原因：{r.unknown_reasons.join('、')}</p>
                )}
                <pre className="finance-source-context">
                  {JSON.stringify(r.trace, null, 2)}
                </pre>
              </details>
            </div>
          ))}
          <button
            className="primary-button"
            disabled={
              busy ||
              ruleDirty ||
              sampleDirty ||
              testTask?.status !== 'completed' ||
              !test.passed ||
              (ruleLevel === 'company' &&
                !!editingRule?.active_version_id &&
                !ruleDiff)
            }
            onClick={() => void enableRule()}
          >
            {ruleLevel === 'company' ? '核对并发布公司规则' : '核对并启用'}
          </button>
        </section>
      )}
    </>
  );
  return (
    <>
      <SectionTitle
        title="制度与规则"
        description="先核对原文依据，再把审核要求保存为可验证规则。"
        actions={
          tab === 'policies' ? (
            me.actor.permissions.includes('knowledge.manage') && (
              <button onClick={() => setImporting(true)}>导入制度文本</button>
            )
          ) : tab === 'rules' ? (
            <div className="button-row">
              {canManageCompany && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => openRule(null, 'company')}
                >
                  创建公司规则
                </button>
              )}
              {me.actor.permissions.includes('rule.manage.personal') && (
                <button
                  disabled={busy}
                  className={canManageCompany ? undefined : 'primary-button'}
                  onClick={() => openRule(null)}
                >
                  创建个人提醒
                </button>
              )}
            </div>
          ) : undefined
        }
      />
      <div className="finance-tabs" role="tablist" aria-label="制度与规则">
        <button
          role="tab"
          aria-selected={tab === 'policies'}
          onClick={() => setTab('policies')}
        >
          制度来源
        </button>
        <button
          role="tab"
          aria-selected={tab === 'rules'}
          onClick={() => setTab('rules')}
        >
          审核规则
        </button>
        {canManageCompany && (
          <button
            role="tab"
            aria-selected={tab === 'mappings'}
            onClick={() => setTab('mappings')}
          >
            字段映射
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      <div role="status" aria-live="polite" className="finance-live">
        {notice}
        {loading && '正在读取当前授权内容…'}
      </div>
      {tab === 'policies' ? (
        <>
          <form
            className="finance-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Field label="查找制度条款">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如：住宿标准、票据核验"
                required
                maxLength={1000}
              />
            </Field>
            <Field label="适用业务日期">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </Field>
            <button className="primary-button" disabled={busy || !query.trim()}>
              {busy ? '正在检索…' : '查找原文'}
            </button>
          </form>
          {retrieval && (
            <section className="finance-retrieval">
              <h2>
                相关原文 <small>{retrieval.hits.length} 条</small>
              </h2>
              {retrieval.conflicts.map((c) => (
                <p className="finance-quality" key={c.topic_key}>
                  {c.message}
                </p>
              ))}
              {retrieval.hits.length ? (
                retrieval.hits.map((hit) => (
                  <article className="finance-source" key={hit.citation_id}>
                    <div>
                      <strong>{hit.heading_path.join(' / ')}</strong>
                      <span>
                        {hit.organization_label} · v{hit.policy_ref.version}
                      </span>
                    </div>
                    <blockquote>{hit.quote}</blockquote>
                    <footer>
                      <small>
                        {hit.effective_from} 起适用
                        {hit.effective_to
                          ? `，至 ${hit.effective_to}（不含）`
                          : ''}
                      </small>
                      <button
                        onClick={() => void openCitation(hit.citation_id)}
                      >
                        查看来源与上下文
                      </button>
                    </footer>
                  </article>
                ))
              ) : (
                <Empty>
                  没有找到当前日期与授权范围内的适用原文。请调整关键词或向制度负责人核实。
                </Empty>
              )}
            </section>
          )}
          <section className="finance-policy-list">
            <h2>可访问的制度</h2>
            {!loading && !policies.length ? (
              <Empty>暂无可访问的制度来源。</Empty>
            ) : (
              policies.map((policy) => (
                <article className="finance-policy" key={policy.id}>
                  <header>
                    <div>
                      <h3>{policy.title}</h3>
                      <small>{policy.policy_code}</small>
                    </div>
                    <span>{policy.versions.length} 个版本</span>
                  </header>
                  {policy.versions.map((v) => (
                    <div className="finance-version-row" key={v.id}>
                      <div>
                        <strong>版本 {v.version_no}</strong>
                        <small>
                          {v.effective_from} 起 ·{' '}
                          {v.organization_ids
                            .map((id) =>
                              id === me.department_id ? me.department_name : id,
                            )
                            .join('、')}
                        </small>
                      </div>
                      <Status value={v.publication_state} />
                      {!v.parse_complete && <span>原文解析中</span>}
                      {me.actor.permissions.includes('knowledge.manage') && (
                        <>
                          {v.publication_state === 'draft' &&
                            v.parse_complete && (
                              <button
                                disabled={busy}
                                onClick={() => void publish(policy, v)}
                              >
                                核对并发布
                              </button>
                            )}
                          {v.publication_state === 'published' && (
                            <button
                              disabled={busy}
                              onClick={() => void publish(policy, v, true)}
                            >
                              撤回版本
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </article>
              ))
            )}
          </section>
        </>
      ) : tab === 'rules' ? (
        <section className="finance-rule-list">
          <p className="finance-note">
            公司规则保留必查要求。个人规则只为本人提供提醒，不自动批准单据。
          </p>
          {!loading && !rules.length ? (
            <Empty>当前没有可见规则。可创建本人餐饮费用提醒。</Empty>
          ) : (
            rules.map((rule) => (
              <article className="finance-rule" key={rule.id}>
                <div>
                  <h3>{rule.name}</h3>
                  <p>
                    {rule.level === 'company' ? '公司必查' : '个人提醒'} ·{' '}
                    {rule.versions.length} 个内容版本
                  </p>
                  <small>
                    {
                      rule.versions.find(
                        (v) =>
                          v.id ===
                          (rule.active_version_id ?? rule.draft_version_id),
                      )?.explanation
                    }
                  </small>
                </div>
                <Status value={rule.lifecycle} />
                <button disabled={busy} onClick={() => void openRule(rule)}>
                  {(rule.level === 'personal' &&
                    rule.owner_id === me.actor.user_id) ||
                  (rule.level === 'company' && mayEditCompany(rule))
                    ? '查看与编辑'
                    : '查看依据'}
                </button>
                {mayDisableRule(rule) && (
                  <button
                    disabled={busy}
                    onClick={() => void disableRule(rule)}
                  >
                    {rule.level === 'company' ? '停用公司规则' : '停用个人提醒'}
                  </button>
                )}
              </article>
            ))
          )}
        </section>
      ) : (
        <MappingsWorkspace me={me} />
      )}
      {importing && (
        <Drawer
          title="导入制度文本"
          subtitle="支持 UTF-8 的 TXT / Markdown；发布前可核对原文和范围。"
          onClose={() => setImporting(false)}
          dirty={!!file || !!importTitle}
        >
          <ErrorNotice error={error} />
          <Field label="制度档案">
            <select
              value={existingPolicy}
              onChange={(e) => setExistingPolicy(e.target.value)}
            >
              <option value="">创建新制度</option>
              {policies.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.title} · 新增版本
                </option>
              ))}
            </select>
          </Field>
          {!existingPolicy && (
            <>
              <Field label="制度名称">
                <input
                  value={importTitle}
                  onChange={(e) => setImportTitle(e.target.value)}
                  maxLength={200}
                />
              </Field>
              <Field label="制度代码">
                <input
                  value={policyCode}
                  onChange={(e) => setPolicyCode(e.target.value)}
                  maxLength={100}
                />
              </Field>
              <fieldset className="finance-inline-choices">
                <legend>适用的已授权部门</legend>
                {manageableDepartments.map((id) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={selectedDepartments.includes(id)}
                      onChange={(e) =>
                        setSelectedDepartments((v) =>
                          e.target.checked
                            ? [...v, id]
                            : v.filter((x) => x !== id),
                        )
                      }
                    />
                    {id === me.department_id ? me.department_name : id}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          <Field label="生效日期">
            <input
              type="date"
              value={effective}
              onChange={(e) => setEffective(e.target.value)}
            />
          </Field>
          <Field label="原文文件">
            <input
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <button
            className="primary-button"
            disabled={
              busy ||
              !file ||
              (!existingPolicy &&
                (!importTitle || !policyCode || !selectedDepartments.length))
            }
            onClick={() => void importPolicy()}
          >
            {busy ? '正在保存原文…' : '保存并解析'}
          </button>
          {importTask && (
            <p role="status">
              导入状态：
              {importTask.stage === 'ready'
                ? '已解析，请到制度列表核对并发布'
                : importTask.stage === 'failed'
                  ? '解析失败，请检查文件后重试'
                  : '正在解析'}
            </p>
          )}
        </Drawer>
      )}
      {ruleOpen && (
        <Drawer
          title={ruleLevel === 'company' ? '公司审核规则' : '个人餐饮费用提醒'}
          subtitle={
            editingRule?.name ??
            (ruleLevel === 'company'
              ? '核对原文、验证必查条件，再由本人确认发布。'
              : '明确边界并通过样例验证后启用。')
          }
          onClose={() => {
            if (busy) return;
            openEpoch.current++;
            clearTest();
            setRuleOpen(false);
          }}
          dirty={ruleDirty || sampleDirty}
        >
          <ErrorNotice error={error} />
          <fieldset
            className="finance-rule-editor"
            aria-label="规则编辑内容"
            disabled={busy}
            aria-busy={busy}
          >
            {ruleLevel === 'company' ? (
              <>
                <p className="finance-note">
                  {companyEditor
                    ? '保存会新增公司草稿。已发布版本继续生效，完成真实边界验证后由本人确认发布。'
                    : '当前身份只读。修改和发布需要对应组织范围的公司规则管理授权。'}
                </p>
                {companyEditor && (
                  <>
                    <Field label="规则名称">
                      <input
                        value={ruleName}
                        maxLength={200}
                        onChange={(e) => {
                          setRuleName(e.target.value);
                          editRule();
                        }}
                      />
                    </Field>
                    <Field label="规则类别">
                      <select
                        value={ruleCategory}
                        onChange={(e) => {
                          setRuleCategory(e.target.value as RuleCategory);
                          editRule();
                        }}
                      >
                        {Object.entries(categoryLabels).map(
                          ([value, label]) => (
                            <option value={value} key={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </Field>
                    {editingRule ? (
                      <Field
                        label="检查条件（声明式 JSON）"
                        hint="保留原规则的适用日期、场景与组织。仅接受白名单声明式条件；不执行脚本或任意代码。金额边界测试支持单据总额或单类费用合计；复杂条件请在高级区登记人工专用样例集。"
                      >
                        <textarea
                          rows={20}
                          spellCheck={false}
                          value={companyDsl}
                          onChange={(e) => {
                            setCompanyDsl(e.target.value);
                            editRule();
                          }}
                        />
                      </Field>
                    ) : (
                      <>
                        <Field
                          label="单据总额不得超过（元）"
                          hint="等于上限通过；超过上限不通过；金额缺失保留未知。"
                        >
                          <input
                            inputMode="decimal"
                            value={threshold}
                            onChange={(e) => {
                              setThreshold(e.target.value);
                              editRule();
                            }}
                          />
                        </Field>
                        <fieldset className="finance-inline-choices">
                          <legend>适用的公司管理部门</legend>
                          {companyDepartments.map((id) => (
                            <label key={id}>
                              <input
                                type="checkbox"
                                checked={ruleDepartments.includes(id)}
                                onChange={(e) => {
                                  setRuleDepartments((values) =>
                                    e.target.checked
                                      ? [...values, id]
                                      : values.filter((value) => value !== id),
                                  );
                                  editRule();
                                }}
                              />
                              {departments.find(
                                (department) => department.id === id,
                              )?.name ?? id}
                            </label>
                          ))}
                        </fieldset>
                        <Field label="公司规则使用场景">
                          <select
                            value={purpose}
                            onChange={(e) => {
                              setPurpose(e.target.value);
                              editRule();
                            }}
                          >
                            <option value="employee_precheck">
                              员工提交前检查
                            </option>
                            <option value="manager_review">主管审核</option>
                            <option value="finance_review">财务审核</option>
                          </select>
                        </Field>
                        <p className="finance-note">
                          新建报销单总额必查规则，按提交日期自 2026-01-01
                          起适用。保存后可继续编辑完整声明式条件。
                        </p>
                      </>
                    )}
                    <section aria-label="公司规则制度依据">
                      <h3>制度依据</h3>
                      <Field
                        label="查找公司规则依据"
                        hint={`检索 ${date} 当日已授权的真实制度原文，选择精确条款后才能保存。`}
                      >
                        <input
                          value={sourceQuery}
                          maxLength={1000}
                          onChange={(e) => setSourceQuery(e.target.value)}
                        />
                      </Field>
                      <button
                        disabled={busy || !sourceQuery.trim()}
                        onClick={() => void searchRuleSources()}
                      >
                        {busy ? '正在检索…' : '检索可引用原文'}
                      </button>
                      {sourceRetrieval?.conflicts.map((conflict) => (
                        <p className="finance-quality" key={conflict.topic_key}>
                          {conflict.message}
                        </p>
                      ))}
                      {sourceRetrieval &&
                        (!sourceRetrieval.hits.length ? (
                          <Empty>
                            没有可引用原文，请调整关键词或核实制度适用日期。
                          </Empty>
                        ) : (
                          sourceRetrieval.hits.map((hit) => (
                            <article
                              className="finance-source"
                              key={hit.citation_id}
                            >
                              <label className="finance-check">
                                <input
                                  type="checkbox"
                                  checked={ruleSources.includes(
                                    hit.citation_id,
                                  )}
                                  onChange={(e) => {
                                    setRuleSources((ids) =>
                                      e.target.checked
                                        ? [...ids, hit.citation_id]
                                        : ids.filter(
                                            (id) => id !== hit.citation_id,
                                          ),
                                    );
                                    editRule();
                                  }}
                                />
                                选择此条原文：{hit.heading_path.join(' / ')} · v
                                {hit.policy_ref.version}
                              </label>
                              <blockquote>{hit.quote}</blockquote>
                              <small>
                                {hit.organization_label} · {hit.effective_from}{' '}
                                起 · 原文第 {hit.locator.start_line}–
                                {hit.locator.end_line} 行
                              </small>
                              <button
                                onClick={() =>
                                  void openCitation(hit.citation_id)
                                }
                              >
                                查看来源与上下文
                              </button>
                            </article>
                          ))
                        ))}
                      <p>已选原文依据：{ruleSources.length} 条</p>
                      {ruleSources.map((id, i) => (
                        <div className="button-row" key={id}>
                          <button onClick={() => void openCitation(id)}>
                            查看已选依据 {i + 1}
                          </button>
                          <button
                            onClick={() => {
                              setRuleSources((ids) =>
                                ids.filter((value) => value !== id),
                              );
                              editRule();
                            }}
                          >
                            移除依据 {i + 1}
                          </button>
                        </div>
                      ))}
                    </section>
                    <section aria-label="公司规则版本变化">
                      <h3>发布前版本核对</h3>
                      {!editingRule?.active_version_id ? (
                        <p>这是首个发布版本，没有旧发布版本可比较。</p>
                      ) : !editingRule.draft_version_id ? (
                        <p>当前只有已发布版本，保存修改后将对比新草稿。</p>
                      ) : (
                        <>
                          <ErrorNotice error={diffError} />
                          {diffError && (
                            <button
                              onClick={() =>
                                setDiffReload((value) => value + 1)
                              }
                            >
                              重新读取版本变化
                            </button>
                          )}
                          {ruleDiff ? (
                            <>
                              <p>{ruleDiff.message}</p>
                              <ul>
                                {ruleDiff.changes.map((change, i) => (
                                  <li key={`${change.path}:${i}`}>
                                    {change.explanation}
                                  </li>
                                ))}
                              </ul>
                              {ruleDiff.warnings.length > 0 && (
                                <>
                                  <h4>需要核对</h4>
                                  <ul>
                                    {ruleDiff.warnings.map((warning) => (
                                      <li key={warning}>{warning}</li>
                                    ))}
                                  </ul>
                                </>
                              )}
                            </>
                          ) : (
                            !diffError && (
                              <p>正在读取已发布版本与草稿的真实变化…</p>
                            )
                          )}
                        </>
                      )}
                      {ruleDirty && (
                        <p className="finance-note">
                          当前输入尚未保存；上方比较以持久草稿为准。保存后重新核对变化。
                        </p>
                      )}
                    </section>
                    {renderVerification()}
                  </>
                )}
                {editingRule && <h3>保留的内容版本</h3>}
                {editingRule?.versions.map((v) => (
                  <section className="finance-source" key={v.id}>
                    <h3>内容版本 {v.version_number}</h3>
                    <p>
                      {v.id === editingRule.active_version_id
                        ? '当前已发布版本'
                        : v.id === editingRule.draft_version_id
                          ? '当前草稿'
                          : '历史内容版本'}
                    </p>
                    <p>{v.explanation}</p>
                    <p>引用来源 {v.source_citation_ids.length} 项</p>
                    <details>
                      <summary>查看确定性检查结构</summary>
                      <pre className="finance-source-context">
                        {JSON.stringify(v.dsl_json, null, 2)}
                      </pre>
                    </details>
                    {v.source_citation_ids.map((id) => (
                      <button key={id} onClick={() => void openCitation(id)}>
                        查看制度依据
                      </button>
                    ))}
                  </section>
                ))}
              </>
            ) : (
              <>
                <Field label="规则名称">
                  <input
                    value={ruleName}
                    maxLength={200}
                    onChange={(e) => {
                      setRuleName(e.target.value);
                      setRuleDirty(true);
                      clearTest();
                    }}
                  />
                </Field>
                <Field
                  label="每张单据餐饮合计严格超过（元）"
                  hint="等于此金额不会提醒；缺少金额时保留未知。"
                >
                  <input
                    inputMode="decimal"
                    value={threshold}
                    onChange={(e) => {
                      setThreshold(e.target.value);
                      setRuleDirty(true);
                      clearTest();
                    }}
                  />
                </Field>
                <Field label="使用场景">
                  <select
                    value={purpose}
                    onChange={(e) => {
                      setPurpose(e.target.value);
                      setRuleDirty(true);
                      clearTest();
                    }}
                  >
                    <option value="employee_precheck">本人提交前检查</option>
                    {me.actor.roles.includes('manager') && (
                      <option value="manager_review">本人主管审核</option>
                    )}
                    {me.actor.roles.includes('finance') && (
                      <option value="finance_review">本人财务审核</option>
                    )}
                  </select>
                </Field>
                <p className="finance-note">
                  适用 {me.department_name}；仅个人提醒，不替代公司规则。
                </p>
                {renderVerification()}
              </>
            )}
          </fieldset>
        </Drawer>
      )}
      {citation && (
        <Drawer
          title="制度来源"
          subtitle={`${citation.heading_path.join(' / ')} · v${citation.policy_ref.version}`}
          onClose={() => setCitation(null)}
        >
          <p className="finance-note">
            {citation.organization_label} · {citation.effective_from} 起适用
          </p>
          <blockquote className="finance-citation-quote">
            {citation.quote}
          </blockquote>
          <h3>原文上下文</h3>
          <pre className="finance-source-context">{citation.context}</pre>
          <p>
            原文第 {citation.locator.start_line}–{citation.locator.end_line} 行
          </p>
          <a href={`/api/v1/files/${citation.locator.source_file_id}/content`}>
            查看授权原文件
          </a>
        </Drawer>
      )}
      {review && (
        <ConfirmationPanel
          initial={review}
          actorName={me.display_name}
          onClose={() => setReview(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}
