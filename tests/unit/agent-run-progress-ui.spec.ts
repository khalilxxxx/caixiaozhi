import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ChatPage } from '../../apps/web/src/demos/agent-workspace/Chat';
import {
  WorkspaceContext,
  type Task,
  type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const componentPath = '../../apps/web/src/demos/agent-workspace/RunProgress';
const { RunProgress } = await import(componentPath);

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(RunProgress, props));
}

describe('会话内真实执行进度', () => {
  it('团队执行步骤保留实际使用的技能和来源', () => {
    const html = render({running: false, steps: [{name: 'search_policies', status:'completed',
      expertSkill: '制度条款核对', expertConnector: '财务制度库'}]});
    expect(html).toContain('制度条款核对');
    expect(html).toContain('财务制度库');
    expect(html).not.toContain('企查查');
  });

  it('使用真实业务动作，并且不输出原始工具名、参数和结果', () => {
    const html = render({
      running: true,
      activity: '正在处理',
      steps: [
        {
          id: 'secret-call-id',
          name: 'secret_internal_tool',
          label: '核对费用金额',
          status: 'running',
          input: { token: 'secret-input' },
          output: 'secret-output',
        },
      ],
    });
    expect(html).toContain('核对费用金额');
    expect(html).toContain('执行中');
    expect(html).not.toMatch(
      /secret-(call-id|input|output)|secret_internal_tool/,
    );
    expect(html).toContain('<summary');
    expect(html).toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('0/1 项已完成');
  });

  it('运行中的卡头提供停止操作，已读取的行程显示在记录页脚', () => {
    const html = render({
      running: true,
      onStop() {},
      steps: [
        {
          id: 'one',
          name: 'get_submission_draft',
          status: 'completed',
          durationMs: 800,
          itinerary: { destination: '南京', transport: '高铁二等座' },
        },
        { id: 'two', name: 'validate_submission', status: 'running' },
      ],
    });
    expect(html).toContain('停止办理');
    expect(html).toContain('1/2 项已完成');
    expect(html).toContain('0.8 秒');
    expect(html).toContain('南京');
    expect(html).toContain('高铁二等座');
    expect(
      render({
        running: false,
        status: 'completed',
        steps: [{ name: 'query_documents', status: 'completed' }],
      }),
    ).not.toContain('停止办理');
  });

  it('成功终态默认收起，并保留失败后重试的两次真实记录及耗时', () => {
    const html = render({
      running: false,
      status: 'completed',
      steps: [
        {
          id: 'first',
          name: 'query',
          label: '查询单据',
          status: 'failed',
          durationMs: 1200,
        },
        {
          id: 'retry',
          name: 'query',
          label: '查询单据',
          status: 'completed',
          durationMs: 2400,
        },
      ],
    });
    expect(html).toContain('已完成');
    expect(html).toContain('未成功');
    expect(html).toContain('1.2 秒');
    expect(html).toContain('2.4 秒');
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it.each([
    ['awaiting_input', '待你回答'],
    ['paused', '已暂停'],
    ['failed', '未完成'],
    ['interrupted', '未完成'],
    ['cancelled', '已停止'],
  ])('本轮 %s 不被已成功工具误标为全部完成', (status, expected) => {
    const html = render({
      running: false,
      status,
      steps: [{ name: 'query', label: '查询单据', status: 'completed' }],
    });
    expect(html.match(/<summary[\s\S]*?<\/summary>/)?.[0]).toContain(expected);
    expect(html.match(/<summary[\s\S]*?<\/summary>/)?.[0]).not.toContain(
      '已完成',
    );
  });

  it('没有运行终态时，完整工具记录也只作为执行记录展示', () => {
    const html = render({
      running: false,
      steps: [{ name: 'unrecognized_python_function', status: 'completed' }],
    });
    expect(html.match(/<summary[\s\S]*?<\/summary>/)?.[0]).toContain(
      '执行记录',
    );
    expect(html).not.toContain('unrecognized_python_function');
  });

  it('无步骤的当前运行呈现实际阶段，结束后不保留空进度块', () => {
    expect(
      render({ running: true, phase: 'responding', activity: '正在整理回复' }),
    ).toContain('正在整理回复');
    expect(render({ running: false, status: 'completed' })).toBe('');
  });

  it('思考轨迹与业务动作跟随本轮事件，等用户回答时立即切成静态', () => {
    const thinking = render({ running: true, phase: 'thinking', activity: '正在分析任务' });
    expect(thinking).toContain('data-activity="thinking"');
    expect(thinking).toContain('run-progress-orbit-light');
    expect(thinking).toContain('run-progress-glint');

    const steps = [{ id: 'read', name: 'read_uploaded_file', status: 'running' }];
    const working = render({ running: true, phase: 'working', steps });
    expect(working).toContain('data-activity="reading"');
    expect(working).not.toContain('run-progress-orbit-light');
    const waiting = render({ running: true, phase: 'awaiting_input', activity: '待你回答', steps });
    expect(waiting).toContain('data-activity="waiting"');
    expect(waiting).not.toMatch(/run-progress-(orbit-light|glint)/);
  });

  it('没有正文的真实工具记录仍保留在会话，失败后可主动继续', () => {
    const task: Task = {
      id: 'task',
      title: '核对费用',
      type: 'submission',
      status: '未完成',
      input: '仍在填写的内容',
      refs: [],
      updated: '',
      messages: [
        {
          id: 'assistant-run',
          role: 'assistant',
          text: '',
          submissionPhase: 'collecting',
          tools: [{ name: 'query_documents', status: 'failed' }],
        },
      ],
    };
    const api = {
      state: { data: {}, tasks: [task], activeTask: task.id },
    } as WorkspaceAPI;
    const html = renderToStaticMarkup(
      createElement(
        WorkspaceContext.Provider,
        { value: api },
        createElement(ChatPage, {
          task,
          busy: false,
          composer: '仍在填写的内容',
          onRename() {},
        }),
      ),
    );
    expect(html).toContain('查询单据');
    expect(html).toContain('未成功');
    expect(html).toContain('继续处理');
    expect(html).toContain('仍在填写的内容');
    expect(html).not.toContain('复制回复');
  });

  it('当前运行按运行标识绑定，不将历史消息变成进行中或重复显示等待', () => {
    const task: Task = {
      id: 'task',
      title: '核对费用',
      type: 'submission',
      status: '处理中',
      input: '',
      refs: [],
      updated: '',
      activeRunId: 'current',
      messages: [
        {
          id: 'assistant-old',
          role: 'assistant',
          text: '之前的回复',
          runId: 'old',
          runStatus: 'completed',
          tools: [{ name: 'query_documents', status: 'completed' }],
        },
        {
          id: 'assistant-current',
          role: 'assistant',
          text: '',
          runId: 'current',
          tools: [{ name: 'analyze_expenses', status: 'running' }],
        },
      ],
    };
    const api = {
      state: { data: {}, tasks: [task], activeTask: task.id },
    } as WorkspaceAPI;
    const html = renderToStaticMarkup(
      createElement(
        WorkspaceContext.Provider,
        { value: api },
        createElement(ChatPage, {
          task,
          busy: true,
          composer: null,
          onRename() {},
        }),
      ),
    );
    expect(html.match(/class="run-progress is-running"/g)).toHaveLength(1);
    expect(html.match(/class="run-progress is-completed"/g)).toHaveLength(1);
    expect(html).toContain('分析费用');
    expect(html).not.toContain('正在处理');
  });

  it('兼容毫秒时间戳与空耗时，不将时间戳作为业务内容显示', () => {
    const html = render({
      running: false,
      status: 'completed',
      steps: [
        {
          name: 'query_documents',
          status: 'completed',
          startedAt: 1794880000000,
          finishedAt: 1794880002500,
          durationMs: null,
        },
      ],
    });
    expect(html).toContain('2.5 秒');
    expect(html).not.toContain('1794880000000');
  });
});
