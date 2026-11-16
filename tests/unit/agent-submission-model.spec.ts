import { describe, expect, it } from 'vitest';
import {
  affectedMaterialDrafts,
  createBlankExpense,
  createInitialDrafts,
  draftPeriod,
  draftCurrencyTotals,
  draftTotal,
  expenseNights,
  getExpenseCategories,
  getExpenseCategory,
  importMaterialExpenses,
  migrateLegacyDrafts,
  switchExpenseCategory,
  validateDraft,
  type MaterialExpenseImport,
  type SubmissionDraft,
  type TravelLeg,
} from '../../apps/web/src/demos/agent-workspace/submission-model.js';

const leg = (
  id: string,
  departureCity: string,
  arrivalCity: string,
  departureDate: string,
  arrivalDate = departureDate,
): TravelLeg => ({
  id,
  departureCity,
  arrivalCity,
  departureDate,
  arrivalDate,
  transport: '高铁',
});

function travel(): SubmissionDraft {
  return {
    ...createInitialDrafts().travel,
    title: '客户拜访',
    applicant: '林悦',
    department: '财务部',
    paymentCompany: '华川科技',
    purpose: '项目交流',
    travelType: '境内出差',
    legs: [
      leg('out', '北京', '上海', '2026-11-01', '2026-11-02'),
      leg('back', '上海', '北京', '2026-11-05'),
    ],
  };
}

function personal(): SubmissionDraft {
  return {
    ...createInitialDrafts().personal,
    title: '办公采购报销',
    applicant: '林悦',
    department: '财务部',
    paymentCompany: '华川科技',
    purpose: '采购办公用品',
    expenses: [
      {
        ...createBlankExpense('other-office'),
        date: '2026-11-01',
        amount: '80.10',
        reason: '采购笔记本',
      },
    ],
  };
}

const batch: MaterialExpenseImport = {
  id: 'batch-1',
  materialBatchId: 'batch-1',
  revision: 1,
  title: '上海客户拜访票据',
  materialIds: ['invoice-hotel', 'invoice-meal', 'invoice-rail'],
  files: [
    {
      id: 'invoice-hotel',
      name: '住宿.pdf',
      size: 1000,
      type: 'application/pdf',
    },
    {
      id: 'invoice-meal',
      name: '餐饮.pdf',
      size: 2000,
      type: 'application/pdf',
    },
    {
      id: 'invoice-rail',
      name: '交通.pdf',
      size: 3000,
      type: 'application/pdf',
    },
  ],
  items: [
    {
      id: 'hotel',
      name: '上海住宿',
      category: '住宿',
      amount: 65000,
      date: '2026-11-01',
      end: '2026-11-03',
      purpose: '客户拜访住宿',
      group: 'travel',
      sourceFileId: 'invoice-hotel',
    },
    {
      id: 'meal',
      name: '项目交流餐饮',
      category: '餐饮',
      amount: 68000,
      date: '2026-11-02',
      purpose: '项目交流工作餐',
      oaId: 'OA-1',
      group: 'daily',
      sourceFileId: 'invoice-meal',
    },
    {
      id: 'rail',
      name: '出行票据',
      category: '交通',
      amount: 55200,
      date: '2026-11-01',
      purpose: '拜访交通',
      group: 'travel',
      sourceFileId: 'invoice-rail',
    },
  ],
};

