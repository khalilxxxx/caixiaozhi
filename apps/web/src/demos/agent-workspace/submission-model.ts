export type DraftId = 'travel' | 'expense' | 'personal';
export type ExpenseTemplate =
  'T01' | 'T02' | 'T03' | 'T04' | 'T05' | 'T06' | 'T07' | 'T08' | 'T09' | 'T10';
export type ActivityMode = 'required' | 'optional' | 'hidden';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface TravelLeg {
  id: string;
  departureCity: string;
  arrivalCity: string;
  departureDate: string;
  arrivalDate: string;
  transport: string;
}

export interface ActivityAssignment {
  id: string;
  oaNumber: string;
  activityNumber: string;
  description: string;
  effectiveDate: string;
  expiryDate: string;
  allocation: string;
  oaUrl: string;
  source?: 'manual' | 'sample';
}

export interface ExpenseItem {
  id: string;
  categoryId: string;
  name: string;
  currency: string;
  amount: string;
  reason: string;
  reasonOption: string;
  date: string;
  tripId: string;
  departureDate: string;
  arrivalDate: string;
  departureCity: string;
  arrivalCity: string;
  transport: string;
  checkIn: string;
  checkOut: string;
  city: string;
  rooms: string;
  nights: string;
  rental: string;
  coResidents: string;
  people: string;
  quantity: string;
  standard: string;
  oaId: string;
  files: Attachment[];
  attachments: Attachment[];
  generated: boolean;
  aiCheckOut?: string | null;
  sourceFileId?: string;
  group?: 'travel' | 'daily';
  sourceBatchId?: string;
  sourceSnapshot?: string;
}

export type ExpenseField =
  | 'currency'
  | 'amount'
  | 'reason'
  | 'date'
  | 'tripId'
  | 'departureDate'
  | 'arrivalDate'
  | 'departureCity'
  | 'arrivalCity'
  | 'transport'
  | 'checkIn'
  | 'checkOut'
  | 'city'
  | 'rooms'
  | 'nights'
  | 'rental'
  | 'coResidents'
  | 'people'
  | 'quantity'
  | 'standard'
  | 'oaId';

export interface ExpenseCategory {
  id: string;
  label: string;
  group: '长途交通' | '市内交通' | '住宿' | '业务招待' | '其他';
  otherGroup?: string;
  template: ExpenseTemplate;
  requiredFields: ExpenseField[];
  draftTypes: Array<'expense' | 'personal'>;
}

