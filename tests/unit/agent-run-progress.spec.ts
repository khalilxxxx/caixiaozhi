import { describe, expect, it } from 'vitest';
import {
  createRunStream,
  reduceRunEvent,
  mergeRunMessages,
  mergeToolStep,
} from '../../apps/web/src/demos/agent-workspace/run-progress-model';
import type { ChatMessage } from '../../apps/web/src/demos/agent-workspace/workspace';

describe('真实运行进度', () => {
  it('同一次工具开始和结束归为一项，同名重试保留两次', () => {
    let steps = mergeToolStep([], {
      id: 'one',
      name: 'read',
      label: '读取材料',
      status: 'running',
    });
    steps = mergeToolStep(steps, {
      id: 'one',
      name: 'read',
      label: '读取材料',
      status: 'failed',
      durationMs: 120,
    });
    steps = mergeToolStep(steps, {
      id: 'two',
      name: 'read',
      label: '读取材料',
      status: 'running',
    });
    steps = mergeToolStep(steps, {
      id: 'two',
      name: 'read',
      label: '读取材料',
      status: 'completed',
      durationMs: 35,
    });
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      ['one', 'failed'],
      ['two', 'completed'],
    ]);
  });
  it('重连重放开始事件不会让已结束步骤倒退为运行中', () => {
    const steps = [
      { id: 'one', name: 'read', status: 'completed', durationMs: 20 },
    ];
    expect(
      mergeToolStep(steps, { id: 'one', name: 'read', status: 'running' }),
    ).toEqual(steps);
    expect(mergeToolStep(steps, steps[0])).toHaveLength(1);
  });
  it('文本增量保留步骤与当前活动，不携带工具原始输入输出', () => {
    let stream = createRunStream('run');
    stream = reduceRunEvent(stream, 'tool', {
      id: 'one',
      name: 'write',
      label: '生成报表',
      status: 'running',
      input: { secret: '不显示' },
      output: '/private/path',
    });
    stream = reduceRunEvent(stream, 'delta', { text: '正在核对' });
    expect(stream.text).toBe('正在核对');
    expect(stream.activity).toBe('生成报表');
    expect(stream.steps).toHaveLength(1);
    expect(JSON.stringify(stream)).not.toContain('secret');
    expect(JSON.stringify(stream)).not.toContain('/private/path');
  });
  it('重放阶段发现不会重复，耗时使用服务端整轮时间', () => {
    let stream = reduceRunEvent(createRunStream('run'), 'status', {
      phase: 'working',
      runStartedAt: 1_790_000_000_000,
    });
    const completed = {
      id: 'read',
      name: 'query_documents',
      status: 'completed',
      finding: '本次查到 2 张单据。',
      output: { internal: '不可见' },
    };
    stream = reduceRunEvent(stream, 'tool', completed);
    stream = reduceRunEvent(stream, 'tool', completed);
    const [live] = mergeRunMessages([], stream);
    expect(live?.runStartedAt).toBe(1_790_000_000_000);
    expect(live?.tools).toEqual([
      {
        id: 'read',
        name: 'query_documents',
        status: 'completed',
        finding: completed.finding,
      },
    ]);
    const failed = reduceRunEvent(stream, 'error', {
      runStatus: 'cancelled',
      message: '任务已暂停，草稿已保存。',
      runFinishedAt: 1_790_000_008_214,
    });
    expect(mergeRunMessages([], failed)[0]).toMatchObject({
      runStatus: 'cancelled',
      text: '任务已暂停，草稿已保存。',
      runStartedAt: 1_790_000_000_000,
      runFinishedAt: 1_790_000_008_214,
    });
  });
  it('旧消息和重连均不以订阅时间假充运行开始', () => {
    expect(
      mergeRunMessages([], createRunStream('old'))[0]?.runStartedAt,
    ).toBeUndefined();
    const saved: ChatMessage = {
      id: 'assistant-r',
      role: 'assistant',
      text: '',
      runId: 'r',
      runStatus: 'running',
      runStartedAt: 1_790_000_000_000,
    };
    const stream = reduceRunEvent(createRunStream('r'), 'status', {
      runStartedAt: '错误时间',
    });
    expect(mergeRunMessages([saved], stream)[0]?.runStartedAt).toBe(
      saved.runStartedAt,
    );
  });
  it('服务端已保存卡片时仍继续合并流式文字和步骤', () => {
    const messages: ChatMessage[] = [
      {
        id: 'assistant-run',
        runId: 'run',
        role: 'assistant',
        text: '',
        cards: [{ kind: 'submission', id: 'draft', title: '差旅申请' }],
        submissionPhase: 'collecting',
      },
    ];
    let stream = reduceRunEvent(createRunStream('run'), 'tool', {
      id: 'one',
      name: 'validate',
      label: '检查单据',
      status: 'running',
    });
    stream = reduceRunEvent(stream, 'delta', { text: '已保存行程。' });
    const merged = mergeRunMessages(messages, stream);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('已保存行程。');
    expect(merged[0]?.cards?.[0]?.id).toBe('draft');
    expect(merged[0]?.submissionPhase).toBe('collecting');
    expect(merged[0]?.tools?.[0]?.status).toBe('running');
    expect(messages[0]?.text).toBe('');
  });
  it('无正文时工具事件也能生成可见的运行消息，旧会话不串步骤', () => {
    const old: ChatMessage = {
      id: 'assistant-old',
      runId: 'old',
      role: 'assistant',
      text: '上次结果',
      tools: [{ id: 'old', name: 'read', status: 'completed' }],
    };
    const stream = reduceRunEvent(createRunStream('new'), 'tool', {
      id: 'new',
      name: 'read',
      status: 'running',
    });
    const merged = mergeRunMessages([old], stream);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(old);
    expect(merged[1]?.runId).toBe('new');
    expect(merged[1]?.tools?.map((s) => s.id)).toEqual(['new']);
  });
  it('最终结果到达后以持久正文和追问状态为准，迟到流不覆盖', () => {
    const saved: ChatMessage = {
      id: 'assistant-run',
      runId: 'run',
      runStatus: 'awaiting_input',
      role: 'assistant',
      text: '哪天出发？',
      tools: [{ id: 'one', name: 'read', status: 'completed' }],
    };
    const stream = reduceRunEvent(createRunStream('run'), 'delta', {
      text: '正在读取',
    });
    expect(mergeRunMessages([saved], stream)[0]).toEqual(saved);
  });
  it('兼容旧的无id工具开始结束，并保持不同调用记录', () => {
    let steps = mergeToolStep([], { name: 'read', status: 'running' });
    steps = mergeToolStep(steps, { name: 'read', status: 'completed' });
    steps = mergeToolStep(steps, { name: 'read', status: 'running' });
    expect(steps.map((s) => s.status)).toEqual(['completed', 'running']);
  });
  it('完整重放旧事件时，迟到的开始不覆盖已保存的阶段发现', () => {
    const saved: ChatMessage = {
      id: 'assistant-run',
      role: 'assistant',
      text: '',
      runStatus: 'running',
      tools: [
        { name: 'read', status: 'completed', finding: '已读取 2 条费用记录。' },
      ],
    };
    let stream = reduceRunEvent(createRunStream('run'), 'tool', {
      name: 'read',
      status: 'running',
    });
    expect(mergeRunMessages([saved], stream)[0]?.tools).toEqual(saved.tools);
    stream = reduceRunEvent(stream, 'tool', {
      name: 'read',
      status: 'completed',
      durationMs: 350,
    });
    expect(mergeRunMessages([saved], stream)[0]?.tools).toEqual([
      {
        name: 'read',
        status: 'completed',
        durationMs: 350,
        finding: '已读取 2 条费用记录。',
      },
    ]);
  });
  it('按旧工具的同名调用次序合并快照，保留失败、重试和新增调用', () => {
    const saved: ChatMessage = {
      id: 'assistant-run',
      role: 'assistant',
      text: '',
      runStatus: 'running',
      tools: [
        { name: 'read', status: 'failed' },
        { id: 'check', name: 'read', status: 'completed', label: '读取规则' },
        { name: 'read', status: 'running' },
      ],
    };
    let stream = createRunStream('run');
    for (const step of [
      { name: 'read', status: 'running' },
      { name: 'read', status: 'failed' },
      { id: 'check', name: 'read', status: 'completed' },
      { name: 'read', status: 'running' },
      { name: 'read', status: 'completed', finding: '已取得材料清单。' },
      { name: 'read', status: 'running' },
    ])
      stream = reduceRunEvent(stream, 'tool', step);
    expect(mergeRunMessages([saved], stream)[0]?.tools).toEqual([
      { name: 'read', status: 'failed' },
      { id: 'check', name: 'read', status: 'completed', label: '读取规则' },
      { name: 'read', status: 'completed', finding: '已取得材料清单。' },
      { name: 'read', status: 'running' },
    ]);
  });
  it('未知或损坏事件不清空已有进度', () => {
    const stream = reduceRunEvent(createRunStream('run'), 'tool', {
      id: 'one',
      name: 'read',
      status: 'running',
    });
    expect(
      reduceRunEvent(stream, 'tool', { status: 'banana', output: '不可信' }),
    ).toEqual(stream);
    expect(reduceRunEvent(stream, 'tool', null)).toEqual(stream);
  });
});
