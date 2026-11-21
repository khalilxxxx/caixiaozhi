import snapshots from './review-snapshots.json';
import type {
  RuleFinding,
  RuleReview,
  WorkspaceRule,
} from '../agent-workspace/RulesSubmission';
import type { WorkReview } from '../agent-workspace/WorkRuleDetails';
import type { WorkDocument } from '../agent-workspace/work-document-model';
import { summarizeWorkReview } from '../agent-workspace/work-review-model';

export interface ApprovalCase {
  id: 'hotel' | 'mixed' | 'clear' | 'na' | 'reminder';
  label: string;
  doc: WorkDocument;
  result: WorkReview;
}

interface SavedCase extends Omit<ApprovalCase, 'result'> {
  checkedAt: string;
  status: RuleReview['status'];
  applicable: string[];
  passed: string[];
  inapplicable: string[];
  findings: (Omit<RuleFinding, 'rule'> & { ruleId: string })[];
  evaluations: NonNullable<RuleReview['evaluations']>;
}

// 预置单据使用已保存的审查快照。mixed 是预览专用合成单据，用四条既有确定性规则调用 business.evaluate 后生成。
// 非预置个人规则仅保留匿名编号和执行状态，不收录规则正文、证据与用户标识。
const saved = snapshots as {
  rules: Record<string, WorkspaceRule>;
  cases: SavedCase[];
};

function getRule(id: string): WorkspaceRule {
  const rule = saved.rules[id];
  if (!rule) throw new Error(`样板缺少规则记录 ${id}`);
  return rule;
}

export const cases: ApprovalCase[] = saved.cases.map((item) => {
  const review: RuleReview = {
    status: item.status,
    applicable: item.applicable.map(getRule),
    passed: item.passed.map(getRule),
    inapplicable: item.inapplicable.map(getRule),
    findings: item.findings.map(({ ruleId, ...finding }) => ({
      ...finding,
      rule: getRule(ruleId),
    })),
    evaluations: item.evaluations,
  };
  return {
    id: item.id,
    label: item.label,
    doc: item.doc,
    result: summarizeWorkReview(item.doc, {
      checked: true,
      stale: false,
      checkedAt: item.checkedAt,
      review,
    }),
  };
});
