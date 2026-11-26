import type { GenericDocument } from '../document-query/document-model';
import { getDocumentProgress, latestProgressNode } from './document-progress';
import { businessTime } from './time-format';
import { Badge, Icon } from './ui';
import './approval-flow.css';

export function ApprovalNodeCard({ document }: { document: GenericDocument }) {
  const node = latestProgressNode(document);
  const progress = getDocumentProgress(document);
  const current = node.status === 'current';
  const heading = current
    ? document.phase === 'approval' && document.status !== 'needs_action'
      ? '当前审批节点'
      : '当前办理节点'
    : '最近办理节点';
  const time = businessTime(node.time);
  const needsAction = document.status === 'needs_action';
  const reason = document.details?.find((field) => field.label === '退回原因')?.value;
  return (
    <section className="dp-node-card" aria-label="审批进展">
      <header>
        <h3>
          <Icon name={current ? 'clock' : 'tasks'} size={14} />
          {heading}
        </h3>
        <Badge tone={node.status === 'returned' ? 'warning' : progress.tone}>
          {progress.status}
        </Badge>
      </header>
      <strong>{node.label}</strong>
      {(node.actors.length > 0 || current || node.time) && (
        <div className="dp-node-meta">
          {node.actors.length ? (
            <span>
              {node.role}
              <b>{node.actors.join('、')}</b>
            </span>
          ) : (
            current && <span>{node.role}待确认</span>
          )}
          {node.time && (
            <time>{current && !time.endsWith('起') ? time + ' 起' : time}</time>
          )}
        </div>
      )}
      {needsAction && (
        <div className="dp-node-next">
          {reason && <p>退回原因：{reason}</p>}
          <p>请在{document.source.label}按原单号 {document.id} 继续办理。</p>
        </div>
      )}
    </section>
  );
}
