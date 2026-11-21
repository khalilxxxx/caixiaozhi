import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Button, Icon } from './ui';
import { WorkDocumentIcon } from './WorkDocumentIcon';
import { workDocumentTitle, type WorkDocument } from './work-document-model';
import './work-approval-dialog.css';

export type WorkApprovalDecision = 'approve' | 'return';
type ReviewItem = { id: string; title: string; detail: string };

export class WorkApprovalOutcomeUnknown extends Error {}

interface WorkApprovalDialogProps {
  document: WorkDocument;
  reviewItems: readonly ReviewItem[];
  availableActions?: readonly WorkApprovalDecision[];
  requiresReview?: boolean;
  reviewHash?: string;
  approveDisabledReason?: string;
  loading?: boolean;
  contextError?: string;
  onRetryContext?: () => void;
  unresolved?: { decision: WorkApprovalDecision; comment: string } | null;
  onSubmit: (decision: WorkApprovalDecision, comment: string) => Promise<void>;
  onClose: () => void;
}

const labels = { approve: '同意', return: '退回' } as const;

export function WorkApprovalDialog({
  document: doc,
  reviewItems,
  availableActions,
  requiresReview = reviewItems.length > 0,
  reviewHash,
  approveDisabledReason,
  loading = false,
  contextError,
  onRetryContext,
  unresolved,
  onSubmit,
  onClose,
}: WorkApprovalDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sending = useRef(false);
  const mounted = useRef(false);
  const evidenceKey = reviewHash ?? JSON.stringify([doc.version, reviewItems]);
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
  const [decision, setDecision] = useState<WorkApprovalDecision | null>(
    unresolved?.decision ?? null,
  );
  const [comment, setComment] = useState(unresolved?.comment ?? '');
  const [pending, setPending] = useState(false);
  const [unknown, setUnknown] = useState(Boolean(unresolved));
  const [error, setError] = useState('');
  const dataReady = !loading && !contextError;
  const locked = pending || unknown || !dataReady;
  const acknowledged = acknowledgedKey === evidenceKey || unknown;
  const required = decision === 'return' || requiresReview;
  const canChoose = (action: WorkApprovalDecision) =>
    (availableActions?.includes(action) ?? true) &&
    !(action === 'approve' && approveDisabledReason);
  const valid =
    !!decision &&
    dataReady &&
    canChoose(decision) &&
    (!requiresReview || acknowledged) &&
    (!required || !!comment.trim());

  useLayoutEffect(() => {
    const element = dialog.current;
    const origin = window.document.activeElement;
    mounted.current = true;
    element?.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      element?.close();
      if (origin instanceof HTMLElement && origin.isConnected) {
        const container = origin.closest('dialog');
        if (!container || container.open) origin.focus({ preventScroll: true });
      }
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decision || sending.current || (!unknown && !valid)) return;
    sending.current = true;
    setPending(true);
    setError('');
    try {
      await onSubmit(decision, comment.trim());
      if (mounted.current) onClose();
    } catch (cause) {
      if (!mounted.current) return;
      const unconfirmed = cause instanceof WorkApprovalOutcomeUnknown;
      setUnknown(unconfirmed);
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : '暂时无法取得审批结果。',
      );
    } finally {
      sending.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="work-approval-dialog"
      aria-labelledby={id + '-title'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!sending.current) onClose();
      }}
    >
      <form onSubmit={submit} aria-busy={pending || loading}>
        <header className="wa-heading">
          <h2 id={id + '-title'} ref={heading} tabIndex={-1}>
            审批结果
          </h2>
          <button
            type="button"
            className="wa-close"
            aria-label="关闭审批结果"
            disabled={pending}
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="wa-body">
          <div className="wa-document">
            <WorkDocumentIcon doc={doc} />
            <div>
              <strong>{workDocumentTitle(doc)}</strong>
              <p>{doc.id}</p>
            </div>
          </div>
          {loading && !unknown && (
            <p className="wa-feedback" role="status">
              正在读取审批信息…
            </p>
          )}
          {contextError && !unknown && (
            <div className="wa-feedback wa-alert" role="alert">
              <span>{contextError}</span>
              {onRetryContext && (
                <button type="button" onClick={onRetryContext}>
                  重新加载
                </button>
              )}
            </div>
          )}
          {(dataReady || unknown) && (
            <>
              <fieldset className="wa-choices" disabled={locked}>
                <legend>办理结果</legend>
                {(['approve', 'return'] as const).map((action) => (
                  <label key={action}>
                    <input
                      type="radio"
                      name={id + '-decision'}
                      value={action}
                      checked={decision === action}
                      disabled={!canChoose(action)}
                      onChange={() => {
                        setDecision(action);
                        setError('');
                      }}
                    />
                    <span>{labels[action]}</span>
                  </label>
                ))}
              </fieldset>
              {approveDisabledReason && !unknown && (
                <p className="wa-restriction">{approveDisabledReason}</p>
              )}
              {requiresReview && (
                <section
                  className="wa-evidence"
                  aria-labelledby={id + '-evidence'}
                >
                  <h3 id={id + '-evidence'}>审查依据</h3>
                  {reviewItems.length > 0 && (
                    <ul>
                      {reviewItems.map((item) => (
                        <li key={item.id}>
                          <strong>{item.title}</strong>
                          {item.detail && <p>{item.detail}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={locked}
                      onChange={(event) => {
                        setAcknowledgedKey(
                          event.target.checked ? evidenceKey : null,
                        );
                        setError('');
                      }}
                    />
                    已核对以上审查依据
                  </label>
                </section>
              )}
              <div className="wa-comment">
                <label htmlFor={id + '-comment'}>
                  {decision === 'return' ? '退回原因' : '审批意见'}
                  <small>{required ? '必填' : '选填'}</small>
                </label>
                <textarea
                  id={id + '-comment'}
                  rows={3}
                  placeholder="最多 1000 字"
                  value={comment}
                  maxLength={1000}
                  required={required}
                  disabled={locked}
                  onChange={(event) => {
                    setComment(event.target.value);
                    setError('');
                  }}
                />
                {decision === 'return' && <p>退回后将结束本次待办。</p>}
              </div>
            </>
          )}
          {(error || unknown) && (
            <p className="wa-feedback wa-alert" role="alert">
              <Icon name="alert" size={16} />
              <span>{error || '上次审批的办理结果待核实，请核对结果。'}</span>
            </p>
          )}
        </div>
        <footer className="wa-footer">
          <Button onClick={onClose} disabled={pending}>
            {unknown ? '关闭' : '取消'}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || (!unknown && !valid)}
          >
            {pending
              ? unknown
                ? '核对中…'
                : '提交中…'
              : unknown
                ? '核对结果'
                : '提交审批'}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
