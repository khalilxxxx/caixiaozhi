import { describe, expect, it } from 'vitest';
import {
  available,
  catalogArea,
  currentVersion,
  filterCatalog,
  readCatalogRoute,
  reviewStage,
  skillCatalogItem,
  skillDocumentText,
  writeCatalogRoute,
  type Skill,
  type SkillVersion,
} from '../../apps/web/src/demos/agent-workspace/skills-catalog-model';

const published: SkillVersion = {
  version: '1.0.0',
  status: 'published',
  mode: 'runnable',
  business: 'pass',
  security: 'pass',
  compatibility: 'pass',
  technical: 'pass',
  note: '',
  updated: '2026-11-17',
  events: [],
};
const skill: Skill = {
  id: 'report',
  title: '费用报告',
  category: '数据分析',
  description: '汇总 CSV 费用',
  icon: 'chart',
  owner: '我',
  tags: ['费用'],
  favorite: true,
  view: true,
  download: true,
  call: true,
  instructions: '输入：CSV',
  versions: [published],
};

describe('统一技能工具目录', () => {
  it('内置版本可共享技能正文，上传版本只读取本版的内容', () => {
    const file = { name: 'SKILL.md', size: 200, type: 'text/markdown' };
    expect(skillDocumentText(skill, published)).toBe(skill.instructions);
    expect(skillDocumentText(skill, { ...published, file })).toBe('');
    expect(skillDocumentText(skill, {
      ...published, instructions: '  ', file: { ...file, text: '历史上传版本正文' },
    })).toBe('历史上传版本正文');
    expect(skillDocumentText(skill, {
      ...published, instructions: '本版正文', file: { ...file, text: '原文件文本' },
    })).toBe('本版正文');
  });

  it('分开两个目录，并将旧应用、上传和结果链接归入轻应用', () => {
    expect(catalogArea('#skills?section=teams')).toBe('skills');
    expect(catalogArea('#skills?section=connectors')).toBe('skills');
    expect(catalogArea('#skills?view=manage&type=skill')).toBe('skills');
    for (const hash of [
      '#light-apps', '#skills?tab=tools', '#skills?type=tool',
      '#skills?view=manage&action=upload', '#skills?action=requests',
      '#skills?tool=expense-summary&result=r1',
    ]) expect(catalogArea(hash)).toBe('light-apps');
    const route = readCatalogRoute('#skills?tool=reconcile&q=费用');
    const next = writeCatalogRoute(route, 'light-apps');
    expect(catalogArea(next)).toBe('light-apps');
    expect(readCatalogRoute(next)).toEqual(route);
    expect(catalogArea('#documents')).toBeNull();
  });

  it('区分只读资料、无使用权限与包检查阻断的可用状态', () => {
    expect(
      skillCatalogItem({
        ...skill,
        versions: [{ ...published, mode: 'storage' }],
      }).availabilityState,
    ).toBe('reference');
    expect(skillCatalogItem({ ...skill, call: false }).availabilityState).toBe(
      'denied',
    );
    expect(
      skillCatalogItem({
        ...skill,
        versions: [
          {
            ...published,
            file: { name: 'skill.zip', type: 'application/zip', size: 10 },
          },
        ],
      }).availabilityState,
    ).toBe('unavailable');
    expect(skillCatalogItem(skill).availabilityState).toBe('available');
  });
  it('有新版草稿时选择现行已发布版本并保留最新版本管理信息', () => {
    const item = {
      ...skill,
      versions: [
        { ...published, version: '2.0.0', status: 'draft' as const },
        published,
      ],
    };
    expect(currentVersion(item).version).toBe('1.0.0');
    expect(skillCatalogItem(item)).toMatchObject({
      version: '1.0.0',
      latestVersion: '2.0.0',
      canUse: true,
    });
  });

  it.each([
    { ...skill, view: false },
    { ...skill, call: false },
    { ...skill, versions: [{ ...published, security: 'fail' as const }] },
    { ...skill, versions: [{ ...published, mode: 'storage' as const }] },
    {
      ...skill,
      versions: [
        {
          ...published,
          file: { name: 'skill.zip', type: 'application/zip', size: 10 },
        },
      ],
    },
  ])('不可查看、无调用权限或运行条件不满足时不能使用 %#', (item) => {
    expect(available(item)).toBe(false);
    expect(skillCatalogItem(item).canUse).toBe(false);
  });

  it('目录过滤不可见和未发布资产，但保留可查看的只读资料', () => {
    const items = [
      skillCatalogItem(skill),
      skillCatalogItem({ ...skill, id: 'hidden', view: false }),
      skillCatalogItem({
        ...skill,
        id: 'draft',
        versions: [{ ...published, status: 'draft' }],
      }),
      skillCatalogItem({ ...skill, id: 'read-only', call: false }),
    ];
    expect(
      filterCatalog(items, readCatalogRoute('#skills')).map((item) => item.id),
    ).toEqual(['report', 'read-only']);
  });

  it('我创建的仅展示本人可查看和维护的条目，包含本人的草稿和待审核版本', () => {
    const draft = skillCatalogItem({
      ...skill, id: 'draft', versions: [{ ...published, status: 'draft' }],
    });
    const items = [
      skillCatalogItem(skill), draft,
      { ...draft, id: 'review', status: 'review' },
      { ...draft, id: 'others', createdByMe: false, canManage: true },
      { ...draft, id: 'hidden', canView: false },
      { ...draft, id: 'not-managed', canManage: false },
    ];
    const route = readCatalogRoute('#skills?scope=mine');
    expect(filterCatalog(items, route).map(item => item.id)).toEqual(['report', 'draft', 'review']);
    expect(readCatalogRoute(writeCatalogRoute(route)).scope).toBe('mine');
    expect(filterCatalog(items, readCatalogRoute('#skills')).map(item => item.id)).toEqual(['report']);
  });

  it('技能与工具共用名称用途搜索、分类、类型和收藏筛选', () => {
    const item = skillCatalogItem(skill);
    const items = [
      item,
      { ...item, id: 'tool', type: 'tool' as const },
      { ...item, id: 'other', favorite: false },
    ];
    const filters = {
      ...readCatalogRoute('#skills'),
      search: ' csv ',
      type: 'tool' as const,
      category: '数据分析',
      favorites: true,
    };
    expect(filterCatalog(items, filters).map((entry) => entry.id)).toEqual([
      'tool',
    ]);
  });

  it('审核权限允许审核不可在目录发现的工具，但不扩大普通目录可见范围', () => {
    const item = {
      ...skillCatalogItem(skill),
      id: 'private-tool',
      type: 'tool' as const,
      canView: false,
      canManage: false,
      canReview: true,
    };
    expect(filterCatalog([item], readCatalogRoute('#skills'))).toEqual([]);
    expect(
      filterCatalog([item], readCatalogRoute('#skills?view=manage')),
    ).toEqual([]);
    expect(
      filterCatalog(
        [item],
        readCatalogRoute('#skills?view=manage&management=review'),
      ).map((entry) => entry.id),
    ).toEqual(['private-tool']);
  });

  it('工具工作区和管理往返保留筛选条件与审核标签', () => {
    const state = {
      ...readCatalogRoute('#skills'),
      view: 'manage' as const,
      management: 'review' as const,
      search: '费用 CSV',
      type: 'tool' as const,
      category: '数据分析',
      favorites: true,
      toolId: 'a/b',
      action: 'review',
    };
    expect(readCatalogRoute(writeCatalogRoute(state))).toEqual(state);
    expect(readCatalogRoute('#skills?tab=tools&tool=legacy')).toMatchObject({
      type: 'tool',
      toolId: 'legacy',
      action: 'tool',
    });
  });

  it('待审核和审核进行中不得标成已完成，双审通过后才完成', () => {
    expect(
      reviewStage({ ...published, status: 'draft', business: 'pending' }),
    ).toBe('pending');
    expect(
      reviewStage({ ...published, status: 'review', technical: 'pending' }),
    ).toBe('active');
    expect(
      reviewStage({ ...published, status: 'returned', technical: 'fail' }),
    ).toBe('returned');
    expect(reviewStage({ ...published, status: 'review' })).toBe('complete');
  });
});
