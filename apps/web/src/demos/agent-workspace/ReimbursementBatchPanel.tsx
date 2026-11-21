import { useEffect, useRef, useState } from 'react';
import {
  acceptWorkspace,
  api,
  ApiError,
  uploadFile,
  type WorkspaceSnapshot,
} from './runtime-client';
import { useWorkspace, type PanelSpec } from './workspace';
import { readSubmissionState } from './submission-state';
import { getDraftType, type SubmissionDraft } from './submission-model';
import type { MaterialFile } from './material-import';
import type {
  ExpenseAssignment,
  ReimbursementBatch,
} from './reimbursement-batch';
import { Button, Icon } from './ui';
import {
  hasPendingReceiptGroups,
  ReimbursementBatchReview,
} from './ReimbursementBatchReview';
import './reimbursement-batch.css';

type BatchResponse = {
  batch: ReimbursementBatch;
  workspace?: WorkspaceSnapshot;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
const batchLimit = 30;
// A drawer may close while the server is still reading a large batch.
const pendingOperations = new Map<string, Promise<void>>();
const sameFiles = (batch: ReimbursementBatch, ids: string[]) =>
  batch.files.length === ids.length &&
  batch.files.every((file) => ids.includes(file.id));

export function ReimbursementBatchPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace();
  const draftId: string = panel.data!.draftId;
  const submissions = readSubmissionState(w.state.data);
  const draft = submissions.edits[draftId] ?? submissions.drafts[draftId];
  const path = `/reimbursements/${encodeURIComponent(draftId)}/batches`;
  const pinnedId: string | undefined = panel.data?.reimbursementBatchId;
  const startingIds: string[] = panel.data?.reimbursementFileIds ?? [];
  const [batch, setBatch] = useState<ReimbursementBatch | null>(null);
  const [editing, setEditing] = useState(false);
  const [progress, setProgress] = useState(
    typeof window === 'undefined' ? '' : '读取批次中…',
  );
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const [failedUploads, setFailedUploads] = useState<
    Array<{ file: File; error: string }>
  >([]);
  const [includeHeader, setIncludeHeader] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const readOnly = draft?.status !== 'draft';
  const isReview = batch?.status === 'review';
  const unavailable = !!progress || readOnly;
  const draftFiles = new Set(
    (draft?.expenses ?? []).flatMap((item) =>
      [...item.files, ...item.attachments].map((file) => file.id),
    ),
  );
  const materialFiles: MaterialFile[] = w.state.data.materials?.files ?? [];
  const available = materialFiles.filter(
    (file) =>
      file.id.startsWith('file-') &&
      file.status !== 'duplicate' &&
      !draftFiles.has(file.id) &&
      !(isReview && batch.files.some((current) => current.id === file.id)),
  );

  function receive(result: BatchResponse) {
    if (result.workspace) acceptWorkspace(result.workspace);
    if (mounted.current) {
      setBatch(result.batch);
      setEditing(hasPendingReceiptGroups(result.batch));
      setSelection([]);
      setPendingFiles([]);
    }
  }

  async function recoverConflict(error: unknown) {
    if (error instanceof ApiError && error.status === 409 && batch) {
      const result = await api<BatchResponse>(
        `${path}/${encodeURIComponent(batch.id)}`,
      );
      receive(result);
      if (
        result.batch.status === 'review' &&
        result.batch.revision === batch.revision &&
        ['BATCH_CONFLICT', 'MATERIAL_CONFLICT'].includes(error.payload?.code)
      ) {
        receive(
          await api<BatchResponse>(
            `${path}/${encodeURIComponent(batch.id)}/review`,
            { revision: result.batch.revision },
          ),
        );
      }
      if (mounted.current) setEditing(false);
    }
  }

  async function run(
    label: string,
    operation: () => Promise<void>,
    track = true,
  ) {
    if (locked.current) return false;
    locked.current = true;
    setError('');
    setProgress(label);
    const task = w.flush().then(operation);
    if (track) pendingOperations.set(draftId, task);
    try {
      await task;
      return true;
    } catch (cause) {
      await recoverConflict(cause).catch(() => undefined);
      if (mounted.current) setError(message(cause));
      return false;
    } finally {
      if (pendingOperations.get(draftId) === task)
        pendingOperations.delete(draftId);
      locked.current = false;
      if (mounted.current) setProgress('');
    }
  }

  async function load() {
    const pending = pendingOperations.get(draftId);
    return run(
      pending ? '等待本单票据处理完成…' : '读取批次中…',
      async () => {
        await pending?.catch(() => undefined);
        const result = await api<{ batch: ReimbursementBatch | null }>(
          `${path}/${pinnedId ? encodeURIComponent(pinnedId) : 'latest'}`,
        );
        if (
          startingIds.length &&
          !pinnedId &&
          !readOnly &&
          (!result.batch || !sameFiles(result.batch, startingIds))
        ) {
          if (mounted.current) setProgress('正在识别票据并分组…');
          receive(await api<BatchResponse>(path, { fileIds: startingIds }));
        } else if (mounted.current) {
          setBatch(result.batch);
          setEditing(!!result.batch && hasPendingReceiptGroups(result.batch));
        }
      },
      startingIds.length > 0,
    );
  }

  useEffect(() => {
    mounted.current = true;
    if (draft) void load();
    return () => {
      mounted.current = false;
    };
  }, [path, pinnedId, !!draft]);

  function returnToDraft() {
    w.openPanel({
      kind: 'submission',
      id: draftId,
      title: getDraftType(draftId) === 'personal' ? '个人费用报销' : '差旅报销',
      data: { view: 'edit' },
    });
  }

  async function prepare(files: File[], existingIds: string[] = []) {
    if (readOnly || editing) return;
    const previous = isReview ? batch.files.map((file) => file.id) : [];
    const ids = new Set([...previous, ...existingIds]);
    if (ids.size + files.length > batchLimit) {
      setError(`每批最多 ${batchLimit} 份材料，请减少本次选择的文件。`);
      return;
    }
    await run('正在准备材料…', async () => {
      const failed: Array<{ file: File; error: string }> = [];
      for (const [index, file] of files.entries()) {
        if (mounted.current)
          setProgress(`正在上传 ${index + 1}/${files.length}…`);
        try {
          const result = await uploadFile(file);
          ids.add(result.file.id);
        } catch (cause) {
          failed.push({ file, error: message(cause) });
        }
      }
      if (mounted.current)
        setFailedUploads((old) => [
          ...old.filter((row) => !files.includes(row.file)),
          ...failed,
        ]);
      if (files.length) await w.refresh();
      if (![...ids].some((id) => !previous.includes(id))) return;
      if (mounted.current) {
        setPendingFiles([...ids].filter((id) => !previous.includes(id)));
        setProgress(`正在识别并归集 ${ids.size} 份材料…`);
      }
      receive(
        await api<BatchResponse>(path, {
          fileIds: [...ids],
          previousBatchId: isReview ? batch.id : undefined,
        }),
      );
    });
  }

  async function review(body: {
    assignments?: ExpenseAssignment[];
    retryFileIds?: string[];
  }) {
    if (!batch || readOnly) return false;
    return run(
      body.retryFileIds ? '正在重新识别…' : '正在重新匹配费用…',
      async () => {
        receive(
          await api<BatchResponse>(
            `${path}/${encodeURIComponent(batch.id)}/review`,
            { revision: batch.revision, ...body },
          ),
        );
      },
    );
  }

  function apply() {
    if (!batch || editing || readOnly || !batch.groups.length) return;
    void run('正在生成费用…', async () => {
      const result = await api<BatchResponse & { draft: SubmissionDraft }>(
        `${path}/${encodeURIComponent(batch.id)}/apply`,
        {
          revision: batch.revision,
          includeHeader,
        },
      );
      receive(result);
      if (!result.workspace) await w.refresh();
      w.notify(
        `已向${result.draft.documentNumber || '当前报销单'}写入 ${result.batch.groups.length} 笔费用`,
      );
      if (mounted.current) returnToDraft();
    });
  }

  if (!draft)
    return (
      <div className="rb-panel">
        <p role="alert">未找到这张报销单。</p>
        <Button
          onClick={() => {
            w.closePanel();
            w.navigate('submission');
          }}
        >
          返回智能提单
        </Button>
      </div>
    );
  const suggestedPurpose = draft.purpose.trim() ? '' : batch?.header.purpose;
  const suggestedActivities = (batch?.header.activities ?? []).filter(
    (activity) =>
      !draft?.activities.some(
        (row) =>
          (!!activity.activityNumber &&
            activity.activityNumber === row.activityNumber) ||
          (!!activity.oaNumber && activity.oaNumber === row.oaNumber) ||
          (!activity.activityNumber &&
            !activity.oaNumber &&
            !!activity.description &&
            activity.description === row.description),
      ),
  );
  const haveHeader = !!(suggestedPurpose || suggestedActivities.length);
  return (
    <div className="rb-panel">
      <div className="rb-toolbar">
        <Button variant="ghost" icon="back" onClick={returnToDraft}>
          返回报销单
        </Button>
        {draft?.documentNumber && <span>草稿单号 {draft.documentNumber}</span>}
      </div>
      {readOnly && <p className="rb-muted">本单已提交。</p>}
      {!readOnly && !editing && (
        <section className="rb-section">
          <header>
            <h3>发票与附件</h3>
            <input
              ref={input}
              type="file"
              multiple
              className="dw-sr"
              tabIndex={-1}
              aria-label="批量上传发票与附件"
              accept=".png,.jpg,.jpeg,.webp,.pdf,.txt"
              disabled={unavailable}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                if (files.length) void prepare(files);
              }}
            />
            <Button
              variant={batch ? 'ghost' : 'primary'}
              icon="upload"
              disabled={unavailable}
              onClick={() => input.current?.click()}
            >
              {isReview ? '补传票据和附件' : '上传票据和附件'}
            </Button>
          </header>
          {!batch && !progress && (
            <p className="rb-muted">
              {draftFiles.size ? '暂无待转换的票据' : '本单暂无票据'}
            </p>
          )}
          {available.length > 0 && (
            <details className="rb-picker">
              <summary>选择已有材料</summary>
              <fieldset disabled={unavailable}>
                {available.map((file) => (
                  <label key={file.id}>
                    <input
                      type="checkbox"
                      checked={selection.includes(file.id)}
                      onChange={(e) =>
                        setSelection(
                          e.target.checked
                            ? [...selection, file.id]
                            : selection.filter((id) => id !== file.id),
                        )
                      }
                    />
                    {file.name}
                  </label>
                ))}
              </fieldset>
              <Button
                disabled={unavailable || !selection.length}
                onClick={() => void prepare([], selection)}
              >
                {isReview ? '加入本批' : '识别所选材料'}
              </Button>
            </details>
          )}
        </section>
      )}
      {failedUploads.length > 0 && (
        <div className="rb-error">
          <ul>
            {failedUploads.map(({ file, error }, i) => (
              <li key={i}>
                {file.name} · {error}
              </li>
            ))}
          </ul>
          <Button
            disabled={unavailable || editing}
            onClick={() => void prepare(failedUploads.map((row) => row.file))}
          >
            重试上传
          </Button>
        </div>
      )}
      {progress && (
        <p className="rb-status" role="status">
          {progress}
        </p>
      )}
      {error && (
        <div className="rb-error" role="alert">
          <span>{error}</span>
          {(!batch || pendingFiles.length > 0) && (
            <Button
              disabled={!!progress}
              variant="ghost"
              onClick={() =>
                pendingFiles.length
                  ? void prepare([], pendingFiles)
                  : void load()
              }
            >
              重试
            </Button>
          )}
        </div>
      )}
      {batch && (
        <>
          <ReimbursementBatchReview
            key={batch.id}
            batch={batch}
            editing={editing}
            setEditing={setEditing}
            disabled={unavailable}
            onReview={review}
          />
          {isReview && !editing && haveHeader && !readOnly && (
            <section className="rb-section rb-header">
              <label>
                <input
                  type="checkbox"
                  checked={includeHeader}
                  disabled={unavailable}
                  onChange={(e) => setIncludeHeader(e.target.checked)}
                />
                根据票据补全报销单
              </label>
              {suggestedPurpose && (
                <p>
                  <span>事由</span>
                  {suggestedPurpose}
                </p>
              )}
              {suggestedActivities.map((activity, i) => (
                <p key={activity.id || i}>
                  <span>活动／派工</span>
                  {[
                    activity.activityNumber || activity.oaNumber,
                    activity.description,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ))}
            </section>
          )}
          {!editing && (
            <div className="rb-footer">
              {batch.status === 'applied' ? (
                <>
                  <span>
                    <Icon name="check" size={15} />
                    已生成 {batch.groups.length} 笔费用
                  </span>
                  <Button onClick={returnToDraft}>查看报销单</Button>
                </>
              ) : (
                <>
                  <span>
                    {batch.unassignedFileIds.length
                      ? `${batch.unassignedFileIds.length} 份材料未计入`
                      : ''}
                  </span>
                  <Button
                    variant="primary"
                    disabled={unavailable || !batch.groups.length}
                    onClick={apply}
                  >
                    生成 {batch.groups.length} 笔费用
                  </Button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
