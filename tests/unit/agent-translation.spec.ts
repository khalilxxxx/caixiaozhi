import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import {
  findTranslationBlock,
  normalizeTranslationBox,
  translationText,
  validateTranslationFile,
} from '../../apps/web/src/demos/agent-workspace/translation-model';

describe('附件翻译输入', () => {
  it('接受支持格式和 10 MB 边界，拒绝空文件、超限或伪装的类型', () => {
    expect(
      validateTranslationFile({
        name: '收据.JPG',
        type: '',
        size: 10 * 1024 * 1024,
      }),
    ).toBeNull();
    expect(
      validateTranslationFile({
        name: '收据.pdf',
        type: 'application/pdf',
        size: 12,
      }),
    ).toBeNull();
    expect(
      validateTranslationFile({ name: '收据.png', type: 'image/png', size: 0 }),
    ).toBeTruthy();
    expect(
      validateTranslationFile({
        name: '收据.png',
        type: 'image/png',
        size: 10 * 1024 * 1024 + 1,
      }),
    ).toBeTruthy();
    expect(
      validateTranslationFile({
        name: '收据.png',
        type: 'text/plain',
        size: 12,
      }),
    ).toBeTruthy();
    expect(
      validateTranslationFile({
        name: '收据.svg',
        type: 'image/svg+xml',
        size: 12,
      }),
    ).toBeTruthy();
  });
});

describe('译文与原图定位', () => {
  it('裁剪越界区域并拒绝非有限或无面积坐标，防止遮罩溢出原件', () => {
    expect(
      normalizeTranslationBox({ x: -0.1, y: 0.8, width: 0.5, height: 0.5 }),
    ).toEqual({ x: 0, y: 0.8, width: 0.4, height: 0.19999999999999996 });
    expect(
      normalizeTranslationBox({ x: 0, y: 0, width: NaN, height: 0.2 }),
    ).toBeNull();
    expect(
      normalizeTranslationBox({ x: 1.1, y: 0, width: 0.1, height: 0.2 }),
    ).toBeNull();
  });
  it('点击重叠区域时定位最精确的文字块，空白区域不误选', () => {
    const blocks = [
      {
        id: 'large',
        source: 'Total amount 100',
        target: '总额 100',
        bbox: { x: 0, y: 0, width: 0.8, height: 0.5 },
      },
      {
        id: 'amount',
        source: '100',
        target: '100',
        bbox: { x: 0.5, y: 0.2, width: 0.1, height: 0.1 },
      },
    ];
    expect(findTranslationBlock(blocks, 0.55, 0.25)?.id).toBe('amount');
    expect(findTranslationBlock(blocks, 0.9, 0.9)).toBeUndefined();
  });
  it('复制与下载包含每页译文并保留页次，不丢失后续 PDF 页', () => {
    expect(
      translationText([
        { page: 1, blocks: [{ target: '合计：100 元' }] },
        { page: 2, blocks: [{ target: '谢谢惠顾' }, { target: '请保留收据' }] },
      ]),
    ).toBe('第 1 页\n合计：100 元\n\n第 2 页\n谢谢惠顾\n\n请保留收据');
  });
});

const completed = {
  fileId: 'f1',
  fileName: 'receipt.png',
  status: 'completed',
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  createdAt: '2026-11-17T00:00:00Z',
  pages: [
    {
      page: 1,
      width: 100,
      height: 100,
      imageUrl: '/api/local/files/f1/pages/1',
      blocks: [
        {
          id: 'b1',
          source: 'Total',
          target: '合计',
          bbox: { x: 0, y: 0, width: 0.1, height: 0.1 },
        },
      ],
    },
  ],
};

describe('附件翻译请求恢复', () => {
  it('打开未翻译附件只读取缓存，不隐式发起翻译', async () => {
    vi.resetModules();
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(init.method ?? 'GET');
      return new Response(JSON.stringify({ message: '尚无译文' }), {
        status: 404,
      });
    });
    const client =
      await import('../../apps/web/src/demos/agent-workspace/translation-client');
    await expect(client.readTranslation('f1')).resolves.toBeNull();
    expect(requests).toEqual(['GET']);
  });
  it('重复启动与重新打开复用进行中的请求，并保留完成结果', async () => {
    vi.resetModules();
    let release!: (value: Response) => void;
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(init.method ?? 'GET');
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const client =
      await import('../../apps/web/src/demos/agent-workspace/translation-client');
    const original = client.startTranslation('f1');
    const repeated = client.startTranslation('f1');
    const reopened = client.readTranslation('f1');
    expect(client.translationIsRunning('f1')).toBe(true);
    release(new Response(JSON.stringify(completed)));
    expect(await original).toEqual(completed);
    expect(await repeated).toEqual(completed);
    expect(await reopened).toEqual(completed);
    expect(await client.readTranslation('f1')).toEqual(completed);
    expect(client.translationIsRunning('f1')).toBe(false);
    expect(requests).toEqual(['POST']);
  });
  it('失败请求允许重试，不把错误或空白译文缓存为完成', async () => {
    vi.resetModules();
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify(
            ++attempt === 1 ? { ...completed, pages: [] } : completed,
          ),
        ),
    );
    const client =
      await import('../../apps/web/src/demos/agent-workspace/translation-client');
    await expect(client.startTranslation('f1')).rejects.toThrow();
    expect(client.translationIsRunning('f1')).toBe(false);
    await expect(client.startTranslation('f1')).resolves.toEqual(completed);
  });
});
