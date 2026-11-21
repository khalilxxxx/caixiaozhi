import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ChatPage } from '../../apps/web/src/demos/agent-workspace/Chat';
import {
  WorkspaceContext, type Task, type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace';
import {
  expertTeamRefs,
  getCapability,
  prepareExpertTeamDraft,
} from '../../apps/web/src/demos/agent-workspace/capability-model';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

const file = { kind: 'file', id: 'f1', title: '费用明细.xlsx' };
const skill = { kind: 'skill', id: 's1', title: '附件翻译' };
const document = { kind: 'audit', id: 'd1', title: '出差报销单' };

describe('专家团会话', () => {
  it('按内置或个人专家团识别当前接待方，并为缺少名称的个人团保留身份', () => {
    expect(getCapability('finance-review-team')?.label).toBe('财务核验专家团');
    expect(getCapability('finance-analysis-team')?.label).toBe('财务分析专家团');
    expect(getCapability('expert-team-123', '采购核验组')?.label).toBe('采购核验组');
    expect(getCapability('expert-team-123')?.label).toBe('我的专家团');
  });

  it('召唤会保留草稿、附件和单据，追加示例，并移除手选技能', () => {
    const original = { input: '核对本月报销', refs: [skill, file, document] };
    const draft = prepareExpertTeamDraft(original, 'expert-team-123', '核对住宿标准', '采购核验组');
    expect(draft).toEqual({
      input: '核对本月报销\n\n核对住宿标准', refs: [file, document],
      capability: 'expert-team-123', expertTeamName: '采购核验组',
    });
    expect(prepareExpertTeamDraft(draft, 'expert-team-123', '核对住宿标准', '采购核验组')).toEqual(draft);
    expect(original.refs).toContain(skill);
  });

  it('从详情提问时合并原有材料和新引用，旧版草稿内的技能不会被发给专家团', () => {
    const rule = { kind: 'knowledge', id: 'k1', title: '差旅标准' };
    expect(expertTeamRefs([skill, file, document], [rule, file, skill])).toEqual([file, document, rule]);
    expect(expertTeamRefs([skill, file])).toEqual([file]);
  });

  it('运行过程中仅当前回复使用当前专家团，历史回复沿用各自的接待方', () => {
    const task: Task = {
      id: 'task', title: '费用核对', type: 'chat', status: '处理中', updated: '',
      input: '', refs: [], capability: 'finance-review-team', activeRunId: 'new',
      messages: [
        { id: 'first', role: 'assistant', text: '普通回复' },
        { id: 'previous', role: 'assistant', text: '历史意见', capability: 'expert-team-old', expertTeamName: '采购复核组' },
        { id: 'assistant-new', role: 'assistant', text: '当前意见', runId: 'new' },
      ],
    };
    const api = { state: { data: {}, tasks: [task], activeTask: task.id } } as WorkspaceAPI;
    const html: string = renderToStaticMarkup(createElement(
      WorkspaceContext.Provider, { value: api },
      createElement(ChatPage, { task, composer: null, busy: true, onRename() {}, onStop() {} }),
    ));
    const authors = [...html.matchAll(/class="assistant-name".*?<span>([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(authors).toEqual(['财小智', '采购复核组', '财务核验专家团']);
  });
});
