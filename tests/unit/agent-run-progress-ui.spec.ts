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
  it('短任务使用单个面屏跟随实际动作，保留停止操作且不暴露工具参数', () => {
    const html = render({
      running: true,
      onStop() {},
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
    expect(html).toContain('正在核对费用金额');
    expect(html).toContain('run-progress-face');
    expect(html).toContain('停止办理');
    expect(html).not.toMatch(/secret|<details|执行记录|办理记录/);
    expect(
      render({
        running: false,
        status: 'completed',
        steps: [{ name: 'query_documents', status: 'completed' }],
        runStartedAt: 1000,
        runFinishedAt: 4500,
      }),
    ).toBe('');
  });

  it('跨阶段依发生顺序保留范围、真实业务发现、当前动作', () => {
    const html = render({
      running: true,
      steps: [
        {
          name: 'get_submission_draft',
          status: 'completed',
          finding: '原单已提交。',
          itinerary: { destination: '南京', transport: '高铁二等座' },
        },
        { name: 'validate_submission', status: 'running' },
      ],
    });
    expect(html).toMatch(/<details[^>]* open/);
    expect(html).toContain('南京');
    expect(html).toContain('高铁二等座');
    expect(html.indexOf('原单已提交。')).toBeGreaterThan(html.indexOf('<li'));
    expect(html.indexOf('原单已提交。')).toBeLessThan(
      html.lastIndexOf('正在检查单据'),
    );
  });

  it('连续成功读取合并，区分失败和重试；总用时采用服务端时间而非工具耗时之和', () => {
    const read = {
      name: 'read_uploaded_file',
      status: 'completed',
      finding: '已读到住宿票据。',
      durationMs: 100,
    };
    const html = render({
      running: false,
      status: 'completed',
      runStartedAt: 10000,
      runFinishedAt: 484000,
      steps: [
        { ...read, id: '1' },
        { ...read, id: '2' },
        { ...read, id: '3', status: 'failed', finding: undefined },
        { ...read, id: '4', finding: '已读到车票。' },
      ],
    });
    expect(html).toContain('用时 7 分 54 秒');
    expect(html.match(/<li\b/g)).toHaveLength(3);
    expect(html.match(/已读到住宿票据。/g)).toHaveLength(1);
    expect(html).toContain('未成功');
    expect(html).not.toMatch(/<details[^>]* open|run-progress-face/);
  });

  it('旧步骤与团队来源可核验，但缺少本轮起止就不声称总用时', () => {
    const html = render({
      running: false,
      steps: [
        {
          name: 'search_policies',
          status: 'completed',
          startedAt: '2026-11-20T05:11:00Z',
          finishedAt: '2026-11-20T05:11:01Z',
          expertSkill: '制度条款核对',
          expertConnector: '财务制度库',
        },
        { name: 'internal_unknown', status: 'completed' },
      ],
    });
    expect(html).toContain('制度条款核对');
    expect(html).toContain('财务制度库');
    expect(html).not.toMatch(/用时|internal_unknown|T05:/);
  });

  it('只加载技能再执行一个业务动作仍为短任务，保留仅有的真实来源', () => {
    const html = render({
      running: false,
      status: 'completed',
      runStartedAt: 1000,
      runFinishedAt: 3000,
      steps: [
        { name: 'get_skill_instructions', status: 'completed' },
        {
          name: 'query_documents',
          status: 'completed',
          expertConnector: '差旅单据库',
        },
      ],
    });
    expect(html).not.toContain('<details');
    expect(html).toContain('差旅单据库');
  });

  it('长任务等到首个业务动作实际启动后说明范围，未知动作不借用随后动作的范围', () => {
    const props = { running: true, runStartedAt: Date.now() - 10000 };
    const preparation = [
      { name: 'list_available_skills', status: 'completed' },
      { name: 'get_skill_instructions', status: 'completed' },
    ];
    const lookup = { name: 'search_policies', status: 'running' };
    const scope = '我先查找与这次咨询相关的制度条款。';
    expect(render({ ...props, steps: preparation })).not.toContain(scope);
    expect(render({ ...props, steps: [...preparation, lookup] })).toContain(
      scope,
    );
    expect(
      render({
        ...props,
        steps: [
          ...preparation,
          { name: 'other_action', status: 'completed' },
          lookup,
        ],
      }),
    ).not.toContain(scope);
  });

  it('同一制度查询返回不同命中数时，每条发现归在对应的查询下', () => {
    const read = { name: 'search_policies', status: 'completed' };
    const html = render({
      running: false,
      status: 'completed',
      runStartedAt: 1000,
      runFinishedAt: 16000,
      steps: [
        { ...read, finding: '查到 1 份相关制度。' },
        { ...read, finding: '查到 3 份相关制度。' },
        { ...read, finding: '查到 3 份相关制度。' },
      ],
    });
    const rows = html.match(/<li\b.*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('查到 1 份相关制度。');
    expect(rows[0]).not.toContain('查到 3 份相关制度。');
    expect(rows[1]).toContain('已查询制度（2 次）');
    expect(rows[1]).toContain('查到 3 份相关制度。');
  });

  it('刷新时已完成的工具不会因重播进度文案重新显示为当前动作', () => {
    const html = render({
      running: true,
      phase: 'working',
      activity: '正在查询制度',
      steps: [{ name: 'search_policies', status: 'completed' }],
    });
    expect(html).toContain('正在处理');
    expect(html).not.toContain('正在查询制度');
  });

  it('收起后保留最近尚未恢复的具体操作，已经重试成功的操作不再作为失败原因', () => {
    const check = { name: 'validate_submission', status: 'failed' };
    const lookup = { name: 'search_policies', status: 'completed' };
    function failureSummary(steps: (typeof check)[]) {
      return render({ running: false, status: 'failed', steps }).match(
        /<p class="run-progress-state".*?<\/p>/,
      )?.[0];
    }
    expect(failureSummary([check, lookup])).toContain('检查单据未成功');
    const otherCheck = { ...check, label: '检查补充单据', status: 'completed' };
    expect(failureSummary([check, otherCheck])).toContain('检查单据未成功');
    expect(
      failureSummary([check, lookup, { ...check, status: 'completed' }]),
    ).not.toContain('检查单据未成功');
  });

  it.each(['interrupted', 'incomplete'])(
    '中断发现时间不能作为本轮 %s 的结束时间',
    (status) => {
      const html = render({
        running: false,
        status,
        runStartedAt: 1000,
        runFinishedAt: 9000000,
        steps: [
          {
            name: 'read_expense_summary',
            status: 'completed',
            finding: '费用合计 900 元。',
          },
          { name: 'query_documents', status: 'failed' },
        ],
      });
      expect(html).toContain('本轮进展');
      expect(html).toContain('费用合计 900 元。');
      expect(html).toContain('查询单据未成功');
      expect(html).not.toContain('用时');
    },
  );

  it.each([
    ['awaiting_input', '待你回答'],
    ['paused', '已暂停'],
    ['failed', '未完成'],
    ['interrupted', '未完成'],
    ['cancelled', '已停止'],
  ])('本轮 %s 的状态可直接读到，面屏退出', (status, expected) => {
    const html = render({
      running: false,
      status,
      steps: [{ name: 'query_documents', status: 'completed' }],
    });
    expect(html).toContain(expected);
    expect(html).not.toContain('run-progress-face');
  });

  it('等待用户和终态无动效，长耗时的纯文字回复不编造工具步骤', () => {
    expect(render({ running: true, phase: 'awaiting_input' })).not.toMatch(
      /run-progress-face|run-progress-glint/,
    );
    expect(
      render({ running: true, phase: 'responding', activity: '正在整理回复' }),
    ).toContain('正在整理回复');
    expect(
      render({
        running: false,
        status: 'completed',
        runStartedAt: 1000,
        runFinishedAt: 17000,
      }),
    ).toContain('用时 16 秒');
    expect(
      render({
        running: false,
        status: 'completed',
        runStartedAt: 1000,
        runFinishedAt: 17000,
      }),
    ).not.toMatch(/<details|<li\b/);
    expect(render({ running: false, status: 'completed' })).toBe('');
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
    expect(html).not.toContain('class="run-progress is-completed"');
    expect(html).toContain('分析费用');
    expect(html).not.toContain('正在处理');
  });

  it('并行执行多项工具时提示并行数，点击停止时反馈正在停止', () => {
    const html = renderToStaticMarkup(
      createElement(RunProgress, {
        running: true,
        stopping: true,
        onStop() {},
        steps: [
          { name: 'query_documents', status: 'running' },
          { name: 'search_policy', status: 'running' },
        ],
      }),
    );
    expect(html).toContain('共 2 项并行');
    expect(html).toContain('正在停止');
    expect(html).toContain('run-progress-face');
  });

  it('消息保留用户引用回显、离线重连提示及完成步数摘要', () => {
    const task: Task = {
      id: 'task-refs',
      title: '核对合同',
      type: 'chat',
      status: '已完成',
      input: '',
      refs: [],
      updated: '',
      messages: [
        {
          id: 'u1',
          role: 'user',
          text: '请核对这份发票',
          refs: [{ kind: 'file', id: 'f1', title: '上海住宿发票.pdf' }],
          createdAt: Date.now(),
        },
        {
          id: 'a1',
          role: 'assistant',
          text: '已完成核对。',
          runStatus: 'completed',
          runStartedAt: 1_790_000_000_000,
          runFinishedAt: 1_790_000_018_000,
          tools: [
            { name: 'query_documents', status: 'completed' },
            { name: 'search_policy', status: 'completed' },
          ],
          createdAt: Date.now(),
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
          composer: null,
          runtimeStatus: { state: 'offline', message: '本地服务已断开' },
          onReconnect() {},
          onRename() {},
        }),
      ),
    );
    expect(html).toContain('上海住宿发票.pdf');
    expect(html).toContain('本地服务已断开');
    expect(html).toContain('重新连接');
    expect(html).toContain('已完成 2 步');
    expect(html).toContain('用时 18 秒');
  });
});