export interface SubmissionDraft {
  id: DraftId;
  title: string;
  applicant: string;
  department: string;
  paymentCompany: string;
  travelType: string;
  purpose: string;
  legs: TravelLeg[];
  activities: ActivityAssignment[];
  activityMode: ActivityMode;
  companions: string[];
  applicationId: string;
  expenses: ExpenseItem[];
  files: Attachment[];
  subsidyCents: number | null;
  materialIds: string[];
  version: number;
  savedAt: string | null;
  status: 'draft' | 'awaiting_receipt';
  sourceImportKey?: string;
  invoiceUnique?: boolean;
  validInvoice?: boolean | null;
  legacyPeriod?: { start: string; end: string };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface MaterialExpenseImport {
  id?: string;
  revision: number;
  materialBatchId?: string;
  title?: string;
  materialIds?: string[];
  files?: Attachment[];
  items: Array<{
    id: string;
    name: string;
    category: string;
    categoryId?: string;
    amount: number;
    date: string;
    end?: string;
    start?: string;
    purpose?: string;
    oaId?: string;
    group?: 'travel' | 'daily';
    sourceFileId: string;
    nights?: number;
    tripId?: string;
    departureDate?: string;
    arrivalDate?: string;
    departureCity?: string;
    arrivalCity?: string;
    transport?: string;
    checkIn?: string;
    checkOut?: string;
    city?: string;
    excluded?: boolean;
    aiCheckOut?: string | null;
  }>;
}

const commonRequired: ExpenseField[] = ['currency', 'amount', 'reason'];
const templateRequired: Record<ExpenseTemplate, ExpenseField[]> = {
  T01: ['tripId'],
  T02: ['date', 'transport'],
  T03: ['checkIn', 'checkOut', 'city', 'rooms'],
  T04: ['date', 'standard', 'city', 'rooms', 'nights'],
  T05: ['date', 'standard', 'people'],
  T06: ['date', 'people'],
  T07: ['date', 'people', 'quantity'],
  T08: [
    'departureDate',
    'arrivalDate',
    'departureCity',
    'arrivalCity',
    'transport',
  ],
  T09: ['checkIn', 'checkOut', 'city'],
  T10: ['date'],
};

function category(
  id: string,
  label: string,
  group: ExpenseCategory['group'],
  template: ExpenseTemplate,
  draftTypes: ExpenseCategory['draftTypes'] = ['expense', 'personal'],
  otherGroup?: string,
): ExpenseCategory {
  return {
    id,
    label,
    group,
    template,
    draftTypes,
    otherGroup,
    requiredFields: [
      ...commonRequired,
      ...templateRequired[template],
      ...(id === 'reception-meal-oa' ? ['oaId' as const] : []),
    ],
  };
}

const otherDefinitions: Array<
  [string, string, string, Array<'expense' | 'personal'>, ExpenseTemplate?]
> = [
  ['parking', '停车过路费', '车辆杂费', ['expense', 'personal']],
  ['fuel', '汽油费', '车辆杂费', ['expense', 'personal']],
  ['charging', '车辆充电费', '车辆杂费', ['expense', 'personal']],
  ['rental-car', '车辆租赁费', '车辆杂费', ['expense', 'personal']],
  ['car-inspection', '车辆年检费', '车辆杂费', ['personal']],
  ['express', '快递费', '办公费', ['expense', 'personal']],
  ['office', '办公费零星采购', '办公费', ['expense', 'personal']],
  ['printing', '印刷费', '办公费', ['personal']],
  ['tender', '招投标费', '办公费', ['personal']],
  ['books', '书报资料费', '办公费', ['personal']],
  ['visa', '签证办证费', '办公费', ['expense', 'personal']],
  ['water', '饮用水', '办公费', ['personal']],
  ['notary', '公证费', '办公费', ['personal']],
  ['household', '户档费', '办公费', ['personal']],
  ['conference', '参会费', '办公费', ['expense', 'personal']],
  ['network', '网络服务费', '咨询与服务', ['expense', 'personal']],
  ['telecom', '员工通讯费', '咨询与服务', ['expense', 'personal']],
  ['certification', '一般认证费', '咨询与服务', ['personal']],
  ['platform', '电商平台服务费', '咨询与服务', ['personal']],
  ['consulting', '咨询费', '咨询与服务', ['personal']],
  ['health', '防疫检测费', '体检费用', ['expense', 'personal']],
  ['utilities-water', '水费', '水电燃气费', ['personal']],
  ['electricity', '电费', '水电燃气费', ['personal']],
  ['gas', '燃气费', '水电燃气费', ['personal']],
  ['recruiting', '招聘费', '人员招聘', ['personal']],
  ['travel-subsidy', 'AMR差旅补贴', '差旅补助', ['expense']],
  ['living-subsidy', '生活补贴', '其他', ['personal']],
  ['finance', '金融机构手续费', '其他', ['personal']],
  ['long-distance', '长途交通', '其他', ['expense', 'personal'], 'T08'],
  ['travel-misc', '长途交通杂费', '其他', ['expense']],
  ['hotel', '住宿费', '其他', ['personal'], 'T09'],
];

export const expenseCategories: ExpenseCategory[] = [
  category('long-distance', '长途交通费', '长途交通', 'T01', ['expense']),
  category('taxi', '出租车', '市内交通', 'T02'),
  category('metro', '地铁', '市内交通', 'T02'),
  category('bus', '公交车', '市内交通', 'T02'),
  category('hotel', '住宿费', '住宿', 'T03', ['expense']),
  category('reception-hotel', '住宿费', '业务招待', 'T04'),
  category('reception-meal-oa', '餐饮费-OA', '业务招待', 'T05'),
  category('reception-meal', '餐饮费-非OA', '业务招待', 'T05'),
  category('reception-ticket', '门票／入场费', '业务招待', 'T06'),
  category('reception-gift', '纪念品', '业务招待', 'T07'),
  ...otherDefinitions.map(([id, label, otherGroup, draftTypes, template]) =>
    category(
      `other-${id}`,
      label,
      '其他',
      template ?? 'T10',
      draftTypes,
      otherGroup,
    ),
  ),
];

export function getExpenseCategory(id: string): ExpenseCategory | undefined {
  return expenseCategories.find((item) => item.id === id);
}

export function getExpenseCategories(draftId: DraftId): ExpenseCategory[] {
  if (draftId === 'travel') return [];
  return expenseCategories.filter((item) => item.draftTypes.includes(draftId));
}

export function createBlankExpense(categoryId = ''): ExpenseItem {
  return {
    id: crypto.randomUUID(),
    categoryId,
    name: '',
    currency: 'CNY',
    amount: '',
    reason: '',
    reasonOption: '',
    date: '',
    tripId: '',
    departureDate: '',
    arrivalDate: '',
    departureCity: '',
    arrivalCity: '',
    transport: '',
    checkIn: '',
    checkOut: '',
    city: '',
    rooms: '',
    nights: '',
    rental: getExpenseCategory(categoryId)?.template === 'T03' ? '否' : '',
    coResidents: '',
    people: '',
    quantity: '',
    standard: '',
    oaId: '',
    files: [],
    attachments: [],
    generated: false,
  };
}

export function createInitialDrafts(): Record<DraftId, SubmissionDraft> {
  const makeDraft = (id: DraftId, title: string): SubmissionDraft => ({
    id,
    title,
    applicant: '',
    department: '',
    paymentCompany: '',
    travelType: '',
    purpose: '',
    legs: [],
    activities: [],
    activityMode: 'optional',
    companions: [],
    applicationId: '',
    expenses: [],
    files: [],
    subsidyCents: null,
    materialIds: [],
    version: 1,
    savedAt: null,
    status: 'draft',
  });
  return {
    travel: makeDraft('travel', '差旅申请'),
    expense: makeDraft('expense', '差旅报销'),
    personal: makeDraft('personal', '个人费用报销'),
  };
}

const lodgingTemplates: ExpenseTemplate[] = ['T03', 'T09'];
const templateFields: Record<ExpenseTemplate, ExpenseField[]> = {
  T01: [
    'tripId',
    'departureDate',
    'arrivalDate',
    'departureCity',
    'arrivalCity',
    'transport',
  ],
  T02: ['date', 'transport'],
  T03: [
    'checkIn',
    'checkOut',
    'city',
    'rooms',
    'nights',
    'rental',
    'coResidents',
  ],
  T04: ['date', 'standard', 'city', 'rooms', 'nights'],
  T05: ['date', 'standard', 'people', 'oaId'],
  T06: ['date', 'people'],
  T07: ['date', 'people', 'quantity'],
  T08: [
    'departureDate',
    'arrivalDate',
    'departureCity',
    'arrivalCity',
    'transport',
  ],
  T09: ['checkIn', 'checkOut', 'city', 'rooms', 'nights', 'coResidents'],
  T10: ['date'],
};

function expenseFields(categoryId: string): Set<ExpenseField> {
  const definition = getExpenseCategory(categoryId);
  const fields = definition
    ? templateFields[definition.template]
    : ['date' as const];
  return new Set([
    ...commonRequired,
    ...fields.filter(
      (field) => field !== 'oaId' || categoryId === 'reception-meal-oa',
    ),
  ]);
}

function dateFields(
  template: ExpenseTemplate | undefined,
): [keyof ExpenseItem, keyof ExpenseItem] {
  if (template && lodgingTemplates.includes(template))
    return ['checkIn', 'checkOut'];
  if (template === 'T01' || template === 'T08')
    return ['departureDate', 'arrivalDate'];
  return ['date', 'date'];
}

export function switchExpenseCategory(
  expense: ExpenseItem,
  categoryId: string,
): ExpenseItem {
  const previousFields = expenseFields(expense.categoryId);
  const nextFields = expenseFields(categoryId);
  const updated = { ...expense, categoryId };
  for (const field of Object.keys(fieldLabels) as ExpenseField[]) {
    updated[field] =
      previousFields.has(field) && nextFields.has(field) ? expense[field] : '';
  }
  if (
    !previousFields.has('checkIn') &&
    previousFields.has('date') &&
    nextFields.has('checkIn')
  )
    updated.checkIn = expense.date;
  if (
    !previousFields.has('date') &&
    previousFields.has('checkIn') &&
    nextFields.has('date')
  )
    updated.date = expense.checkIn;
  if (!nextFields.has('checkOut')) delete updated.aiCheckOut;
  return updated;
}

export function amountCents(amount: string): number | null {
  const match = amount.trim().match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return null;
  const value =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(value) && value <= 10000000000 ? value : null;
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

export function expenseNights(expense: ExpenseItem): number {
  if (!validDate(expense.checkIn) || !validDate(expense.checkOut)) return 0;
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${expense.checkOut}T00:00:00Z`) -
        Date.parse(`${expense.checkIn}T00:00:00Z`)) /
        86400000,
    ),
  );
}

export function draftCurrencyTotals(
  draft: SubmissionDraft,
): Array<{ currency: string; amountCents: number }> {
  const totals = new Map<string, number>();
  for (const expense of draft.expenses) {
    const amount = amountCents(expense.amount);
    if (expense.currency && amount !== null)
      totals.set(
        expense.currency,
        (totals.get(expense.currency) ?? 0) + amount,
      );
  }
  if (draft.subsidyCents !== null)
    totals.set('CNY', (totals.get('CNY') ?? 0) + draft.subsidyCents);
  return [...totals].map(([currency, amountCents]) => ({
    currency,
    amountCents,
  }));
}

export function draftTotal(draft: SubmissionDraft): number {
  return (
    draftCurrencyTotals(draft).find((item) => item.currency === 'CNY')
      ?.amountCents ?? 0
  );
}

export function draftPeriod(draft: SubmissionDraft): {
  start: string;
  end: string;
} {
  const dates =
    draft.id === 'personal'
      ? []
      : draft.legs.flatMap((item) => [item.departureDate, item.arrivalDate]);
  if (draft.id !== 'personal' && !dates.some(validDate) && draft.legacyPeriod)
    dates.push(draft.legacyPeriod.start, draft.legacyPeriod.end);
  for (const expense of draft.expenses) {
    const definition = getExpenseCategory(expense.categoryId);
    const [start, end] = dateFields(definition?.template);
    dates.push(String(expense[start]), String(expense[end]));
    if (!definition)
      dates.push(
        expense.departureDate,
        expense.arrivalDate,
        expense.checkIn,
        expense.checkOut,
      );
  }
  const sorted = dates.filter(validDate).sort();
  return { start: sorted[0] ?? '', end: sorted.at(-1) ?? '' };
}

const fieldLabels: Record<ExpenseField, string> = {
  currency: '币种',
  amount: '金额',
  reason: '事由',
  date: '日期',
  tripId: '行程',
  departureDate: '出发日期',
  arrivalDate: '到达日期',
  departureCity: '出发城市',
  arrivalCity: '到达城市',
  transport: '交通工具',
  checkIn: '入住日期',
  checkOut: '退房日期',
  city: '城市',
  rooms: '房间数',
  nights: '天数',
  rental: '是否租房',
  coResidents: '合住人',
  people: '人数',
  quantity: '采购数量',
  standard: '接待标准',
  oaId: 'OA单号',
};

function validateLegs(
  draft: SubmissionDraft,
  submit: boolean,
  issues: ValidationIssue[],
): void {
  if (draft.id === 'personal') return;
  const legs = draft.legs;
  if (submit && !legs.length)
    issues.push({ path: 'legs', message: '请补全差旅行程。' });
  legs.forEach((item, index) => {
    const path = `legs.${index}`;
    const fields: Array<keyof Omit<TravelLeg, 'id'>> = [
      'departureCity',
      'arrivalCity',
      'departureDate',
      'arrivalDate',
      'transport',
    ];
    for (const field of fields) {
      if (submit && !item[field].trim())
        issues.push({
          path: `${path}.${field}`,
          message: `请填写${fieldLabels[field]}。`,
        });
    }
    for (const field of ['departureDate', 'arrivalDate'] as const) {
      if (item[field] && !validDate(item[field]))
        issues.push({ path: `${path}.${field}`, message: '日期格式无效。' });
    }
    if (
      item.departureCity &&
      item.arrivalCity &&
      item.departureCity.trim() === item.arrivalCity.trim()
    )
      issues.push({
        path: `${path}.arrivalCity`,
        message: '出发城市和到达城市不能相同。',
      });
    if (
      validDate(item.departureDate) &&
      validDate(item.arrivalDate) &&
      item.arrivalDate < item.departureDate
    )
      issues.push({
        path: `${path}.arrivalDate`,
        message: '到达日期不能早于出发日期。',
      });
    const previous = legs[index - 1];
    if (
      previous?.arrivalCity &&
      item.departureCity &&
      previous.arrivalCity.trim() !== item.departureCity.trim()
    )
      issues.push({
        path: `${path}.departureCity`,
        message: '出发城市应衔接上一段到达城市。',
      });
    if (
      previous &&
      validDate(previous.arrivalDate) &&
      validDate(item.departureDate) &&
      item.departureDate < previous.arrivalDate
    )
      issues.push({
        path: `${path}.departureDate`,
        message: '出发日期不能早于上一段到达日期。',
      });
  });
  if (!submit || !legs.length) return;
  const firstCity = legs[0]!.departureCity.trim();
  const finalCity = legs.at(-1)!.arrivalCity.trim();
  if (firstCity && finalCity && firstCity !== finalCity)
    issues.push({ path: 'legs', message: '全部行程须返回最初出发城市。' });
  if (
    firstCity &&
    legs.slice(0, -1).some((item) => item.arrivalCity.trim() === firstCity)
  )
    issues.push({
      path: 'legs',
      message: '不能中途返回最初出发城市后再次出发。',
    });
}

function validateActivities(
  draft: SubmissionDraft,
  submit: boolean,
  issues: ValidationIssue[],
): void {
  if (draft.activityMode === 'hidden') return;
  if (submit && draft.activityMode === 'required' && !draft.activities.length)
    issues.push({ path: 'activities', message: '请关联活动或派工。' });
  const period = draft.id === 'personal'
    ? { start: '', end: '' }
    : draftPeriod({ ...draft, expenses: [] });
  draft.activities.forEach((activity, index) => {
    for (const field of ['effectiveDate', 'expiryDate'] as const) {
      if (
        (submit && !activity[field]) ||
        (activity[field] && !validDate(activity[field]))
      )
        issues.push({
          path: `activities.${index}.${field}`,
          message: '请补全有效的活动日期。',
        });
    }
    if (!validDate(activity.effectiveDate) || !validDate(activity.expiryDate))
      return;
    if (activity.expiryDate < activity.effectiveDate)
      issues.push({
        path: `activities.${index}.expiryDate`,
        message: '活动截止日期不能早于生效日期。',
      });
    if (
      submit &&
      period.start &&
      period.end &&
      (activity.expiryDate < period.start ||
        activity.effectiveDate > period.end)
    )
      issues.push({
        path: `activities.${index}.effectiveDate`,
        message: '活动日期须与差旅日期有交集。',
      });
  });
}

function validateExpense(
  expense: ExpenseItem,
  index: number,
  draft: SubmissionDraft,
  submit: boolean,
  issues: ValidationIssue[],
): void {
  const path = `expenses.${index}`;
  const definition = getExpenseCategory(expense.categoryId);
  if (
    submit &&
    (!definition ||
      draft.id === 'travel' ||
      !definition.draftTypes.includes(draft.id))
  ) {
    issues.push({
      path: `${path}.categoryId`,
      message: '请选择当前单据可用的费用类型。',
    });
  }
  if (submit && definition) {
    for (const field of definition.requiredFields) {
      if (!expense[field].trim())
        issues.push({
          path: `${path}.${field}`,
          message: `请填写${fieldLabels[field]}。`,
        });
    }
  }
  if (expense.amount && amountCents(expense.amount) === null)
    issues.push({
      path: `${path}.amount`,
      message: '金额须为非负数，最多两位小数。',
    });
  if (!definition) return;
  const [startKey, endKey] = dateFields(definition.template);
  for (const field of [...new Set([startKey, endKey])]) {
    const value = String(expense[field]);
    if (value && !validDate(value))
      issues.push({ path: `${path}.${field}`, message: '日期格式无效。' });
  }
  const start = String(expense[startKey]);
  const end = String(expense[endKey]);
  const lodging = lodgingTemplates.includes(definition.template);
  if (
    startKey !== endKey &&
    validDate(start) &&
    validDate(end) &&
    (lodging ? end <= start : end < start)
  )
    issues.push({
      path: `${path}.${endKey}`,
      message: lodging
        ? '退房日期须晚于入住日期。'
        : '到达日期不能早于出发日期。',
    });
  for (const field of ['rooms', 'nights', 'people', 'quantity'] as const) {
    if (
      expenseFields(expense.categoryId).has(field) &&
      expense[field] &&
      (!/^\d+$/.test(expense[field]) || Number(expense[field]) <= 0)
    )
      issues.push({
        path: `${path}.${field}`,
        message: `${fieldLabels[field]}须为正整数。`,
      });
  }
  if (
    submit &&
    definition.template === 'T01' &&
    expense.tripId &&
    !draft.legs.some((item) => item.id === expense.tripId)
  )
    issues.push({
      path: `${path}.tripId`,
      message: '关联行程已不存在，请重新选择。',
    });
}

export function validateDraft(
  draft: SubmissionDraft,
  options: { submit: boolean },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { submit } = options;
  if (submit) {
    for (const [field, label] of [
      ['title', '单据标题'],
      ['applicant', '申请人'],
      ['department', '部门'],
      ['paymentCompany', '付款公司'],
      ['purpose', '事由'],
    ] as const) {
      if (!draft[field].trim())
        issues.push({ path: field, message: `请填写${label}。` });
    }
    if (draft.id === 'travel' && !draft.travelType.trim())
      issues.push({ path: 'travelType', message: '请选择差旅类型。' });
    if (draft.id === 'expense' && !draft.applicationId.trim())
      issues.push({ path: 'applicationId', message: '请关联差旅申请。' });
    if (draft.id !== 'travel' && !draft.expenses.length)
      issues.push({ path: 'expenses', message: '请添加费用明细。' });
  }
  validateLegs(draft, submit, issues);
  validateActivities(draft, submit, issues);
  if (draft.id !== 'travel')
    draft.expenses.forEach((expense, index) =>
      validateExpense(expense, index, draft, submit, issues),
    );
  return issues;
}

function importCategory(
  item: MaterialExpenseImport['items'][number],
  draftId: 'expense' | 'personal',
): string {
  if (
    item.categoryId &&
    getExpenseCategories(draftId).some(
      (definition) => definition.id === item.categoryId,
    )
  )
    return item.categoryId;
  if (item.category === '住宿')
    return draftId === 'expense' ? 'hotel' : 'other-hotel';
  if (item.category === '餐饮')
    return item.oaId ? 'reception-meal-oa' : 'reception-meal';
  if (item.category === '办公') return 'other-office';
  const exact = getExpenseCategories(draftId).find(
    (definition) =>
      definition.label === item.category ||
      `${definition.group}/${definition.label}` === item.category,
  );
  return exact?.id ?? '';
}

function importedExpense(
  item: MaterialExpenseImport['items'][number],
  incoming: MaterialExpenseImport,
  batchId: string,
): ExpenseItem {
  const draftId = item.group === 'daily' ? 'personal' : 'expense';
  const expense = createBlankExpense(importCategory(item, draftId));
  const template = getExpenseCategory(expense.categoryId)?.template;
  const lodging = template && lodgingTemplates.includes(template);
  return {
    ...expense,
    id: item.id,
    name: item.name,
    amount:
      Number.isSafeInteger(item.amount) && item.amount >= 0
        ? (item.amount / 100).toFixed(2)
        : '',
    reason: item.purpose ?? '',
    reasonOption: item.purpose ? '其他' : '',
    date: lodging ? '' : item.date,
    checkIn: item.checkIn ?? (lodging ? (item.start ?? item.date) : ''),
    checkOut: item.checkOut ?? (lodging ? (item.end ?? '') : ''),
    departureDate:
      item.departureDate ??
      (template === 'T08'
        ? (item.start ?? item.date)
        : item.category === '交通'
          ? (item.start ?? '')
          : ''),
    arrivalDate:
      item.arrivalDate ??
      (template === 'T08' || item.category === '交通' ? (item.end ?? '') : ''),
    departureCity: item.departureCity ?? '',
    arrivalCity: item.arrivalCity ?? '',
    city: item.city ?? '',
    transport: item.transport ?? '',
    tripId: item.tripId ?? '',
    oaId: item.oaId ?? '',
    nights: item.nights === undefined ? '' : String(item.nights),
    sourceFileId: item.sourceFileId,
    group: item.group ?? 'travel',
    sourceBatchId: batchId,
    files: (incoming.files ?? []).filter(
      (file) => file.id === item.sourceFileId,
    ),
    generated: true,
    ...(lodging
      ? {
          aiCheckOut:
            item.aiCheckOut === undefined
              ? (item.checkOut ?? item.end ?? null)
              : item.aiCheckOut,
        }
      : {}),
  };
}

function mergeImportedExpense(
  current: ExpenseItem,
  incoming: ExpenseItem,
): ExpenseItem {
  const previous = current.sourceSnapshot
    ? recordFromJson(current.sourceSnapshot)
    : {};
  const result = { ...incoming };
  for (const field of Object.keys(incoming) as Array<keyof ExpenseItem>) {
    if (
      field === 'sourceBatchId' ||
      field === 'sourceSnapshot' ||
      field === 'group' ||
      field === 'aiCheckOut'
    )
      continue;
    if (JSON.stringify(current[field]) !== JSON.stringify(previous[field]))
      Object.assign(result, { [field]: current[field] });
  }
  if (current.group !== incoming.group) result.categoryId = incoming.categoryId;
  return { ...result, sourceSnapshot: JSON.stringify(incoming) };
}

function recordFromJson(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

export function affectedMaterialDrafts(
  drafts: Record<DraftId, SubmissionDraft>,
  incoming: MaterialExpenseImport,
): Array<'expense' | 'personal'> {
  const batchId = incoming.materialBatchId ?? incoming.id ?? 'materials';
  const targets = new Set(
    incoming.items
      .filter((item) => !item.excluded)
      .map((item) => (item.group === 'daily' ? 'personal' : 'expense')),
  );
  return (['expense', 'personal'] as const).filter(
    (id) =>
      targets.has(id) ||
      drafts[id].expenses.some(
        (expense) =>
          expense.sourceBatchId === batchId ||
          (!expense.sourceBatchId &&
            incoming.items.some(
              (item) =>
                item.id === expense.id &&
                item.sourceFileId === expense.sourceFileId,
            )),
      ),
  );
}

export function importMaterialExpenses(
  drafts: Record<DraftId, SubmissionDraft>,
  incoming: MaterialExpenseImport,
  explicitBatchId?: string,
): Record<DraftId, SubmissionDraft> {
  const batchId =
    explicitBatchId ?? incoming.materialBatchId ?? incoming.id ?? 'materials';
  const key = `${incoming.id ?? batchId}:${incoming.revision}`;
  const items = incoming.items.filter((item) => !item.excluded);
  const targets = (['expense', 'personal'] as const).filter(
    (id) =>
      items.some(
        (item) => (item.group === 'daily' ? 'personal' : 'expense') === id,
      ) || drafts[id].expenses.some((item) => item.sourceBatchId === batchId),
  );
  if (targets.every((id) => drafts[id].sourceImportKey === key)) return drafts;
  const previousItems = [
    ...drafts.expense.expenses,
    ...drafts.personal.expenses,
  ];
  const next = { ...drafts };
  for (const id of ['expense', 'personal'] as const) {
    const original = drafts[id];
    const group = id === 'expense' ? 'travel' : 'daily';
    const imported = items
      .filter((item) => (item.group ?? 'travel') === group)
      .map((item) => {
        const value = importedExpense(item, incoming, batchId);
        const current = previousItems.find(
          (expense) =>
            expense.id === item.id &&
            (expense.sourceBatchId === batchId ||
              (!expense.sourceBatchId &&
                expense.sourceFileId === item.sourceFileId)),
        );
        return current
          ? mergeImportedExpense(current, value)
          : { ...value, sourceSnapshot: JSON.stringify(value) };
      });
    const retained = original.expenses.filter(
      (expense) =>
        expense.sourceBatchId !== batchId &&
        !items.some(
          (item) =>
            item.id === expense.id &&
            item.sourceFileId === expense.sourceFileId,
        ),
    );
    if (!imported.length && retained.length === original.expenses.length)
      continue;
    const expenses = [...retained, ...imported];
    const materialIds = [
      ...new Set([
        ...original.materialIds.filter(
          (fileId) =>
            !previousItems.some(
              (item) =>
                item.sourceBatchId === batchId && item.sourceFileId === fileId,
            ),
        ),
        ...expenses.flatMap((item) =>
          item.sourceFileId ? [item.sourceFileId] : [],
        ),
        ...expenses.flatMap((item) => item.files.map((file) => file.id)),
      ]),
    ];
    next[id] = {
      ...original,
      title: incoming.title
        ? `${incoming.title}${id === 'expense' ? '差旅报销' : '个人费用报销'}`
        : original.title,
      purpose:
        original.purpose || imported.find((item) => item.reason)?.reason || '',
      expenses,
      materialIds,
      files: original.files,
      invoiceUnique: undefined,
      validInvoice: undefined,
      sourceImportKey: key,
      version: original.version + 1,
      savedAt: new Date().toISOString(),
      status: 'draft',
    };
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readFiles(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter(
      (file) => typeof file.id === 'string' && typeof file.name === 'string',
    )
    .map((file) => ({
      id: String(file.id),
      name: String(file.name),
      size: typeof file.size === 'number' ? file.size : 0,
      type: textValue(file.type),
    }));
}

function migrateExpense(value: unknown): ExpenseItem {
  const source = asRecord(value);
  const result = createBlankExpense(textValue(source.categoryId));
  for (const field of Object.keys(result) as Array<keyof ExpenseItem>) {
    if (typeof result[field] === 'string' && typeof source[field] === 'string')
      Object.assign(result, { [field]: source[field] });
  }
  return {
    ...result,
    files: readFiles(source.files),
    attachments: readFiles(source.attachments),
    generated: source.generated === true,
    ...(typeof source.sourceFileId === 'string'
      ? { sourceFileId: source.sourceFileId }
      : {}),
    ...(source.group === 'travel' || source.group === 'daily'
      ? { group: source.group }
      : {}),
    ...(typeof source.sourceBatchId === 'string'
      ? { sourceBatchId: source.sourceBatchId }
      : {}),
    ...(typeof source.sourceSnapshot === 'string'
      ? { sourceSnapshot: source.sourceSnapshot }
      : {}),
    ...(typeof source.aiCheckOut === 'string' || source.aiCheckOut === null
      ? { aiCheckOut: source.aiCheckOut }
      : source.aiCheckOut === true
        ? { aiCheckOut: result.checkOut || null }
        : {}),
  };
}

function legacyExpenses(
  source: Record<string, unknown>,
  draftId: DraftId,
  files: Attachment[],
): ExpenseItem[] {
  const lines = source.expenseLines;
  if (Array.isArray(lines))
    return lines.map((value, index) => {
      const line = asRecord(value);
      const item: MaterialExpenseImport['items'][number] = {
        id: textValue(line.id) || `legacy-${index}`,
        name: textValue(line.name),
        category: textValue(line.category),
        amount:
          typeof line.amountCents === 'number' ? line.amountCents : Number.NaN,
        date: textValue(line.date),
        start: textValue(line.start),
        end: textValue(line.end),
        purpose: textValue(line.purpose) || textValue(source.purpose),
        oaId: textValue(line.oaId),
        sourceFileId: textValue(line.sourceFileId),
        group: draftId === 'personal' ? 'daily' : 'travel',
        nights: typeof line.nights === 'number' ? line.nights : undefined,
      };
      return importedExpense(item, { revision: 1, items: [], files }, 'legacy');
    });
  const hotelNights = typeof source.nights === 'number' ? source.nights : 0;
  const definitions: Array<[string, string, number]> = [
    [
      'transport',
      '',
      typeof source.transportCents === 'number' ? source.transportCents : 0,
    ],
    [
      'hotel',
      draftId === 'personal' ? 'other-hotel' : 'hotel',
      typeof source.hotelCents === 'number'
        ? source.hotelCents * hotelNights
        : 0,
    ],
    [
      'meal',
      'reception-meal',
      typeof source.mealCents === 'number' ? source.mealCents : 0,
    ],
  ];
  return definitions
    .filter(([, , amount]) => amount !== 0)
    .map(([id, categoryId, amount]) => ({
      ...createBlankExpense(categoryId),
      id: `legacy-${id}`,
      name:
        id === 'transport'
          ? '历史交通费用'
          : id === 'hotel'
            ? '历史住宿费用'
            : '历史餐饮费用',
      amount: (amount / 100).toFixed(2),
      reason: textValue(source.purpose),
      reasonOption: source.purpose ? '其他' : '',
      date: textValue(source.start),
      checkIn: id === 'hotel' ? textValue(source.start) : '',
      checkOut: id === 'hotel' ? textValue(source.end) : '',
      nights: id === 'hotel' ? String(hotelNights) : '',
    }));
}

export function migrateLegacyDrafts(
  input: unknown,
): Record<DraftId, SubmissionDraft> {
  const root = asRecord(input);
  const state = asRecord(root.rulesSubmission ?? root);
  const sources = asRecord(state.drafts ?? state);
  const drafts = createInitialDrafts();
  for (const id of ['travel', 'expense', 'personal'] as const) {
    const source = asRecord(sources[id]);
    if (!Object.keys(source).length) continue;
    const draft = drafts[id];
    for (const field of [
      'title',
      'applicant',
      'department',
      'paymentCompany',
      'travelType',
      'purpose',
      'applicationId',
    ] as const) {
      if (typeof source[field] === 'string') draft[field] = source[field];
    }
    draft.files = readFiles(source.files);
    draft.expenses = Array.isArray(source.expenses)
      ? source.expenses.map(migrateExpense)
      : legacyExpenses(source, id, draft.files);
    if (Array.isArray(source.legs))
      draft.legs = source.legs.map((value, index) => {
        const item = asRecord(value);
        return {
          id: textValue(item.id) || `legacy-leg-${index}`,
          departureCity: textValue(item.departureCity),
          arrivalCity: textValue(item.arrivalCity),
          departureDate: textValue(item.departureDate),
          arrivalDate: textValue(item.arrivalDate),
          transport: textValue(item.transport),
        };
      });
    if (Array.isArray(source.activities))
      draft.activities = source.activities.map((value, index) => {
        const item = asRecord(value);
        return {
          id: textValue(item.id) || `legacy-activity-${index}`,
          oaNumber: textValue(item.oaNumber),
          activityNumber: textValue(item.activityNumber),
          description: textValue(item.description),
          effectiveDate: textValue(item.effectiveDate),
          expiryDate: textValue(item.expiryDate),
          allocation: textValue(item.allocation),
          oaUrl: textValue(item.oaUrl),
          ...(item.source === 'manual' || item.source === 'sample'
            ? { source: item.source }
            : {}),
        };
      });
    if (
      source.activityMode === 'required' ||
      source.activityMode === 'optional' ||
      source.activityMode === 'hidden'
    )
      draft.activityMode = source.activityMode;
    draft.companions = Array.isArray(source.companions)
      ? source.companions.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    draft.materialIds = Array.isArray(source.materialIds)
      ? source.materialIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : draft.files.map((file) => file.id);
    draft.subsidyCents =
      typeof source.subsidyCents === 'number' ? source.subsidyCents : null;
    const oldPeriod = asRecord(source.legacyPeriod);
    if (source.start || source.end || oldPeriod.start || oldPeriod.end)
      draft.legacyPeriod = {
        start: textValue(oldPeriod.start ?? source.start),
        end: textValue(oldPeriod.end ?? source.end),
      };
    draft.version = typeof source.version === 'number' ? source.version : 1;
    draft.savedAt = typeof source.savedAt === 'string' ? source.savedAt : null;
    draft.status =
      source.status === 'awaiting_receipt' ? 'awaiting_receipt' : 'draft';
    if (typeof source.sourceImportKey === 'string')
      draft.sourceImportKey = source.sourceImportKey;
    if (typeof source.invoiceUnique === 'boolean')
      draft.invoiceUnique = source.invoiceUnique;
    if (
      typeof source.validInvoice === 'boolean' ||
      source.validInvoice === null
    )
      draft.validInvoice = source.validInvoice;
  }
  return drafts;
}