describe('智能提单业务字段', () => {
  it('个人费用仍按配置校验活动必填，活动日期独立于差旅行程', () => {
    const draft = personal();
    draft.activityMode = 'required';
    expect(
      validateDraft(draft, { submit: true }).some(
        (issue) => issue.path === 'activities',
      ),
    ).toBe(true);
    draft.activities = [
      {
        id: 'activity-1',
        oaNumber: 'OA-1',
        activityNumber: 'ACT-1',
        description: '项目活动',
        effectiveDate: '2026-10-01',
        expiryDate: '2026-10-31',
        allocation: '',
        oaUrl: '',
      },
    ];
    expect(
      validateDraft(draft, { submit: true }).filter((issue) =>
        issue.path.startsWith('activities'),
      ),
    ).toEqual([]);
  });
  it('空值可保存草稿，提交时检查组织、差旅字段与费用必填', () => {
    const drafts = createInitialDrafts();
    expect(Object.keys(drafts)).toEqual(['travel', 'expense', 'personal']);
    expect(validateDraft(drafts.travel, { submit: false })).toEqual([]);
    expect(validateDraft(drafts.personal, { submit: false })).toEqual([]);
    expect(
      validateDraft(drafts.travel, { submit: true }).map((issue) => issue.path),
    ).toEqual(
      expect.arrayContaining([
        'applicant',
        'department',
        'paymentCompany',
        'purpose',
        'travelType',
        'legs',
      ]),
    );
    expect(
      validateDraft(drafts.expense, { submit: true }).map(
        (issue) => issue.path,
      ),
    ).toContain('applicationId');
    expect(validateDraft(travel(), { submit: true })).toEqual([]);
    expect(validateDraft(personal(), { submit: true })).toEqual([]);
  });

  it('AI初始字段仅设置币种及非租房，不填金额、房间数或交通工具', () => {
    const expense = createBlankExpense('hotel');
    expect(expense).toMatchObject({
      currency: 'CNY',
      rental: '否',
      amount: '',
      rooms: '',
      people: '',
      standard: '',
      transport: '',
      reason: '',
      checkIn: '',
      checkOut: '',
    });
  });

  it('个人报销保留其他长途交通与住宿，排除两个标准一级大类', () => {
    const categories = getExpenseCategories('personal');
    expect(
      categories.some(
        (category) =>
          category.group === '长途交通' || category.group === '住宿',
      ),
    ).toBe(false);
    expect(
      categories.find((category) => category.id === 'other-long-distance')
        ?.template,
    ).toBe('T08');
    expect(
      categories.find((category) => category.id === 'other-hotel')?.template,
    ).toBe('T09');
    expect(
      categories.filter((category) => category.group === '其他'),
    ).toHaveLength(29);
    expect(
      getExpenseCategories('expense').filter(
        (category) => category.group === '其他',
      ),
    ).toHaveLength(14);
    expect(getExpenseCategories('travel')).toEqual([]);
  });

  it.each(['hotel', 'long-distance'])(
    '个人报销提交也拒绝历史或外部写入的标准类型 %s',
    (categoryId) => {
      const draft = personal();
      draft.expenses[0] = { ...draft.expenses[0]!, categoryId };
      expect(
        validateDraft(draft, { submit: true }).map((issue) => issue.path),
      ).toContain('expenses.0.categoryId');
    },
  );

  it('模板必填保留房间数、人数、采购数量和餐饮OA的差异', () => {
    expect(getExpenseCategory('hotel')?.requiredFields).toEqual(
      expect.arrayContaining([
        'checkIn',
        'checkOut',
        'city',
        'rooms',
        'currency',
        'amount',
        'reason',
      ]),
    );
    expect(getExpenseCategory('reception-meal-oa')?.requiredFields).toEqual(
      expect.arrayContaining(['date', 'standard', 'people', 'oaId']),
    );
    expect(getExpenseCategory('reception-gift')?.requiredFields).toEqual(
      expect.arrayContaining(['people', 'quantity']),
    );
    expect(getExpenseCategory('other-hotel')?.requiredFields).not.toContain(
      'rooms',
    );
    const draft = personal();
    draft.expenses = [
      {
        ...createBlankExpense('reception-gift'),
        date: '2026-11-01',
        amount: '12',
        reason: '客户纪念品',
      },
    ];
    expect(
      validateDraft(draft, { submit: true }).map((issue) => issue.path),
    ).toEqual(
      expect.arrayContaining(['expenses.0.people', 'expenses.0.quantity']),
    );
  });

  it('行程需要闭环，且禁止中途回到首城后再次出发', () => {
    const draft = travel();
    draft.legs.pop();
    expect(
      validateDraft(draft, { submit: true }).map((issue) => issue.path),
    ).toContain('legs');
    draft.legs = [
      leg('a', '北京', '上海', '2026-11-01'),
      leg('b', '上海', '北京', '2026-11-02'),
      leg('c', '北京', '杭州', '2026-11-03'),
      leg('d', '杭州', '北京', '2026-11-04'),
    ];
    expect(
      validateDraft(draft, { submit: true }).some((issue) =>
        issue.message.includes('再次出发'),
      ),
    ).toBe(true);
  });

  it('行程保留跨日，校验城市衔接、日期先后与同城', () => {
    const draft = travel();
    expect(draftPeriod(draft)).toEqual({
      start: '2026-11-01',
      end: '2026-11-05',
    });
    draft.legs[1] = leg('back', '杭州', '北京', '2026-11-01');
    const paths = validateDraft(draft, { submit: true }).map(
      (issue) => issue.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining(['legs.1.departureCity', 'legs.1.departureDate']),
    );
    draft.legs[0] = leg('same', '北京', '北京', '2026-11-03', '2026-11-02');
    expect(
      validateDraft(draft, { submit: true }).map((issue) => issue.path),
    ).toEqual(
      expect.arrayContaining(['legs.0.arrivalCity', 'legs.0.arrivalDate']),
    );
  });

  it('允许非起始城市重复经过', () => {
    const draft = travel();
    draft.legs = [
      leg('a', '北京', '上海', '2026-11-01'),
      leg('b', '上海', '杭州', '2026-11-02'),
      leg('c', '杭州', '上海', '2026-11-03'),
      leg('d', '上海', '北京', '2026-11-04'),
    ];
    expect(validateDraft(draft, { submit: true })).toEqual([]);
  });

  it('活动按动态三态检查，有日期交集即可，边界当天可交集', () => {
    const draft = travel();
    draft.activityMode = 'required';
    expect(
      validateDraft(draft, { submit: true }).map((issue) => issue.path),
    ).toContain('activities');
    draft.activities = [
      {
        id: 'activity',
        oaNumber: 'OA-1',
        activityNumber: 'ACT-1',
        description: '项目交流',
        effectiveDate: '2026-11-05',
        expiryDate: '2026-11-10',
        allocation: '',
        oaUrl: '',
      },
    ];
    expect(validateDraft(draft, { submit: true })).toEqual([]);
    draft.activities[0]!.effectiveDate = '2026-11-06';
    expect(
      validateDraft(draft, { submit: true }).map((issue) => issue.path),
    ).toContain('activities.0.effectiveDate');
    draft.activityMode = 'hidden';
    expect(validateDraft(draft, { submit: true })).toEqual([]);
  });

  it('切换费用类型保留最新金额、事由、日期和文件，住宿日期可往返转换', () => {
    const file = {
      id: 'file-1',
      name: '发票.pdf',
      size: 1,
      type: 'application/pdf',
    };
    const expense = {
      ...createBlankExpense('taxi'),
      date: '2026-11-02',
      amount: '15.20',
      reason: '拜访客户',
      files: [file],
      attachments: [file],
    };
    const hotel = switchExpenseCategory(expense, 'hotel');
    expect(hotel).toMatchObject({
      checkIn: '2026-11-02',
      amount: '15.20',
      reason: '拜访客户',
      files: [file],
      attachments: [file],
    });
    hotel.checkIn = '2026-11-03';
    hotel.checkOut = '2026-11-06';
    const taxi = switchExpenseCategory(hotel, 'taxi');
    expect(taxi.date).toBe('2026-11-03');
    taxi.date = '2026-11-04';
    expect(taxi).toMatchObject({ checkOut: '', city: '', oaId: '' });
    expect(switchExpenseCategory(taxi, 'hotel')).toMatchObject({
      checkIn: '2026-11-04',
      checkOut: '',
      rental: '',
      files: [file],
    });
  });

  it('类型切换只迁移共有字段，普通日期不写入交通起止日期，共有空值保持为空', () => {
    const taxi = {
      ...createBlankExpense('taxi'),
      date: '2026-11-02',
      transport: '',
      oaId: 'OA-OLD',
      tripId: 'old-trip',
    };
    const traffic = switchExpenseCategory(taxi, 'other-long-distance');
    expect(traffic).toMatchObject({
      date: '',
      departureDate: '',
      arrivalDate: '',
      transport: '',
      oaId: '',
      tripId: '',
    });
    const hotel = {
      ...createBlankExpense('hotel'),
      checkIn: '',
      checkOut: '2026-11-04',
      date: '2026-11-01',
      rental: '',
      city: '上海',
    };
    expect(switchExpenseCategory(hotel, 'other-hotel')).toMatchObject({
      checkIn: '',
      checkOut: '2026-11-04',
      city: '上海',
      rental: '',
      date: '',
    });
    expect(switchExpenseCategory(hotel, 'taxi')).toMatchObject({
      date: '',
      checkIn: '',
      checkOut: '',
      city: '',
    });
  });

  it('个人报销期间忽略遗留行程，并按币种独立合计', () => {
    const draft = personal();
    draft.legs = [leg('old', '北京', '上海', '2025-01-01')];
    draft.expenses.push({
      ...createBlankExpense('other-office'),
      currency: 'USD',
      amount: '20.10',
      date: '2026-11-03',
    });
    draft.subsidyCents = 100;
    expect(draftPeriod(draft)).toEqual({
      start: '2026-11-01',
      end: '2026-11-03',
    });
    expect(draftTotal(draft)).toBe(8110);
    expect(draftCurrencyTotals(draft)).toEqual([
      { currency: 'CNY', amountCents: 8110 },
      { currency: 'USD', amountCents: 2010 },
    ]);
  });

  it('费用期间包含入住退房与跨日交通，金额以分精确累计', () => {
    const draft = personal();
    draft.expenses.push({
      ...createBlankExpense('other-hotel'),
      checkIn: '2026-10-30',
      checkOut: '2026-11-03',
      amount: '0.20',
    });
    draft.expenses.push({
      ...createBlankExpense('other-long-distance'),
      departureDate: '2026-11-04',
      arrivalDate: '2026-11-05',
      amount: '',
    });
    expect(draftTotal(draft)).toBe(8030);
    expect(draftPeriod(draft)).toEqual({
      start: '2026-10-30',
      end: '2026-11-05',
    });
    expect(expenseNights(draft.expenses[1]!)).toBe(4);
  });

  it('草稿允许留空，填写非法金额或倒置日期时显示业务错误', () => {
    const draft = personal();
    draft.expenses[0]!.amount = '12.345';
    expect(
      validateDraft(draft, { submit: false }).map((issue) => issue.path),
    ).toContain('expenses.0.amount');
    draft.expenses = [
      {
        ...createBlankExpense('other-hotel'),
        checkIn: '2026-11-03',
        checkOut: '2026-11-03',
      },
    ];
    expect(
      validateDraft(draft, { submit: false }).map((issue) => issue.path),
    ).toContain('expenses.0.checkOut');
  });

  it('混合材料逐笔分入差旅和个人报销，保留用途、OA、住宿期间、文件和来源', () => {
    const drafts = importMaterialExpenses(createInitialDrafts(), batch);
    expect(drafts.expense.expenses).toHaveLength(2);
    expect(drafts.personal.expenses).toHaveLength(1);
    expect(drafts.expense.expenses[0]).toMatchObject({
      amount: '650.00',
      reason: '客户拜访住宿',
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      sourceFileId: 'invoice-hotel',
      group: 'travel',
      files: [batch.files![0]],
      generated: true,
    });
    expect(drafts.personal.expenses[0]).toMatchObject({
      amount: '680.00',
      reason: '项目交流工作餐',
      oaId: 'OA-1',
      date: '2026-11-02',
      sourceFileId: 'invoice-meal',
      group: 'daily',
    });
    expect(drafts.personal.materialIds).toEqual(['invoice-meal']);
    expect(drafts.expense.expenses[1]).toMatchObject({
      categoryId: '',
      transport: '',
    });
  });

  it('材料导入保留自有母单附件，发票只关联对应费用', () => {
    const drafts = createInitialDrafts();
    const travelAttachment = {
      id: 'travel-support',
      name: '出差情况说明.pdf',
      size: 1200,
      type: 'application/pdf',
    };
    const personalAttachment = {
      id: 'personal-support',
      name: '接待情况说明.pdf',
      size: 1500,
      type: 'application/pdf',
    };
    drafts.expense.files = [travelAttachment];
    drafts.personal.files = [personalAttachment];

    const imported = importMaterialExpenses(drafts, batch);

    expect(imported.expense.files).toEqual([travelAttachment]);
    expect(imported.personal.files).toEqual([personalAttachment]);
    expect(imported.expense.expenses[0]!.files).toEqual([batch.files![0]]);
    expect(imported.personal.expenses[0]!.files).toEqual([batch.files![1]]);
    expect(imported.personal.materialIds).toEqual(['invoice-meal']);
  });

  it.each(['move', 'exclude'] as const)(
    '材料批次%s日常费用后仍标记原个人报销草稿受影响',
    (operation) => {
      const drafts = importMaterialExpenses(createInitialDrafts(), batch);
      const updated = {
        ...batch,
        revision: 2,
        items: batch.items.map((item) =>
          item.group !== 'daily'
            ? item
            : operation === 'move'
              ? { ...item, group: 'travel' as const }
              : { ...item, excluded: true },
        ),
      };

      expect(affectedMaterialDrafts(drafts, updated)).toEqual([
        'expense',
        'personal',
      ]);
    },
  );

  it('材料影响范围识别旧无批次标识来源，忽略无关单据', () => {
    const drafts = createInitialDrafts();
    drafts.personal.expenses = [
      {
        ...createBlankExpense('reception-meal'),
        id: 'meal',
        sourceFileId: 'invoice-meal',
      },
    ];
    const moved = {
      ...batch,
      items: [{ ...batch.items[1]!, group: 'travel' as const }],
    };
    expect(affectedMaterialDrafts(drafts, moved)).toEqual([
      'expense',
      'personal',
    ]);

    drafts.personal.expenses[0]!.sourceFileId = 'unrelated-file';
    expect(affectedMaterialDrafts(drafts, moved)).toEqual(['expense']);
  });

  it('新批次版本保留人工移除或更换的发票，未编辑费用采用新来源', () => {
    const first = importMaterialExpenses(createInitialDrafts(), batch);
    const removed = structuredClone(first);
    removed.expense.expenses[0]!.files = [];
    const replacement = {
      id: 'manual-replacement',
      name: '人工更换发票.pdf',
      size: 1800,
      type: 'application/pdf',
    };
    const replaced = structuredClone(first);
    replaced.expense.expenses[0]!.files = [replacement];
    const updatedFile = {
      id: 'invoice-hotel-updated',
      name: '住宿发票更新.pdf',
      size: 2100,
      type: 'application/pdf',
    };
    const updated = {
      ...batch,
      revision: 2,
      files: [...batch.files!, updatedFile],
      items: batch.items.map((item) =>
        item.id === 'hotel' ? { ...item, sourceFileId: updatedFile.id } : item,
      ),
    };

    expect(
      importMaterialExpenses(removed, updated).expense.expenses[0]!.files,
    ).toEqual([]);
    expect(
      importMaterialExpenses(replaced, updated).expense.expenses[0]!.files,
    ).toEqual([replacement]);
    expect(
      importMaterialExpenses(first, updated).expense.expenses[0]!.files,
    ).toEqual([updatedFile]);
  });

  it('材料载入费用变化后清除旧查验结论，同版本幂等保留现有结论', () => {
    const drafts = createInitialDrafts();
    drafts.expense.invoiceUnique = true;
    drafts.expense.validInvoice = true;
    const imported = importMaterialExpenses(drafts, batch);
    expect(imported.expense.invoiceUnique).toBeUndefined();
    expect(imported.expense.validInvoice).toBeUndefined();

    imported.expense.invoiceUnique = true;
    imported.expense.validInvoice = true;
    const repeated = importMaterialExpenses(imported, batch);
    expect(repeated).toBe(imported);
    expect(repeated.expense.invoiceUnique).toBe(true);
    expect(repeated.expense.validInvoice).toBe(true);

    const updated = importMaterialExpenses(imported, {
      ...batch,
      revision: 2,
      items: batch.items.map((item) =>
        item.id === 'hotel' ? { ...item, amount: 70000 } : item,
      ),
    });
    expect(updated.expense.invoiceUnique).toBeUndefined();
    expect(updated.expense.validInvoice).toBeUndefined();
  });

  it('同批次载入幂等，后续版本新增材料保留已编辑费用并处理分组迁移', () => {
    const first = importMaterialExpenses(createInitialDrafts(), batch);
    first.expense.expenses[0]!.amount = '600.00';
    const repeated = importMaterialExpenses(first, batch);
    expect(repeated).toBe(first);
    const next: MaterialExpenseImport = {
      ...batch,
      revision: 2,
      items: batch.items.map((item) =>
        item.id === 'hotel' ? { ...item, group: 'daily' as const } : item,
      ),
    };
    const changed = importMaterialExpenses(repeated, next);
    expect(changed.expense.expenses.map((item) => item.id)).not.toContain(
      'hotel',
    );
    expect(
      changed.personal.expenses.find((item) => item.id === 'hotel'),
    ).toMatchObject({
      amount: '600.00',
      categoryId: 'other-hotel',
      group: 'daily',
    });
    expect(
      changed.personal.expenses.filter((item) => item.id === 'hotel'),
    ).toHaveLength(1);
  });

  it('新材料版本刷新未改动字段，保留人工修改与主动清空字段', () => {
    const first = importMaterialExpenses(createInitialDrafts(), batch);
    first.expense.expenses[0]!.amount = '600.00';
    first.expense.expenses[0]!.reason = '';
    const updated = {
      ...batch,
      revision: 2,
      items: batch.items.map((item) =>
        item.id === 'hotel'
          ? {
              ...item,
              date: '2026-11-02',
              end: '2026-11-04',
              amount: 70000,
              purpose: '重新识别的用途',
            }
          : item,
      ),
    };
    expect(
      importMaterialExpenses(first, updated).expense.expenses[0],
    ).toMatchObject({
      amount: '600.00',
      reason: '',
      checkIn: '2026-11-02',
      checkOut: '2026-11-04',
      aiCheckOut: '2026-11-04',
    });
  });

  it('材料清空后移除本批费用，保留独立人工费用', () => {
    const first = importMaterialExpenses(createInitialDrafts(), batch);
    first.personal.expenses.push({
      ...createBlankExpense('other-office'),
      id: 'manual',
      amount: '20',
    });
    const next = importMaterialExpenses(first, {
      ...batch,
      revision: 2,
      items: [],
    });
    expect(next.expense.expenses).toEqual([]);
    expect(next.personal.expenses.map((item) => item.id)).toEqual(['manual']);
  });

  it('未分类交通材料保留已有起止事实，交通工具仍待补充', () => {
    const incoming = {
      ...batch,
      items: [
        {
          ...batch.items[2]!,
          departureDate: '2026-11-01',
          arrivalDate: '2026-11-02',
          departureCity: '北京',
          arrivalCity: '上海',
        },
      ],
    };
    expect(
      importMaterialExpenses(createInitialDrafts(), incoming).expense
        .expenses[0],
    ).toMatchObject({
      categoryId: '',
      departureDate: '2026-11-01',
      arrivalDate: '2026-11-02',
      departureCity: '北京',
      arrivalCity: '上海',
      transport: '',
    });
  });

  it('完整OCR类型名称匹配合法目录，明确起止日期在未分类时仍计入期间', () => {
    const incoming: MaterialExpenseImport = {
      ...batch,
      items: [
        { ...batch.items[0]!, category: '住宿/住宿费' },
        { ...batch.items[2]!, start: '2026-10-30', end: '2026-11-04' },
      ],
    };
    const draft = importMaterialExpenses(
      createInitialDrafts(),
      incoming,
    ).expense;
    expect(draft.expenses[0]!.categoryId).toBe('hotel');
    expect(draftPeriod(draft)).toEqual({
      start: '2026-10-30',
      end: '2026-11-04',
    });
  });

  it('住宿可选房间数填写后也校验正整数', () => {
    const draft = personal();
    draft.expenses = [{ ...createBlankExpense('other-hotel'), rooms: 'abc' }];
    expect(
      validateDraft(draft, { submit: false }).map((issue) => issue.path),
    ).toContain('expenses.0.rooms');
  });

  it('旧草稿迁移保留汇总金额、日期、事由和材料，不以空字段覆盖', () => {
    const drafts = migrateLegacyDrafts({
      drafts: {
        expense: {
          id: 'expense',
          title: '历史草稿',
          purpose: '原始用途',
          costCenter: '原部门',
          start: '2026-11-01',
          end: '2026-11-03',
          transportCents: 142000,
          hotelCents: 78000,
          mealCents: 28000,
          nights: 2,
          materialIds: ['old-file'],
          version: 4,
          savedAt: '旧保存时间',
          status: 'draft',
        },
      },
    });
    expect(draftTotal(drafts.expense)).toBe(326000);
    expect(drafts.expense).toMatchObject({
      title: '历史草稿',
      purpose: '原始用途',
      materialIds: ['old-file'],
      version: 4,
      savedAt: '旧保存时间',
      applicant: '',
      applicationId: '',
    });
    expect(draftPeriod(drafts.expense)).toEqual({
      start: '2026-11-01',
      end: '2026-11-03',
    });
  });

  it('旧逐笔草稿保持实际金额与文件，逐笔用途优先，重复迁移不改写新版字段', () => {
    const drafts = migrateLegacyDrafts({
      expense: {
        id: 'expense',
        purpose: '单据用途',
        expenseLines: [
          {
            id: 'old',
            name: '历史酒店',
            category: '住宿',
            amountCents: 12345,
            date: '2026-11-01',
            start: '2026-11-01',
            end: '2026-11-03',
            purpose: '逐笔用途',
            oaId: 'OA-OLD',
            sourceFileId: 'old-file',
          },
        ],
        materialIds: ['old-file'],
        files: [
          {
            id: 'old-file',
            name: '历史.pdf',
            size: 1,
            type: 'application/pdf',
          },
        ],
      },
    });
    expect(drafts.expense.expenses[0]).toMatchObject({
      amount: '123.45',
      reason: '逐笔用途',
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      oaId: 'OA-OLD',
      sourceFileId: 'old-file',
    });
    expect(drafts.expense.expenses[0]!.files[0]?.name).toBe('历史.pdf');
    drafts.expense.expenses[0]!.amount = '100.01';
    expect(migrateLegacyDrafts(drafts).expense.expenses[0]!.amount).toBe(
      '100.01',
    );
  });

  it('只有原整单期间的旧申请保留日期，不虚构逐段行程', () => {
    const draft = migrateLegacyDrafts({
      travel: {
        id: 'travel',
        start: '2026-11-01',
        end: '2026-11-04',
        transportCents: 10000,
      },
    }).travel;
    expect(draft.legacyPeriod).toEqual({
      start: '2026-11-01',
      end: '2026-11-04',
    });
    expect(draft.legs).toEqual([]);
    expect(draftPeriod(draft)).toEqual({
      start: '2026-11-01',
      end: '2026-11-04',
    });
  });

  it('旧申请预算不产生不可见的报销字段提交错误，旧缺失金额保持为空', () => {
    const migrated = migrateLegacyDrafts({
      travel: {
        id: 'travel',
        transportCents: 10000,
        hotelCents: 50000,
        nights: 2,
      },
    }).travel;
    const complete = { ...travel(), expenses: migrated.expenses };
    expect(validateDraft(complete, { submit: true })).toEqual([]);
    const incomplete = migrateLegacyDrafts({
      expense: { expenseLines: [{ id: 'empty', category: '住宿', date: '' }] },
    });
    expect(incomplete.expense.expenses[0]!.amount).toBe('');
  });
});
