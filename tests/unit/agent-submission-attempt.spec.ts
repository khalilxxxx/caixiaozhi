import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/web/src/demos/agent-workspace/runtime-client';
import {
  beginSubmissionAttempt,
  clearSubmissionAttempt,
  recordSubmissionReceipt,
  submitWasRejected,
} from '../../apps/web/src/demos/agent-workspace/submission-attempt';

describe('提交意图和回执恢复', () => {
  let items: Map<string, string>;
  beforeEach(() => {
    items = new Map();
    vi.stubGlobal(
      'window',
      Object.assign(new EventTarget(), {
        localStorage: {
          getItem: (id: string) => items.get(id) ?? null,
          setItem: (id: string, value: string) => items.set(id, value),
          removeItem: (id: string) => items.delete(id),
        },
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('按草稿隔离原请求，未核实前不覆盖旧版本，晚到的完成事件不清除新版本', () => {
    const old = beginSubmissionAttempt('travel', 2);
    const other = beginSubmissionAttempt('expense', 2);
    expect(beginSubmissionAttempt('travel', 2)).toEqual(old);
    expect(other.key).not.toBe(old.key);
    expect(() => beginSubmissionAttempt('travel', 3)).toThrow('请先核实');
    recordSubmissionReceipt('travel', old, {
      requestId: 'req',
      businessId: 'TR-1',
    });
    expect(beginSubmissionAttempt('travel', 2).receipt?.businessId).toBe(
      'TR-1',
    );
    clearSubmissionAttempt('travel', old);
    const next = beginSubmissionAttempt('travel', 3);
    clearSubmissionAttempt('travel', old);
    recordSubmissionReceipt('travel', old, {
      requestId: 'late',
      businessId: 'TR-1',
    });
    expect(beginSubmissionAttempt('travel', 3)).toEqual(next);
    expect(beginSubmissionAttempt('expense', 2)).toEqual(other);
  });

  it('只有明确业务拒绝才能结束未决状态', () => {
    expect(
      submitWasRejected(
        new ApiError('校验失败', 422, { code: 'VALIDATION_ERROR' }),
      ),
    ).toBe(true);
    expect(
      submitWasRejected(
        new ApiError('版本冲突', 409, { code: 'VERSION_CONFLICT' }),
      ),
    ).toBe(true);
    for (const status of [0, 200, 408, 429, 500, 503]) {
      expect(submitWasRejected(new ApiError('未取得回执', status, null))).toBe(
        false,
      );
    }
    expect(submitWasRejected(new ApiError('无法解析代理响应', 409, null))).toBe(
      false,
    );
  });

  it('无法持久保存提交标识时在发送前报错', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(() => beginSubmissionAttempt('travel', 2)).toThrow(
      '未能保存本次提交标识',
    );
    expect(items.size).toBe(0);
  });
});
