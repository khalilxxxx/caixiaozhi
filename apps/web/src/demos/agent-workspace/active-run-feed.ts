import type { ToolStep } from './run-progress-model';

type ActionKind =
  | 'reading'
  | 'searching'
  | 'calculating'
  | 'writing'
  | 'checking'
  | 'working'
  | 'waiting';
const tools: Record<string, readonly [ActionKind, string]> = {
  ask_user: ['waiting', '确认办理信息'],
  query_documents: ['searching', '查询单据'],
  analyze_expenses: ['calculating', '分析费用'],
  create_expense_report: ['writing', '生成费用报告'],
  query_business_board: ['calculating', '查询业务看板'],
  create_analysis_report: ['writing', '生成可视化报告'],
  read_business_report: ['reading', '读取分析报告'],
  query_public_financials: ['searching', '查询公开财报'],
  create_public_financial_report: ['writing', '生成公开财报报告'],
  read_public_financial_report: ['reading', '读取公开财报报告'],
  search_policies: ['searching', '查询制度'],
  get_submission_draft: ['reading', '读取单据草稿'],
  update_submission_draft: ['writing', '更新单据草稿'],
  new_submission_draft: ['writing', '创建单据草稿'],
  validate_submission: ['checking', '检查单据'],
  list_reimbursable_travel_applications: ['searching', '查询可报销差旅申请'],
  link_travel_application: ['writing', '关联差旅申请'],
  preaudit_documents: ['checking', '预审单据'],
  list_materials: ['reading', '查看材料'],
  read_uploaded_file: ['reading', '读取文件'],
  extract_expense_materials: ['reading', '提取费用材料'],
  summarize_expense_csv: ['calculating', '汇总费用'],
  read_expense_summary: ['reading', '读取费用汇总'],
  get_submission_receipt: ['searching', '查询办理回执'],
  read_current_rules: ['reading', '读取规则'],
  prepare_personal_rule: ['writing', '整理个人规则'],
  list_available_skills: ['searching', '查找可用技能'],
  get_skill_instructions: ['reading', '读取技能说明'],
  list_skill_files: ['searching', '查找技能文件'],
  read_skill_file: ['reading', '读取技能文件'],
  write_skill_file: ['writing', '写入技能文件'],
  run_skill_command: ['working', '执行技能'],
  run_skill_script: ['working', '执行技能脚本'],
  validate_skill_artifact: ['checking', '核对技能成果'],
  publish_skill_artifact: ['writing', '交付成果'],
};

export function toolInfo(name: string) {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}

export function stepLabel(step: ToolStep) {
  return step.label?.trim() || toolInfo(step.name)?.[1] || '处理任务';
}

export const longRunMs = 8_000;

// Introduce the scope only once the corresponding tool has actually started.
const scopeByTool: Readonly<Record<string, string>> = {
  query_documents: '我先查找与这次办理相关的单据。',
  read_work_document: '我先查看所选单据及已有的审核结果。',
  get_submission_draft: '我先看看这份草稿已经填了哪些内容。',
  list_reimbursable_travel_applications: '我先查找可以关联的差旅申请。',
  search_policies: '我先查找与这次咨询相关的制度条款。',
  analyze_expenses: '我先按本次查询范围核对费用数据。',
  summarize_expense_csv: '我先汇总费用表里的明细。',
  read_expense_summary: '我先查看已有的费用汇总，核对记录数和合计金额。',
  validate_submission: '我先检查这份草稿的办理条件。',
  preaudit_documents: '我先核对所选单据的审核规则。',
  read_current_rules: '我先查看当前可用的规则。',
  get_submission_receipt: '我先查看这份申请的办理回执。',
  query_public_financials: '我先查找本次分析涉及的公开财报数据。',
  list_materials: '我先查看这次办理引用的材料。',
  read_uploaded_file: '我先核对你提供的文件内容。',
  extract_expense_materials: '我先从费用材料中核对票据信息。',
};

// Loading a skill is incidental to an otherwise short, single-action answer.
const skillPreparation = new Set([
  'list_available_skills',
  'get_skill_instructions',
  'list_skill_files',
  'read_skill_file',
]);

