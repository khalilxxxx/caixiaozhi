import type { GenericDocument } from '../document-query/document-model';
import { WorkDocumentIcon } from './WorkDocumentIcon';
import { Badge, Icon } from './ui';
import { useWorkspace } from './workspace';
import { getDocumentProgress } from './document-progress';
import { businessTime } from './time-format';

function workflowNote(doc: GenericDocument) {
  if (
    doc.status === 'needs_action' ||
    (doc.status === 'closed' &&
      doc.steps.some((step) => step.status === 'returned'))
  ) {
    const reason =
      doc.details.find((field) => field.label === '退回原因')?.value ??
      [...doc.steps].reverse().find((step) => step.status === 'returned')?.note;
    if (reason) return { label: '退回意见', value: reason };
  }
  if (doc.paymentStatus && doc.phase === 'execution')
    return { label: '付款状态', value: doc.paymentStatus };
  if (doc.status !== 'processing') return undefined;
  const index = doc.steps.findIndex((step) => step.status === 'current');
  const next = index >= 0 ? doc.steps[index + 1] : undefined;
  if (next?.status === 'future')
    return { label: '下一环节', value: next.label };
  return undefined;
}

export function DocumentCard({
  document: doc,
  conversation = false,
  navigationIds,
}: {
  document: GenericDocument;
  conversation?: boolean;
  navigationIds: string[];
}) {
  const w = useWorkspace();
  const { node, actors, role, status, tone } = getDocumentProgress(doc);
  const active = doc.status === 'processing' || doc.status === 'needs_action';
  const finished = doc.status === 'completed' || doc.status === 'closed';
  const handled = finished
    ? [...doc.steps]
        .reverse()
        .find((step) => step.status === 'done' || step.status === 'returned')
    : undefined;
  const owner = actors.join('、');
  const secondary = active
    ? owner
      ? role + ' · ' + owner
      : role + '待确认'
    : handled?.time
      ? businessTime(handled.time)
      : '';
  const measure =
    doc.amount ?? doc.summary.find((field) => field.label === '请假时长');
  const note = conversation ? workflowNote(doc) : undefined;
  return (
    <article
      className={'dp-record' + (conversation ? ' dp-message-record' : '')}
    >
      <button
        className="dp-record-main"
        type="button"
        onClick={() =>
          w.openPanel({
            kind: 'document',
            title: doc.title,
            id: doc.key,
            data: { navigationIds },
          })
        }
      >
        <span className="dp-identity">
          <WorkDocumentIcon doc={doc} />
          <span className="dp-copy">
            <strong>{doc.title}</strong>
            <small>
              {doc.typeLabel} <i>·</i> {doc.id}
            </small>
          </span>
        </span>
        <span className={'dp-node dp-tone-' + tone}>
          <strong>{node}</strong>
          {secondary && <small>{secondary}</small>}
        </span>
        <span className="dp-measure">
          {measure ? (
            <>
              <strong>{measure.value}</strong>
              <small>{measure.label}</small>
            </>
          ) : (
            <span aria-label="无金额或时长">—</span>
          )}
        </span>
        <span className="dp-state">
          <Badge tone={tone}>{status}</Badge>
          <small>{doc.source.label}</small>
        </span>
        {conversation && (
          <span className="dp-card-foot">
            <span>
              {note && (
                <>
                  <b>{note.label}</b>
                  {note.value}
                </>
              )}
            </span>
            <span className="dp-open">
              查看详情 <Icon name="chevron" size={12} />
            </span>
          </span>
        )}
      </button>
      <button
        className="dp-attach"
        type="button"
        title="加入对话"
        aria-label={`将${doc.title}加入对话`}
        onClick={() => {
          w.attach({ kind: 'document', id: doc.key, title: doc.title });
        }}
      >
        <Icon name="link" size={15} />
      </button>
    </article>
  );
}
