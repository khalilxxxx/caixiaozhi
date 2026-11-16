import { messageInline, parseMessageMarkdown } from './message-markdown';
import './message-text.css';

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
export function MessageText({ text }: { text: string }) {
  return (
    <div className="assistant-text message-markdown">
      {parseMessageMarkdown(text).map((block, index) => {
        if (block.kind === 'table')
          return (
            <div
              key={index}
              className="message-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="回复中的表格"
            >
              <table>
                <thead>
                  <tr>
                    {block.header.map((cell, column) => (
                      <th key={column}>
                        <Inline text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, column) => (
                        <td key={column}>
                          <Inline text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
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
        if (block.kind === 'code')
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
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
