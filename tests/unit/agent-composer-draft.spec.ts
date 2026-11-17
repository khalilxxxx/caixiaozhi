import { describe, expect, it } from 'vitest';
import { rememberComposerDraft, readComposerDraft, forgetComposerDraft } from '../../apps/web/src/demos/agent-workspace/composer-draft';

function localStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } as Storage;
}
describe('未发送输入的本标签页恢复', () => {
  it('刷新前保存完整输入，并隔离不同会话', () => {
    const target = localStorage();
    rememberComposerDraft('one', '还没有发送的补充\n第二行', target);
    expect(readComposerDraft('one', target)).toBe('还没有发送的补充\n第二行');
    expect(readComposerDraft('two', target)).toBeNull();
  });
  it('发送后的空输入不会被服务端旧草稿复活，删除会话可清理', () => {
    const target = localStorage();
    rememberComposerDraft('one', '旧输入', target);
    rememberComposerDraft('one', '', target);
    expect(readComposerDraft('one', target)).toBe('');
    forgetComposerDraft('one', target);
    expect(readComposerDraft('one', target)).toBeNull();
  });
  it('浏览器存储不可用时仍允许正常输入', () => {
    const target = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } } as unknown as Storage;
    expect(() => rememberComposerDraft('one', '输入', target)).not.toThrow();
    expect(readComposerDraft('one', target)).toBeNull();
  });
});
