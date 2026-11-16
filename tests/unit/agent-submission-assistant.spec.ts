import { describe, expect, it } from 'vitest';
import { applySubmissionMessage } from '../../apps/web/src/demos/agent-workspace/submission-assistant.js';
import {
  createBlankExpense,
  type TravelLeg,
} from '../../apps/web/src/demos/agent-workspace/submission-model.js';
import { readSubmissionState } from '../../apps/web/src/demos/agent-workspace/submission-state.js';

const now = new Date('2026-11-16T08:00:00Z');
const leg = (overrides: Partial<TravelLeg> = {}): TravelLeg => ({
  id: 'outbound',
  departureCity: '杭州',
  arrivalCity: '北京',
  departureDate: '2026-11-23',
  arrivalDate: '2026-11-23',
  transport: '高铁',
  ...overrides,
});

function roundTrip() {
  const state = readSubmissionState({});
  state.drafts.travel.legs = [
    leg(),
    leg({
      id: 'return',
      departureCity: '北京',
      arrivalCity: '杭州',
      departureDate: '2026-11-25',
      arrivalDate: '2026-11-25',
    }),
  ];
  return state;
}

describe('对话增量填入智能提单', () => {
  it('明确行程写入未保存编辑，不猜测到达日期，不修改版本和正式草稿', () => {
    const state = readSubmissionState({});
    state.checks.travel = { version: 1, status: 'passed' };
    const before = structuredClone(state);
    const result = applySubmissionMessage(
      state,
      '11月23日从杭州去北京拜访客户，25日返回，高铁往返',
      'travel',
      now,
    );
    expect(result.changed).toBe(true);
    expect(result.state.edits.travel).toMatchObject({
      purpose: '拜访客户',
      version: 1,
      savedAt: null,
      legs: [
        {
          departureCity: '杭州',
          arrivalCity: '北京',
          departureDate: '2026-11-23',
          arrivalDate: '',
          transport: '高铁',
        },
        {
          departureCity: '北京',
          arrivalCity: '杭州',
          departureDate: '2026-11-25',
          arrivalDate: '',
          transport: '高铁',
        },
      ],
    });
    expect(result.changes).toEqual(
      expect.arrayContaining(['事由', '去程出发日期', '返程出发日期']),
    );
    expect(result.state.drafts).toBe(state.drafts);
    expect(result.state.checks).toBe(state.checks);
    expect(result.state.requests).toBe(state.requests);
    expect(state).toEqual(before);
  });

  it('从最新人工编辑增量修改返程，保留去程和其他人工字段', () => {
    const state = roundTrip();
    state.edits.travel = {
      ...structuredClone(state.drafts.travel),
      purpose: '人工补充的客户事项',
      companions: ['同事甲'],
      paymentCompany: '人工选择公司',
      legs: state.drafts.travel.legs.map((item) => ({
        ...item,
        transport: '飞机',
      })),
    };
    const result = applySubmissionMessage(
      state,
      '返程改到11月26日',
      'travel',
      now,
    );
    expect(result.state.edits.travel).toMatchObject({
      purpose: '人工补充的客户事项',
      companions: ['同事甲'],
      paymentCompany: '人工选择公司',
      legs: [
        { id: 'outbound', departureDate: '2026-11-23', transport: '飞机' },
        {
          id: 'return',
          departureDate: '2026-11-26',
          arrivalDate: '2026-11-25',
          transport: '飞机',
        },
      ],
    });
    expect(result.changes).toEqual(['返程出发日期']);
  });

  it('明确往返交通修改只改现有往返的交通', () => {
    const state = roundTrip();
    const result = applySubmissionMessage(state, '往返改为飞机', 'travel', now);
    expect(
      result.state.edits.travel?.legs.map((item) => item.transport),
    ).toEqual(['飞机', '飞机']);
    expect(
      result.state.edits.travel?.legs.map((item) => item.departureDate),
    ).toEqual(['2026-11-23', '2026-11-25']);
  });

  it('明确的单程交通只填对应去程，不生成返程', () => {
    const result = applySubmissionMessage(
      readSubmissionState({}),
      '11月23日从杭州去北京，乘坐高铁',
      'travel',
      now,
    );
    expect(result.state.edits.travel?.legs).toHaveLength(1);
    expect(result.state.edits.travel?.legs[0]?.transport).toBe('高铁');
  });

  it('只修改返程交通时保留人工选择的去程交通', () => {
    const state = roundTrip();
    const result = applySubmissionMessage(
      state,
      '返程交通工具改为飞机',
      'travel',
      now,
    );
    expect(
      result.state.edits.travel?.legs.map((item) => item.transport),
    ).toEqual(['高铁', '飞机']);
    expect(result.changes).toEqual(['返程交通工具']);
  });

  it('事由中的行程描述不被当作第二个字段命令', () => {
    const result = applySubmissionMessage(
      readSubmissionState({}),
      '事由改为11月23日从杭州去北京拜访客户',
      'travel',
      now,
    );
    expect(result.state.edits.travel?.purpose).toBe(
      '11月23日从杭州去北京拜访客户',
    );
    expect(result.state.edits.travel?.legs).toEqual([]);
    expect(result.changes).toEqual(['事由']);
  });

  it('无日期无交通的明确单程城市不生成返程、不填默认日期或交通', () => {
    const result = applySubmissionMessage(
      readSubmissionState({}),
      '从杭州去北京拜访客户',
      'travel',
      now,
    );
    expect(result.state.edits.travel?.legs).toHaveLength(1);
    expect(result.state.edits.travel?.legs[0]).toMatchObject({
      departureCity: '杭州',
      arrivalCity: '北京',
      departureDate: '',
      arrivalDate: '',
      transport: '',
    });
    expect(result.message).toContain('日期');
  });

  it.each(['2026年12月3日', '2026-12-03', '2026/12/3', '12月3日'])(
    '识别完整日期 %s 和明确单程城市',
    (date) => {
      const result = applySubmissionMessage(
        readSubmissionState({}),
        `${date}从上海到深圳`,
        'travel',
        now,
      );
      expect(result.state.edits.travel?.legs[0]).toMatchObject({
        departureCity: '上海',
        arrivalCity: '深圳',
        departureDate: '2026-12-03',
      });
    },
  );

  it('省略年月的日期按上海时间取值', () => {
    const result = applySubmissionMessage(
      readSubmissionState({}),
      '2日从杭州去北京',
      'travel',
      new Date('2026-12-31T17:00:00Z'),
    );
    expect(result.state.edits.travel?.legs[0]?.departureDate).toBe(
      '2027-01-02',
    );
  });

  it.each(['11月31日', '2026年2月29日', '13月3日'])(
    '非法日期 %s 不覆盖已有值并指出需要补充',
    (date) => {
      const state = roundTrip();
      const result = applySubmissionMessage(
        state,
        `返程改到${date}`,
        'travel',
        now,
      );
      expect(result.changed).toBe(false);
      expect(result.state).toBe(state);
      expect(result.changes).toEqual([]);
      expect(result.message).toMatch(/日期|填写/);
    },
  );

  it('模糊日期不被补成固定旅程，其他明确城市仍可填写', () => {
    const result = applySubmissionMessage(
      readSubmissionState({}),
      '下周从杭州去北京',
      'travel',
      now,
    );
    expect(result.state.edits.travel?.legs[0]?.departureDate).toBe('');
    expect(result.state.edits.travel?.legs).toHaveLength(1);
    expect(result.message).toMatch(/日期.*填写|填写.*日期/);
  });

  it('单独返程日期没有去程时仅提示补充，不凭空生成城市', () => {
    const state = readSubmissionState({});
    const result = applySubmissionMessage(
      state,
      '返程改到11月26日',
      'travel',
      now,
    );
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.message).toContain('单据');
  });

  it('多段行程只修改明确指定的一段', () => {
    const state = roundTrip();
    state.drafts.travel.legs.push(
      leg({
        id: 'third',
        departureCity: '杭州',
        arrivalCity: '广州',
        departureDate: '2026-11-28',
      }),
    );
    const result = applySubmissionMessage(
      state,
      '第2段出发日期改为11月26日',
      'travel',
      now,
    );
    expect(
      result.state.edits.travel?.legs.map((item) => item.departureDate),
    ).toEqual(['2026-11-23', '2026-11-26', '2026-11-28']);
    expect(result.state.edits.travel?.legs[0]).toEqual(
      state.drafts.travel.legs[0],
    );
    expect(result.state.edits.travel?.legs[2]).toEqual(
      state.drafts.travel.legs[2],
    );
  });

  it('多段行程的笼统往返或返程指令不覆盖所有段', () => {
    const state = roundTrip();
    state.drafts.travel.legs.push(
      leg({ id: 'third', departureCity: '杭州', arrivalCity: '广州' }),
    );
    for (const text of ['往返改为飞机', '返程改到11月26日']) {
      const result = applySubmissionMessage(state, text, 'travel', now);
      expect(result.changed).toBe(false);
      expect(result.state).toBe(state);
      expect(result.message).toMatch(/行程|单据/);
    }
  });

  it('两个连续单程不被误认为往返行程', () => {
    const state = roundTrip();
    state.drafts.travel.legs[1]!.arrivalCity = '广州';
    const result = applySubmissionMessage(state, '往返改为飞机', 'travel', now);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it.each([
    '返程改到11月26日或27日',
    '如果从杭州去北京，25日返回',
    '不要从杭州去北京',
  ])('不从有歧义或否定的信息生成行程变更：%s', (text) => {
    const state = roundTrip();
    const result = applySubmissionMessage(state, text, 'travel', now);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  it('待回执的单据不可修改并引导查询回执', () => {
    const state = roundTrip();
    state.drafts.travel.status = 'awaiting_receipt';
    const result = applySubmissionMessage(
      state,
      '事由改为季度客户拜访',
      'travel',
      now,
    );
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.message).toContain('查询回执');
  });

  it.each(['expense', 'personal'] as const)(
    '报销 %s 只改明示事由，不生成金额或发票识别结果',
    (id) => {
      const state = readSubmissionState({});
      state.edits[id] = {
        ...state.drafts[id],
        expenses: [
          {
            ...createBlankExpense('other-office'),
            amount: '128.50',
            reason: '原始明细事由',
          },
        ],
      };
      const result = applySubmissionMessage(
        state,
        '事由改为季度办公用品采购',
        id,
        now,
      );
      expect(result.state.edits[id]?.purpose).toBe('季度办公用品采购');
      expect(result.state.edits[id]?.expenses).toEqual(
        state.edits[id]?.expenses,
      );
      expect(result.changes).toEqual(['事由']);
      const invoice = applySubmissionMessage(
        state,
        '帮我识别发票并生成报销金额',
        id,
        now,
      );
      expect(invoice.changed).toBe(false);
      expect(invoice.state).toBe(state);
    },
  );

  it.each([
    '',
    '   ',
    '帮我填写单据',
    '客户反馈从业务去财务沟通',
    '帮我看看这段行程',
    '事由改为',
  ])('空白或不支持的输入不创建伪更改：%s', (text) => {
    const state = readSubmissionState({});
    const result = applySubmissionMessage(state, text, 'travel', now);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.changes).toEqual([]);
  });

  it('相同值重复更新不生成新的未保存更改', () => {
    const state = roundTrip();
    state.drafts.travel.purpose = '客户拜访';
    const result = applySubmissionMessage(
      state,
      '事由改为客户拜访',
      'travel',
      now,
    );
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.changes).toEqual([]);
  });
});