export function hasMultipleBusinessActions(steps: ToolStep[]) {
  const actions = steps.filter((step) => !skillPreparation.has(step.name));
  return new Set(actions.map((step) => step.name)).size > 1;
}

export function openingScope(steps: ToolStep[]) {
  const first = steps.find((step) => !skillPreparation.has(step.name));
  return first && Object.hasOwn(scopeByTool, first.name)
    ? scopeByTool[first.name]
    : undefined;
}

export function runState(
  status: string | undefined,
  running: boolean,
  steps: ToolStep[],
  phase?: string,
) {
  if (
    phase === 'awaiting_input' ||
    ['awaiting_input', 'waiting', '待你回答'].includes(status ?? '')
  )
    return 'waiting';
  if (running) return 'running';
  if (['paused', '已暂停'].includes(status ?? '')) return 'paused';
  if (['cancelled', 'canceled', '已停止'].includes(status ?? ''))
    return 'cancelled';
  if (
    ['failed', 'interrupted', 'incomplete', '未完成', '处理失败'].includes(
      status ?? '',
    )
  )
    return 'failed';
  if (['completed', 'succeeded'].includes(status ?? '')) return 'completed';
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.some((step) => step.status === 'cancelled')) return 'cancelled';
  return steps.some((step) => step.status === 'running')
    ? 'incomplete'
    : 'history';
}

export const stateLabels = {
  failed: '办理未完成',
  incomplete: '办理未完成',
  cancelled: '已停止办理',
  paused: '办理已暂停',
  waiting: '待你回答',
};

export function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function elapsedLabel(ms: number) {
  if (ms < 1000) return '用时不足 1 秒';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `用时 ${seconds} 秒`;
  return `用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function actionText(step: ToolStep) {
  const label = stepLabel(step);
  return label.startsWith('正在') ? label : `正在${label}`;
}

interface FeedItem {
  key: string;
  name: string;
  label: string;
  status: string;
  source: string;
  findings: string[];
  count: number;
}

function publicFindings(step: ToolStep) {
  const findings: string[] = [];
  if (step.status !== 'completed') return findings;
  if (step.finding) findings.push(step.finding);
  const itinerary = step.itinerary;
  const parts: string[] = [];
  if (itinerary?.destination && !step.finding?.includes(itinerary.destination))
    parts.push(`去程目的地为${itinerary.destination}`);
  if (itinerary?.transport && !step.finding?.includes(itinerary.transport))
    parts.push(`交通方式为${itinerary.transport}`);
  if (parts.length) findings.push(parts.join('，') + '。');
  return findings;
}

export function stepSource(step: ToolStep) {
  return [step.expertSkill, step.expertConnector].filter(Boolean).join(' · ');
}

export function feedItems(steps: ToolStep[], running: boolean) {
  const items: FeedItem[] = [];
  for (const [index, step] of steps.entries()) {
    // The live line already owns the current action. A stale, unfinished step
    // in a terminal snapshot must never look like a success.
    if (running && step.status === 'running') continue;
    const status = step.status === 'running' ? 'incomplete' : step.status;
    const label = stepLabel(step);
    const source = stepSource(step);
    const findings = publicFindings(step);
    const previous = items.at(-1);
    const kind = toolInfo(step.name)?.[0];
    if (
      status === 'completed' &&
      (kind === 'reading' || kind === 'searching') &&
      previous?.status === 'completed' &&
      previous.name === step.name &&
      previous.label === label &&
      previous.source === source &&
      previous.findings.length === findings.length &&
      findings.every((fact, i) => previous.findings[i] === fact)
    ) {
      previous.count++;
    } else {
      items.push({
        key: step.id || String(index),
        name: step.name,
        label,
        status,
        source,
        findings,
        count: 1,
      });
    }
  }
  return items;
}

export function itemTitle(item: FeedItem) {
  const label = item.label.replace(/^正在/, '');
  if (item.status === 'failed') return `${label}未成功`;
  if (item.status === 'cancelled') return `${label}已停止`;
  if (item.status !== 'completed') return `${label}未完成`;
  if (item.name === 'ask_user') return '已提出确认问题';
  const text = label.startsWith('已') ? label : `已${label}`;
  return item.count > 1 ? `${text}（${item.count} 次）` : text;
}
