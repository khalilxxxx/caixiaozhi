import { describe, expect, it } from 'vitest';
import { documents } from '../../apps/web/src/demos/document-query/fixtures';
import type { GenericDocument } from '../../apps/web/src/demos/document-query/document-model';
import { latestProgressNode } from '../../apps/web/src/demos/agent-workspace/document-progress';

const travel = documents.find(
  (record) => record.typeId === 'travel_application',
)!;
const withSteps = (
  steps: GenericDocument['steps'],
  extras: Partial<GenericDocument> = {},
): GenericDocument => ({ ...travel, current: undefined, steps, ...extras });

describe('单据的当前或最近一个节点', () => {
  it('会签仅列出仍需处理的人，退回补件与付款待认领保留各自的责任方', () => {
    const nodeFor = (type: string) =>
      latestProgressNode(documents.find((record) => record.typeId === type)!);
    expect(nodeFor('contract_approval')).toMatchObject({
      actors: ['张伟'],
      role: '当前审批人',
      status: 'current',
    });
    expect(nodeFor('expense_claim')).toMatchObject({
      actors: ['你'],
      role: '待处理人',
      label: '补充住宿发票',
    });
    expect(nodeFor('payment_request')).toMatchObject({
      actors: ['资金共享中心'],
      role: '办理方',
      label: '支付处理 · 待认领',
    });
  });

  it('并行环节按时间取一条，同一节点的名称、处理人与时间配套', () => {
    const steps: GenericDocument['steps'] = [
      {
        id: 'b',
        label: '法务复核',
        actors: ['韩梅'],
        time: '11月16日 10:18 起',
        status: 'current',
      },
      {
        id: 'a',
        label: '部门审核',
        actors: ['李婷'],
        time: '2026-11-16T01:10:00Z',
        status: 'current',
      },
    ];
    const expected = {
      label: '法务复核',
      actors: ['韩梅'],
      time: steps[0]!.time,
      status: 'current',
      role: '当前审批人',
    };
    expect(latestProgressNode(withSteps(steps))).toEqual(expected);
    expect(
      latestProgressNode(
        withSteps(steps, {
          current: { label: '并行审批', actors: ['李婷', '韩梅'] },
        }),
      ),
    ).toEqual(expected);
    expect(
      latestProgressNode(
        withSteps(steps, { current: { label: '部门审核', actors: ['李婷'] } }),
      ),
    ).toMatchObject({
      label: '部门审核',
      actors: ['李婷'],
      time: steps[1]!.time,
    });
  });

  it('关闭的单据跳过过时当前节点和未来节点，返回最近的真实办理记录', () => {
    const node = latestProgressNode(
      withSteps(
        [
          {
            id: 'return',
            label: '财务退回',
            actors: ['刘敏'],
            status: 'returned',
            time: '2026-01-01T01:35:00Z',
          },
          {
            id: 'submit',
            label: '提交',
            actors: ['林悦'],
            status: 'done',
            time: '12月31日 17:00',
          },
          {
            id: 'future',
            label: '付款',
            status: 'future',
            time: '2026-01-10T10:00:00+08:00',
          },
        ],
        {
          status: 'closed',
          current: travel.current,
          updatedAt: '2026-01-01T10:00:00+08:00',
        },
      ),
    );
    expect(node).toEqual({
      label: '财务退回',
      actors: ['刘敏'],
      status: 'returned',
      time: '2026-01-01T01:35:00Z',
      role: '退回人',
    });
    const complete = latestProgressNode(
      documents.find((doc) => doc.typeId === 'budget_transfer')!,
    );
    expect(complete).toMatchObject({
      label: '调拨生效',
      actors: ['预算系统'],
      status: 'done',
    });
  });

  it('本地待审批未指派时保留空值，只有未来节点时不把更新时间或下一环节当作最近处理', () => {
    const local = latestProgressNode(
      withSteps([{ id: 'review', label: '待本地审批', status: 'current' }]),
    );
    expect(local).toMatchObject({
      label: '待本地审批',
      actors: [],
      status: 'current',
    });
    expect(local.time).toBeUndefined();
    const unknown = latestProgressNode(
      withSteps(
        [
          {
            id: 'future',
            label: '财务审批',
            actors: ['张伟'],
            status: 'future',
          },
        ],
        { status: 'unknown', phaseLabel: '' },
      ),
    );
    expect(unknown).toMatchObject({ actors: [], status: 'unknown' });
    expect(unknown.time).toBeUndefined();
  });
});
