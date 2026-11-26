import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { QuestionCard } from '../../apps/web/src/demos/agent-workspace/QuestionCard';
import {
  WorkspaceContext,
  type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace';
import type { ClarificationQuestion } from '../../apps/web/src/demos/agent-workspace/question-model';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const question: ClarificationQuestion = {
  id: 'q',
  title: '哪天从杭州出发？',
  options: [{ id: 'thursday', label: '周四出发' }],
  multiple: false,
  status: 'pending',
  draftId: 'travel',
  draftVersion: 2,
};
function render(value = question, version = 2, active = true) {
  const workspace = {
    state: {
      data: {
        submissions: { drafts: { travel: { version, status: 'draft' } } },
      },
    },
  } as unknown as WorkspaceAPI;
  return renderToStaticMarkup(
    createElement(
      WorkspaceContext.Provider,
      { value: workspace },
      createElement(QuestionCard, { question: value, active, busy: false }),
    ),
  );
}

describe('消息中的追问记录', () => {
  it('待答消息只保留定位入口，不重复输入区的选项和回答表单', () => {
    const html = render();
    expect(html).toContain('哪天从杭州出发？');
    expect(html).toContain('转到输入区回答');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('<form');
  });
  it('已回答问题仍保留可展开的回答摘要，并同时呈现原问题标题与回答内容', () => {
    const html = render({
      ...question,
      status: 'answered',
      answer: { optionIds: ['thursday'], text: '返程未定' },
    });
    expect(html).toContain('<details');
    expect(html).toContain('已回答');
    expect(html).toContain('哪天从杭州出发？');
    expect(html).toContain('周四出发；返程未定');
    expect(html).not.toContain('转到输入区回答');
  });
  it('草稿版本变化或旧问题不可继续回答', () => {
    for (const html of [render(question, 3), render(question, 2, false)]) {
      expect(html).toContain('已失效');
      expect(html).not.toContain('转到输入区回答');
      expect(html).not.toContain('<textarea');
    }
  });
});
