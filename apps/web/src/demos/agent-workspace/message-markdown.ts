export type InlineToken = { kind: 'text' | 'strong' | 'code'; text: string };
export type MessageBlock =
  | { kind: 'paragraph' | 'heading' | 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] };

// A deliberately limited text grammar. HTML and links remain inert text.
export function messageInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > cursor)
      tokens.push({ kind: 'text', text: text.slice(cursor, index) });
    tokens.push({
      kind: match[1] === undefined ? 'strong' : 'code',
      text: match[1] ?? match[2]!,
    });
    cursor = index + match[0].length;
  }
  if (cursor < text.length)
    tokens.push({ kind: 'text', text: text.slice(cursor) });
  return tokens;
}
const listLine = (line: string) =>
  line.match(/^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/);
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
const heading = (line: string) => line.match(/^\s*#{1,6}\s+(.+)$/);
const fence = (line: string) => /^\s*```/.test(line);
export function parseMessageMarkdown(text: string): MessageBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MessageBlock[] = [];
  const isTable = (index: number) => {
    if (!lines[index]?.includes('|') || !lines[index + 1]) return false;
    const columns = cells(lines[index]!);
    const separator = cells(lines[index + 1]!);
    return (
      columns.length > 1 &&
      columns.length === separator.length &&
      separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    );
  };
  const isStart = (index: number) =>
    fence(lines[index]!) ||
    heading(lines[index]!) ||
    listLine(lines[index]!) ||
    isTable(index);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (fence(line)) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !fence(lines[index]!))
        content.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', text: content.join('\n') });
      continue;
    }
    const title = heading(line);
    if (title) {
      blocks.push({ kind: 'heading', text: title[1]! });
      index += 1;
      continue;
    }
    if (isTable(index)) {
      const header = cells(line),
        rows: string[][] = [];
      index += 2;
      while (
        index < lines.length &&
        lines[index]!.trim() &&
        lines[index]!.includes('|')
      )
        rows.push(cells(lines[index++]!));
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const list = listLine(line);
    if (list) {
      const ordered = list[1] !== undefined,
        items: string[] = [];
      while (index < lines.length) {
        const item = listLine(lines[index]!);
        if (!item || (item[1] !== undefined) !== ordered) break;
        items.push(item[2]!);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !isStart(index))
      paragraph.push(lines[index++]!);
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}
