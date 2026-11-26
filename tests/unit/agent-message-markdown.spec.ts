import { describe, expect, it } from 'vitest';
import {
  messageInline,
  parseMessageMarkdown,
} from '../../apps/web/src/demos/agent-workspace/message-markdown.js';

describe('模型回复的安全 Markdown 呈现', () => {
  it('将金额重点与业务单号分别识别为加粗和行内代码', () => {
    expect(messageInline('金额 **1,200元**，单号 `LOCAL-1`')).toEqual([
      { kind: 'text', text: '金额 ' },
      { kind: 'strong', text: '1,200元' },
      { kind: 'text', text: '，单号 ' },
      { kind: 'code', text: 'LOCAL-1' },
    ]);
  });
  it('按真实段落、步骤和表格组织多行回复，不把表格分隔符显示为正文', () => {
    expect(
      parseMessageMarkdown(
        '## 核对结果\n\n请核对。\n\n1. 核对\n2. 提交\n\n| 项目 | 金额 |\n| --- | ---: |\n| 差旅 | 1200 |',
      ),
    ).toEqual([
      { kind: 'heading', text: '核对结果' },
      { kind: 'paragraph', text: '请核对。' },
      { kind: 'list', ordered: true, items: ['核对', '提交'] },
      { kind: 'table', header: ['项目', '金额'], rows: [['差旅', '1200']] },
    ]);
  });
  it('将 HTML、链接协议与不完整流式标记保留为文本，不产生可执行类型', () => {
    const input =
      '<img src=x onerror=alert(1)> [危险](javascript:alert(1)) **未完成';
    expect(messageInline(input)).toEqual([{ kind: 'text', text: input }]);
    expect(parseMessageMarkdown('| 项目 | 金额 |')).toEqual([
      { kind: 'paragraph', text: '| 项目 | 金额 |' },
    ]);
  });
  it('代码块内的列表与 HTML 保留原样，未闭合代码块也可流式显示', () => {
    expect(parseMessageMarkdown('```text\n- **原样**\n<script>')).toEqual([
      { kind: 'code', text: '- **原样**\n<script>' },
    ]);
  });
  it('支持引用块与水平分割线用于制度依据与分区呈现', () => {
    expect(
      parseMessageMarkdown('> 第十二条：上海住宿标准 600 元/晚\n> 超标需说明\n\n---\n\n请核对。'),
    ).toEqual([
      {
        kind: 'blockquote',
        text: '第十二条：上海住宿标准 600 元/晚\n超标需说明',
      },
      { kind: 'hr' },
      { kind: 'paragraph', text: '请核对。' },
    ]);
  });
});
