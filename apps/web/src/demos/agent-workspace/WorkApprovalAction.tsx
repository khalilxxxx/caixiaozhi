import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  acceptWorkspace,
  type WorkspaceSnapshot,
} from './runtime-client';
import { Button } from './ui';
import { useWorkspace } from './workspace';
import type { WorkDocument } from './work-document-model';
import {
  WorkApprovalDialog,
  WorkApprovalOutcomeUnknown,
  type WorkApprovalDecision,
} from './WorkApprovalDialog';

interface DecisionContext {
  expectedVersion: number;
  reviewHash: string;
  items: { id: string; title: string; detail: string }[];
  requiresReview: boolean;
  hardBlockReasons: string[];
  unavailableReason?: string;
  availableActions: WorkApprovalDecision[];
}

interface DecisionRequest {
  decision: WorkApprovalDecision;
  reason: string;
  expectedVersion: number;
  idempotencyKey: string;
  reviewAck: { reviewHash: string; findingIds: string[] };
}

interface DecisionResponse {
  document: WorkDocument;
  decision: NonNullable<WorkDocument['decision']>;
  workspace: WorkspaceSnapshot;
}

function readUnconfirmed(key: string): DecisionRequest | null {
  try {
    const request = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      request &&
      ['approve', 'return'].includes(request.decision) &&
      typeof request.reason === 'string' &&
      Number.isInteger(request.expectedVersion) &&
      typeof request.idempotencyKey === 'string' &&
      typeof request.reviewAck?.reviewHash === 'string' &&
      Array.isArray(request.reviewAck.findingIds)
    )
      return request;
  } catch {}
  return null;
}

export function WorkApprovalAction({
  document: doc,
}: {
  document: WorkDocument;
}) {
  const workspace = useWorkspace();
  const path = '/business/work-documents/' + encodeURIComponent(doc.id);
  const storageKey = 'cx.work.pending-decision.' + doc.id;
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<DecisionContext | null>(null);
  const [contextError, setContextError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [unconfirmed, setUnconfirmed] = useState(() =>
    readUnconfirmed(storageKey),
  );

  function remember(request: DecisionRequest | null) {
    setUnconfirmed(request);
    try {
      if (request) sessionStorage.setItem(storageKey, JSON.stringify(request));
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }

  useEffect(() => {
    if (doc.decision) {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
    }
  }, [doc.decision, storageKey]);

  useEffect(() => {
    if (!open || doc.decision) return;
    let active = true;
    setContext(null);
    setContextError('');
    api<DecisionContext>(path + '/decision-context')
      .then((value) => {
        if (!active) return;
        if (value.expectedVersion !== doc.version) {
          setContextError('单据版本已更新，请核对最新内容后再审批。');
          void workspace.refresh().catch(() => {});
        } else setContext(value);
      })
      .catch((error) => {
        if (!active) return;
        setContextError(error.message);
        if (error instanceof ApiError && error.status === 409)
          void workspace.refresh().catch(() => {});
      });
    return () => {
      active = false;
    };
  }, [open, path, attempt, doc.version, doc.decision]);

  async function submit(decision: WorkApprovalDecision, comment: string) {
    if (
      !unconfirmed &&
      (!context || !context.availableActions.includes(decision))
    )
      throw new Error('当前单据无法执行这项审批，请重新读取办理状态。');
    const request: DecisionRequest = unconfirmed ?? {
      decision,
      reason: comment,
      expectedVersion: context!.expectedVersion,
      idempotencyKey: crypto.randomUUID(),
      reviewAck: {
        reviewHash: context!.reviewHash,
        findingIds: context!.items.map((item) => item.id),
      },
    };
    // Preserve the exact request until a definitive receipt, including across a reload.
    remember(request);
    let receipt: DecisionResponse;
    try {
      receipt = await api<DecisionResponse>(path + '/decision', request);
      if (
        receipt.document?.id !== doc.id ||
        receipt.decision?.decision !== request.decision ||
        typeof receipt.workspace?.revision !== 'number' ||
        !receipt.workspace?.state
      )
        throw new Error('未收到完整的审批回执。');
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status < 400 ||
        error.status >= 500 ||
        error.status === 408
      )
        throw new WorkApprovalOutcomeUnknown(
          '尚未收到审批回执。核对结果将使用同一笔审批请求。',
        );
      remember(null);
      if (error.status === 409) {
        setContext(null);
        setAttempt((value) => value + 1);
        void workspace.refresh().catch(() => {});
      }
      throw error;
    }
    remember(null);
    acceptWorkspace(receipt.workspace);
    setOpen(false);
    workspace.notify(
      request.decision === 'approve'
        ? '已同意，当前待办已办结。'
        : '已退回，当前待办已办结。',
    );
    requestAnimationFrame(() =>
      document.getElementById('panel-title')?.focus({ preventScroll: true }),
    );
  }

  return (
    <>
      <Button
        variant="primary"
        disabled={!!doc.decision}
        onClick={() => {
          setContext(null);
          setContextError('');
          setOpen(true);
        }}
      >
        {doc.decision
          ? doc.decision.decision === 'approve'
            ? '已同意'
            : '已退回'
          : '审批'}
      </Button>
      {open && !doc.decision && (
        <WorkApprovalDialog
          document={doc}
          loading={!context && !contextError && !unconfirmed}
          contextError={unconfirmed ? undefined : contextError}
          onRetryContext={() => setAttempt((value) => value + 1)}
          reviewItems={context?.items ?? []}
          reviewHash={context?.reviewHash}
          requiresReview={context?.requiresReview}
          availableActions={context?.availableActions}
          approveDisabledReason={
            context?.unavailableReason || context?.hardBlockReasons.join('；')
          }
          unresolved={
            unconfirmed && {
              decision: unconfirmed.decision,
              comment: unconfirmed.reason,
            }
          }
          onSubmit={submit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
