import { useState } from 'react';
import { messageInline, parseMessageMarkdown } from './message-markdown';
import { Icon } from './ui';
import './message-text.css';

const numericCellPattern =
  /^[+\-−]?\s*(?:[¥￥$€£]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|‰|元|万元|亿元|美元|亿美元|港元|欧元|天|晚|间夜|笔|张|次|项|人|份))?$/;

function isNumericCell(cell: string) {
  const cleaned = cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
  return cleaned.length > 0 && numericCellPattern.test(cleaned);
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {messageInline(text).map((token, index) =>
        token.kind === 'strong' ? (
          <strong key={index}>{token.text}</strong>
        ) : token.kind === 'code' ? (
          <code key={index}>{token.text}</code>
        ) : (
          token.text
        ),
      )}
    </>
  );
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="message-code-block">
      <button
        type="button"
        className="message-code-copy"
        aria-label={copied ? '已复制代码' : '复制代码'}
        title={copied ? '已复制' : '复制'}
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
          }).catch(() => {});
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        <span>{copied ? '已复制' : '复制'}</span>
      </button>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function MessageText({
  text,
  tableLabel = '回复中的表格',
  className = 'assistant-text',
  streaming = false,
}: {
  text: string;
  tableLabel?: string;
  className?: string;
  streaming?: boolean;
}) {
  return (
    <div
      className={`${className} message-markdown${streaming ? ' is-streaming' : ''}`}
    >
      {parseMessageMarkdown(text).map((block, index) => {
        if (block.kind === 'table') {
          const numericCols = block.header.map((_, column) =>
            block.rows.length > 0 &&
            block.rows.every((row) => {
              const cell = row[column]?.trim() ?? '';
              return !cell || cell === '—' || cell === '-' || isNumericCell(cell);
            }),
          );
          return (
            <div
              key={index}
              className="message-table-scroll"
              tabIndex={0}
              role="region"
              aria-label={tableLabel}
            >
              <table>
                <thead>
                  <tr>
                    {block.header.map((cell, column) => (
                      <th
                        key={column}
                        className={numericCols[column] ? 'is-numeric' : undefined}
                      >
                        <Inline text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, column) => (
                        <td
                          key={column}
                          className={
                            numericCols[column] ? 'is-numeric' : undefined
                          }
                        >
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Inline text={item} />
                </li>
              ))}
            </Tag>
          );
        }
        if (block.kind === 'blockquote')
          return (
            <blockquote key={index}>
              <Inline text={block.text} />
            </blockquote>
          );
        if (block.kind === 'hr') return <hr key={index} />;
        if (block.kind === 'code')
          return <CodeBlock key={index} text={block.text} />;
        if (block.kind === 'heading')
          return (
            <h3 key={index}>
              <Inline text={block.text} />
            </h3>
          );
        return (
          <p key={index}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
