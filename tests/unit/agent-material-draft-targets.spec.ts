import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  applyMaterialBatch,
  readSubmissionState,
  suggestMaterialDraftId,
} from '../../apps/web/src/demos/agent-workspace/submission-state.js';
import {
  affectedMaterialDrafts,
  type MaterialExpenseImport,
} from '../../apps/web/src/demos/agent-workspace/submission-model.js';
import { MaterialsPanel } from '../../apps/web/src/demos/agent-workspace/Documents.js';
import {
  WorkspaceContext,
  type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace.js';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

function fixture() {
  const state = readSubmissionState({});
  state.drafts['personal-beijing'] = {
    ...structuredClone(state.drafts.personal),
    id: 'personal-beijing',
    type: 'personal',
    title: '北京费用报销',
    purpose: '北京客户资料',
  };
  const incoming = {
    id: 'batch-2',
    materialBatchId: 'batch-2',
    revision: 1,
    targetDraftIds: { personal: 'personal-beijing' },
    items: [
      {
        id: 'office',
        name: '办公用品',
        category: '办公',
        amount: 8000,
        date: '2026-11-17',
        purpose: '采购资料',
        group: 'daily',
        sourceFileId: 'file-2',
      },
    ],
  } as MaterialExpenseImport;
  return { state, incoming };
}

describe('材料载入指定报销实例', () => {
  it('普通餐饮费用弹层显示明确的待确认状态与用途问题', () => {
    const { state } = fixture();
    const file = {
      id: 'file-meal',
      name: '餐饮.pdf',
      status: 'recognized',
      batchId: 'batch-test',
    };
    const item = {
      id: 'meal',
      sourceFileId: file.id,
      name: '团餐',
      amount: 10000,
      date: '2026-11-17',
      group: 'daily',
      category: '餐饮',
      categoryId: null,
      categoryHint: 'meal-purpose',
      purpose: '员工用餐',
      confirmed: false,
    };
    const workspace = {
      state: {
        data: { submissions: state, materials: { files: [file], items: [item], revision: 1 } },
        tasks: [],
        activeTask: null,
      },
    } as WorkspaceAPI;
    const html = renderToStaticMarkup(createElement(
      WorkspaceContext.Provider,
      { value: workspace },
      createElement(MaterialsPanel, {
        panel: { kind: 'materials', title: 'AI 发票转费用', data: { fileId: file.id } },
      }),
    ));
    expect(html).toContain('费用类型待确认');
    expect(html.match(/请确认用餐用途/g)).toHaveLength(1);
    expect(html).toContain('请选择费用类型</option>');
  });

  it.each([undefined, 'batch-20261111'])('从空报销单进入不展示已有样例批次（%s）', (id) => {
    const { state } = fixture();
    const api = {
      state: { data: { submissions: state }, tasks: [], activeTask: null },
    } as WorkspaceAPI;
    const html = renderToStaticMarkup(createElement(WorkspaceContext.Provider, { value: api },
      createElement(MaterialsPanel, { panel: {
        kind: 'materials', id, title: 'AI 发票转费用', data: { draftId: 'personal-beijing' },
      } }),
    ));
    expect(html).toContain('本单暂无票据');
    expect(html).not.toContain('费用合计');
    expect(html).toContain('上传票据');
  });

  it('旧单已提交时，仍可载入明确选择的新实例', () => {
    const { state, incoming } = fixture();
    state.drafts.personal.status = 'awaiting_receipt';
    const before = structuredClone(state.drafts.personal);
    expect(affectedMaterialDrafts(state.drafts, incoming)).toEqual([
      'personal-beijing',
    ]);
    const result = applyMaterialBatch(state, incoming);
    expect(result.drafts['personal-beijing']?.expenses[0]?.id).toBe('office');
    expect(result.drafts.personal).toEqual(before);
  });

  it('保留另一张未提交单的内容和所选实例的暂存编辑', () => {
    const { state, incoming } = fixture();
    state.drafts.personal.purpose = '上海行程';
    state.edits['personal-beijing'] = {
      ...state.drafts['personal-beijing']!,
      purpose: '尚未保存的北京用途',
    };
    const old = structuredClone(state.drafts.personal);
    const result = applyMaterialBatch(state, incoming);
    expect(result.drafts.personal).toEqual(old);
    expect(result.edits['personal-beijing']?.purpose).toBe(
      '尚未保存的北京用途',
    );
    expect(result.edits['personal-beijing']?.expenses[0]?.amount).toBe('80.00');
    expect(applyMaterialBatch(result, incoming)).toBe(result);
  });

  it.each(['missing', 'expense', 'personal'])(
    '不将失效或类型错误目标 %s 回退到其他草稿',
    (id) => {
      const { state, incoming } = fixture();
      if (id === 'personal') state.drafts.personal.status = 'awaiting_receipt';
      const bad = { ...incoming, targetDraftIds: { personal: id } };
      expect(applyMaterialBatch(state, bad)).toBe(state);
    },
  );

  it('混合归属只写入两张所选实例，缺少任一目标则不写入', () => {
    const { state, incoming } = fixture();
    state.drafts['expense-beijing'] = {
      ...structuredClone(state.drafts.expense),
      id: 'expense-beijing',
      type: 'expense',
    };
    const mixed = {
      ...incoming,
      items: [
        ...incoming.items,
        { ...incoming.items[0]!, id: 'taxi', group: 'travel' as const },
      ],
    };
    expect(applyMaterialBatch(state, mixed)).toBe(state);
    const next = applyMaterialBatch(state, {
      ...mixed,
      targetDraftIds: {
        expense: 'expense-beijing',
        personal: 'personal-beijing',
      },
    });
    expect(
      next.drafts['expense-beijing']?.expenses.map((item) => item.id),
    ).toEqual(['taxi']);
    expect(
      next.drafts['personal-beijing']?.expenses.map((item) => item.id),
    ).toEqual(['office']);
    expect(next.drafts.expense).toBe(state.drafts.expense);
    expect(next.drafts.personal).toBe(state.drafts.personal);
  });

  it('优先明确上下文；多个同类草稿要求选择，不猜新旧单', () => {
    const { state } = fixture();
    expect(
      suggestMaterialDraftId(state.drafts, 'personal', 'personal-beijing'),
    ).toBe('personal-beijing');
    expect(suggestMaterialDraftId(state.drafts, 'personal')).toBe('');
    state.drafts.personal.status = 'awaiting_receipt';
    expect(suggestMaterialDraftId(state.drafts, 'personal')).toBe(
      'personal-beijing',
    );
    state.drafts['personal-beijing']!.status = 'awaiting_receipt';
    expect(suggestMaterialDraftId(state.drafts, 'personal')).toBe('new');
  });

  it('材料面板显示明确的草稿选择，沿用抽屉实例并排除已提交旧单', () => {
    const { state, incoming } = fixture();
    state.drafts.personal.status = 'awaiting_receipt';
    const api = {
      state: {
        data: {
          submissions: state,
          materials: {
            files: [
              {
                id: 'file-2',
                name: '办公用品.pdf',
                size: 100,
                type: 'application/pdf',
                status: 'recognized',
                batchId: 'batch-2',
              },
            ],
            items: incoming.items.map((item) => ({ ...item, confirmed: true })),
            revision: 1,
            acknowledged: false,
          },
        },
        tasks: [],
        activeTask: null,
      },
    } as WorkspaceAPI;
    const html = renderToStaticMarkup(
      createElement(
        WorkspaceContext.Provider,
        { value: api },
        createElement(MaterialsPanel, {
          panel: {
            kind: 'materials',
            id: 'batch-2',
            title: '材料',
            data: { draftId: 'personal-beijing' },
          },
        }),
      ),
    );
    expect(html).toContain(
      '<option value="personal-beijing" selected="">北京费用报销 · 北京客户资料</option>',
    );
    expect(html).not.toContain('<option value="personal">');
    expect(html).toContain('请选择要载入的草稿');
  });
});
