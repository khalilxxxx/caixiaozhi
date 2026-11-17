import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const componentPath =
  '../../apps/web/src/demos/agent-workspace/SkillArtifactPanel';
const { SkillArtifactContent } = await import(componentPath);

describe('生成成果安全预览', () => {
  it('HTML 只在禁用脚本与同源权限的 iframe 中显示', () => {
    const html = renderToStaticMarkup(
      createElement(SkillArtifactContent, {
        kind: 'html',
        name: '报告.html',
        source: '/api/local/artifacts/a1/preview',
      }),
    );
    expect(html).toContain('sandbox=""');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain('allow-scripts');
    expect(html).not.toContain('allow-same-origin');
  });

  it('文本成果中的标签保持纯文本，不成为可执行节点', () => {
    const html = renderToStaticMarkup(
      createElement(SkillArtifactContent, {
        kind: 'text',
        name: '备注.txt',
        text: '<script>alert(1)</script>\n总结',
      }),
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('总结');
  });
});
