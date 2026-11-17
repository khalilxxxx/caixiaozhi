import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  createInitialDrafts,
  getExpenseCategories,
  validateDraft,
} from '../../apps/web/src/demos/agent-workspace/submission-model.js';
import {
  readSubmissionState,
  resolveDraftId,
} from '../../apps/web/src/demos/agent-workspace/submission-state.js';
import {
  conversationDraft,
  latestSubmissionCards,
} from '../../apps/web/src/demos/agent-workspace/submission-conversation.js';
import {
  getSubmissionSummary,
  SubmissionPage,
  SubmissionPanel,
} from '../../apps/web/src/demos/agent-workspace/SubmissionWorkspace.js';
import {
  currentCard,
  syncTaskStates,
} from '../../apps/web/src/demos/agent-workspace/card-model.js';
import {
  WorkspaceContext,
  type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace.js';
import type { Task } from '../../apps/web/src/demos/agent-workspace/workspace.js';

const instance = () => ({
  ...createInitialDrafts().travel,
  id: 'travel-beijing',
  type: 'travel' as const,
  purpose: '北京拜访',
});
const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

describe('独立草稿身份', () => {
  it('保留实例 ID，并按单据类型校验行程和费用', () => {
    expect(resolveDraftId('travel-beijing')).toBe('travel-beijing');
    expect(getExpenseCategories('travel-beijing')).toEqual([]);
    const issues = validateDraft(instance(), { submit: true });
    expect(issues.some((item) => item.path === 'legs')).toBe(true);
    expect(issues.some((item) => item.path === 'expenses')).toBe(false);
  });

  it('读取与卡片摘要使用实例自己的暂存编辑', () => {
    const fresh = instance();
    const drafts = { ...createInitialDrafts(), [fresh.id]: fresh };
    drafts.travel.purpose = '上海拜访';
    const data = {
      submissions: {
        drafts,
        edits: { [fresh.id]: { ...fresh, purpose: '北京项目交流' } },
        checks: {},
        requests: [],
      },
    };
    expect(readSubmissionState(data).drafts.travel.purpose).toBe('上海拜访');
    const card = currentCard(
      { kind: 'submission', id: fresh.id, title: '北京申请' },
      data,
    );
    expect(card.id).toBe(fresh.id);
    expect(card.data?.snapshot.purpose).toBe('北京项目交流');
    expect(getSubmissionSummary(data, fresh.id).subtitle).toContain('差旅申请');
  });

  it('同类不同实例都保留当前卡，后续修改沿用实例', () => {
    const task = {
      id: 't',
      type: 'submission',
      messages: [
        {
          id: 'old',
          cards: [{ kind: 'submission', id: 'travel', title: '上海申请' }],
        },
        {
          id: 'new',
          cards: [
            { kind: 'submission', id: 'travel-beijing', title: '北京申请' },
          ],
        },
      ],
    } as Task;
    expect([...latestSubmissionCards(task)]).toEqual(['old:0', 'new:0']);
    expect(conversationDraft('返程改到11月26日', task, [])).toBe(
      'travel-beijing',
    );
    expect(conversationDraft('把这个差旅申请返程改到11月26日', task, [])).toBe(
      'travel-beijing',
    );
  });

  it('我的单据保留旧稿与新稿，实例抽屉仍显示差旅行程表单', () => {
    const fresh = { ...instance(), title: '北京申请' };
    const drafts = { ...createInitialDrafts(), [fresh.id]: fresh };
    drafts.travel.title = '上海申请';
    const api = {
      state: {
        data: {
          submissions: {
            drafts,
            edits: { travel: { ...drafts.travel, title: '上海未保存稿' } },
            checks: {},
            requests: [],
          },
        },
        tasks: [],
        activeTask: null,
      },
    } as WorkspaceAPI;
    const render = (component: unknown, props?: unknown) =>
      renderToStaticMarkup(
        createElement(
          WorkspaceContext.Provider,
          { value: api },
          createElement(component, props),
        ),
      );
    const page = render(SubmissionPage);
    expect(page).toContain('北京申请');
    expect(page).toContain('上海未保存稿');
    const drawer = render(SubmissionPanel, {
      panel: {
        kind: 'submission',
        id: fresh.id,
        title: '差旅申请',
        data: { view: 'edit' },
      },
    });
    expect(drawer).toContain('差旅行程');
    expect(drawer).not.toContain('费用明细');
    const missing = render(SubmissionPanel, {
      panel: { kind: 'submission', id: 'travel-missing', title: '差旅申请' },
    });
    expect(missing).toContain('单据不存在');
    expect(missing).not.toContain('上海未保存稿');
  });

  it('草稿变化不会覆盖尚待回答的问题状态', () => {
    const task = {
      id: 't',
      type: 'submission',
      status: '待你回答',
      messages: [{ id: 'q', question: { id: 'q', status: 'pending' } }],
    } as Task;
    expect(syncTaskStates([task], {}, 'submissions')[0]?.status).toBe(
      '待你回答',
    );
  });

  it('实例按类型保留服务端语义规则检查的有效状态', () => {
    const draft = instance();
    const rule = {
      id: 'semantic-travel',
      name: '出差事由检查',
      system: 'oa',
      origin: 'personal',
      scope: 'submit',
      metric: 'semantic',
      effect: 'warn',
      enabled: true,
      version: 1,
      description: '核对出差事由',
      instruction: '核对出差事由',
      requiredFields: ['purpose'],
      documentTypes: ['travel'],
    };
    const check = {
      version: draft.version,
      signature: JSON.stringify([rule]),
      checkedAt: '2026-11-17',
      issues: [],
      review: {
        status: 'clear',
        findings: [],
        passed: [rule],
        inapplicable: [],
        applicable: [rule],
      },
    };
    const data = {
      submissions: {
        drafts: { ...createInitialDrafts(), [draft.id]: draft },
        edits: {},
        checks: { [draft.id]: check },
        requests: [],
      },
      rulesSubmission: { rules: [rule] },
    };
    expect(getSubmissionSummary(data, draft.id).status).toBe('待确认提交');
  });
});
