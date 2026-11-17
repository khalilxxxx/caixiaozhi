import { describe, expect, it } from 'vitest';
import {
  buildMaterialExpenseBatch,
  materialExpenseError,
  materialSelectionId,
  selectMaterialScope,
  type MaterialExpense,
  type MaterialFile,
} from '../../apps/web/src/demos/agent-workspace/material-import.js';

const files: MaterialFile[] = [
  {
    id: 'hotel-file',
    name: '酒店电子发票.pdf',
    size: 345678,
    type: 'application/pdf',
    lastModified: 1794355200000,
    addedAt: '11月11日 17:30',
    status: 'recognized',
    batchId: 'batch-20261111',
  },
  {
    id: 'meal-file',
    name: '接待申请与发票.pdf',
    size: 234567,
    type: 'application/pdf',
    addedAt: '11月11日 17:30',
    status: 'recognized',
    batchId: 'batch-20261111',
  },
  {
    id: 'excluded-file',
    name: '重复票据.pdf',
    size: 120000,
    type: 'application/pdf',
    addedAt: '11月11日 17:30',
    status: 'duplicate',
    batchId: 'batch-20261111',
  },
];

const hotel: MaterialExpense = {
  id: 'hotel',
  name: '上海商旅酒店',
  category: '住宿',
  amount: 130000,
  date: '2026-11-10',
  end: '2026-11-12',
  purpose: '客户现场沟通住宿',
  group: 'travel',
  sourceFileId: 'hotel-file',
  confirmed: true,
};

const meal: MaterialExpense = {
  id: 'meal',
  name: '客户接待餐费',
  category: '餐饮',
  amount: 68000,
  date: '2026-11-11',
  purpose: '客户接待用餐',
  oaId: 'OA-2026-0612',
  group: 'daily',
  sourceFileId: 'meal-file',
  confirmed: true,
};

describe('材料费用导出', () => {
  it('保留每笔费用用途、OA、分组和住宿期间，供对应草稿载入', () => {
    const batch = buildMaterialExpenseBatch({
      items: [hotel, meal],
      files,
      revision: 7,
    });

    expect(batch).toMatchObject({
      id: 'batch-20261111',
      materialBatchId: 'batch-20261111',
      revision: 7,
      amount: 198000,
      items: [
        {
          id: 'hotel',
          amount: 130000,
          date: '2026-11-10',
          start: '2026-11-10',
          end: '2026-11-12',
          nights: 2,
          purpose: '客户现场沟通住宿',
          group: 'travel',
          sourceFileId: 'hotel-file',
        },
        {
          id: 'meal',
          amount: 68000,
          start: '2026-11-11',
          purpose: '客户接待用餐',
          oaId: 'OA-2026-0612',
          group: 'daily',
          sourceFileId: 'meal-file',
        },
      ],
    });
    expect(batch.items[1]?.end).toBeUndefined();
    expect(batch.items[1]?.nights).toBeUndefined();
  });

  it('只导出有效费用关联的真实文件，并对共享文件去重', () => {
    const batch = buildMaterialExpenseBatch({
      items: [
        hotel,
        meal,
        { ...meal, id: 'second-meal', amount: 10000 },
        {
          ...meal,
          id: 'excluded',
          sourceFileId: 'excluded-file',
          excluded: true,
        },
      ],
      files,
      revision: 2,
    });

    expect(batch.amount).toBe(208000);
    expect(batch.items.map((item) => item.id)).toEqual([
      'hotel',
      'meal',
      'second-meal',
    ]);
    expect(batch.materialIds).toEqual(['hotel-file', 'meal-file']);
    expect(batch.files).toEqual([
      {
        id: 'hotel-file',
        name: '酒店电子发票.pdf',
        size: 345678,
        type: 'application/pdf',
        lastModified: 1794355200000,
        addedAt: '11月11日 17:30',
        status: 'recognized',
        batchId: 'batch-20261111',
      },
      {
        id: 'meal-file',
        name: '接待申请与发票.pdf',
        size: 234567,
        type: 'application/pdf',
        addedAt: '11月11日 17:30',
        status: 'recognized',
        batchId: 'batch-20261111',
      },
    ]);
  });

  it('未补全住宿日期的费用留待核对，不能转入草稿', () => {
    const batch = buildMaterialExpenseBatch({
      items: [{ ...hotel, end: undefined }],
      files,
      revision: 3,
    });

    expect(batch.items).toEqual([]);
    expect(batch.materialIds).toEqual([]);
  });
  it('只整理选中文件，未知文件和空选择均不会混入样例', () => {
    const state = { files, items: [hotel, meal], revision: 1 };
    expect(
      selectMaterialScope(state, { fileIds: ['meal-file'] }).items,
    ).toEqual([meal]);
    expect(
      selectMaterialScope(state, { fileId: 'unknown-file' }).items,
    ).toEqual([]);
    expect(
      selectMaterialScope(state, { fileIds: [], batchId: 'batch-20261111' })
        .items,
    ).toEqual([]);
    expect(
      selectMaterialScope(state, { batchId: 'unknown-batch' }).files,
    ).toEqual([]);
    expect(
      selectMaterialScope(state, { batchId: 'batch-20261111' }).items,
    ).toEqual([hotel, meal]);
  });

  it('独立文件选择使用稳定批次标识且只导出该范围的原件', () => {
    const state = selectMaterialScope(
      { files, items: [hotel, meal], revision: 3 },
      { fileIds: ['meal-file'] },
    );
    const batchId = materialSelectionId(state.files);
    const batch = buildMaterialExpenseBatch(state, batchId);
    expect(batch.materialBatchId).toBe(batchId);
    expect(batch.items).toEqual([expect.objectContaining({ id: 'meal' })]);
    expect(batch.files.map((file) => file.id)).toEqual(['meal-file']);
    expect(materialSelectionId(files)).toBe(
      materialSelectionId([...files].reverse()),
    );
    expect(batchId).not.toBe(materialSelectionId(files));
  });

  it.each([
    { amount: null },
    { amount: 0 },
    { amount: -100 },
    { amount: 1.5 },
    { date: '' },
    { date: '2026-02-30' },
    { category: null },
    { group: null },
    { name: '' },
    { purpose: ' ' },
  ])('缺失或无效字段不可确认也不可转入草稿 %j', (patch) => {
    const item = { ...meal, ...patch };
    expect(materialExpenseError(item)).not.toBe('');
    expect(
      buildMaterialExpenseBatch({ items: [item], files, revision: 1 }).items,
    ).toEqual([]);
  });

  it('尚未人工确认的完整提取结果不能转入草稿', () => {
    expect(materialExpenseError(meal)).toBe('');
    expect(
      buildMaterialExpenseBatch({
        items: [{ ...meal, confirmed: false }],
        files,
        revision: 1,
      }).items,
    ).toEqual([]);
  });
});
