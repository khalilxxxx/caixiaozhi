import { useState } from 'react';
import { Button, Icon } from './ui';
import {
  fieldLabels,
  getExpenseCategories,
  getExpenseCategory,
  type ReceiptEvidence,
} from './submission-model';
import {
  assignBatchFile,
  editableGroups,
  groupAssignments,
  isUnreadable,
  type BatchExpense,
  type BatchFile,
  type EditableGroup,
  type ExpenseAssignment,
  type FileRole,
  type ReimbursementBatch,
} from './reimbursement-batch';

const labels: Record<string, string> = {
  ...fieldLabels,
  categoryId: '费用类型',
  name: '费用名称',
  purpose: '事由',
  invoiceNumber: '发票号码',
};

function canRetry(file: BatchFile) {
  return isUnreadable(file) || (file.extractionStatus === 'needs_review' && !file.recognition?.multipleDocuments);
}

function SourceFile({ file, label, onRetry }: { file: BatchFile; label: string; onRetry?: (id: string) => void }) {
  return (
    <li className="rb-source">
      <span>{label}</span>
      <a
        href={`/api/local/files/${encodeURIComponent(file.id)}/download`}
        target="_blank"
        rel="noreferrer"
      >
        {file.name}
        <Icon name="external" size={12} />
      </a>
      {onRetry && canRetry(file) && <Button variant="ghost" onClick={() => onRetry(file.id)}>重新识别</Button>}
    </li>
  );
}

export function ReceiptSources({
  evidence,
  files,
}: {
  evidence?: ReceiptEvidence;
  files: { id: string; name: string }[];
}) {
  const fields = Object.entries(evidence ?? {}).filter(
    ([, rows]) => rows.length,
  );
  if (!fields.length) return null;
  return (
    <details className="rb-evidence">
      <summary>原始票据依据</summary>
      <dl>
        {fields.map(([field, rows]) => (
          <div key={field}>
            <dt>{labels[field] ?? field}</dt>
            <dd>
              {rows.map(({ fileId, quote }, i) => (
                <span key={i}>
                  {quote}{' '}
                  <small>
                    {files.find((file) => file.id === fileId)?.name}
                  </small>
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function GroupDetail({
  group,
  files,
  index,
  onRetry,
}: {
  group: BatchExpense;
  files: BatchFile[];
  index: number;
  onRetry?: (id: string) => void;
}) {
  const item = group.expense;
  const category = getExpenseCategory(item.categoryId);
  const amount = item.amount
    ? [item.currency, item.amount].filter(Boolean).join(' ')
    : '金额待补充';
  return (
    <details className="rb-expense">
      <summary>
        <span className="rb-summary-text">
          <strong>{item.name || category?.label || `费用 ${index + 1}`}</strong>
          <small>
            {[
              category?.label || '费用类型待确认',
              item.date || item.checkIn || item.departureDate,
              group.invoiceFileIds.length
                ? `${group.invoiceFileIds.length} 张发票`
                : '',
              group.attachmentFileIds.length
                ? `${group.attachmentFileIds.length} 份附件`
                : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </span>
        {group.issues.length > 0 && (
          <span
            className="rb-attention"
            title={group.issues.join(' ')}
            aria-label="待补充或核对"
          >
            <Icon name="alert" size={14} />
          </span>
        )}
        <strong className="rb-amount">{amount}</strong>
        <Icon name="down" size={15} />
      </summary>
      <div className="rb-detail">
        {!!group.issues.length && (
          <div className="rb-issues">
            {group.issues.map((issue, i) => (
              <p key={i}>{issue}</p>
            ))}
          </div>
        )}
        <ul className="rb-file-list">
          {files
            .filter(
              (file) =>
                group.invoiceFileIds.includes(file.id) ||
                group.attachmentFileIds.includes(file.id),
            )
            .map((file) => (
              <SourceFile
                key={file.id}
                file={file}
                onRetry={onRetry}
                label={group.invoiceFileIds.includes(file.id) ? '发票' : '附件'}
              />
            ))}
        </ul>
        <ReceiptSources evidence={group.evidence} files={files} />
      </div>
    </details>
  );
}

const unsavedGroups = new Map<
  string,
  { revision: number; groups: EditableGroup[] }
>();

export function hasPendingReceiptGroups(batch: ReimbursementBatch) {
  return (
    batch.status === 'review' &&
    unsavedGroups.get(batch.id)?.revision === batch.revision
  );
}

function GroupEditor({
  batch,
  disabled,
  onSave,
  onCancel,
}: {
  batch: ReimbursementBatch;
  disabled: boolean;
  onSave: (value: ExpenseAssignment[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [groups, updateGroups] = useState(() => {
    const saved = unsavedGroups.get(batch.id);
    return saved?.revision === batch.revision
      ? saved.groups
      : editableGroups(batch);
  });
  function setGroups(next: EditableGroup[]) {
    unsavedGroups.set(batch.id, { revision: batch.revision, groups: next });
    updateGroups(next);
  }
  const files = batch.files.filter(
    (file) =>
      !batch.unavailableFileIds?.includes(file.id) &&
      !isUnreadable(file) &&
      file.status !== 'duplicate',
  );
  const attachmentOnly = groups.some((group) => !group.invoiceFileIds.length);
  const categories = getExpenseCategories(batch.draftId);
  const groupName = (group: EditableGroup, index: number) => {
    const id = group.invoiceFileIds[0] ?? group.attachmentFileIds[0];
    return `费用 ${index + 1} · ${batch.files.find((file) => file.id === id)?.name || '新费用'}`;
  };
  return (
    <fieldset disabled={disabled} className="rb-editor">
      <legend className="dw-sr">调整票据归属和费用类型</legend>
      {files.map((file) => {
        const group = groups.find(
          (g) =>
            g.invoiceFileIds.includes(file.id) ||
            g.attachmentFileIds.includes(file.id),
        );
        const role: FileRole = group
          ? group.invoiceFileIds.includes(file.id)
            ? 'invoiceFileIds'
            : 'attachmentFileIds'
          : file.recognition?.role === 'invoice'
            ? 'invoiceFileIds'
            : 'attachmentFileIds';
        return (
          <div className="rb-assignment" key={file.id}>
            <div className="rb-assignment-source">
              <a
                href={`/api/local/files/${encodeURIComponent(file.id)}/download`}
                target="_blank"
                rel="noreferrer"
              >
                {file.name}
              </a>
              {file.recognition?.facts && (
                <small>
                  {[
                    file.recognition.facts.merchant,
                    file.recognition.facts.date,
                    typeof file.recognition.facts.amount === 'number'
                      ? [
                          file.recognition.facts.currency,
                          (file.recognition.facts.amount / 100).toFixed(2),
                        ]
                          .filter(Boolean)
                          .join(' ')
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              )}
            </div>
            <label>
              所属费用
              <select
                value={group?.id ?? ''}
                onChange={(e) => {
                  const target =
                    e.target.value === 'new'
                      ? crypto.randomUUID()
                      : e.target.value;
                  setGroups(assignBatchFile(groups, file.id, target, role));
                }}
              >
                <option value="">本次不计入</option>
                {groups.map((g, i) => (
                  <option value={g.id} key={g.id}>
                    {groupName(g, i)}
                  </option>
                ))}
                <option
                  value="new"
                  disabled={['payment', 'supporting'].includes(
                    file.recognition?.role ?? '',
                  )}
                >
                  单独作为一笔费用
                </option>
              </select>
            </label>
            <label>
              材料用途
              <select
                value={role}
                disabled={
                  !group ||
                  (!!file.recognition?.role &&
                    file.recognition.role !== 'unknown')
                }
                onChange={(e) => {
                  if (group)
                    setGroups(
                      assignBatchFile(
                        groups,
                        file.id,
                        group.id,
                        e.target.value as FileRole,
                      ),
                    );
                }}
              >
                <option value="invoiceFileIds">发票</option>
                <option value="attachmentFileIds">附件</option>
              </select>
            </label>
          </div>
        );
      })}
      {groups.map((group, i) => (
        <label key={group.id} className="rb-category">
          <span>费用 {i + 1} 的类型</span>
          <select
            value={group.categoryId ?? ''}
            onChange={(e) =>
              setGroups(
                groups.map((g) =>
                  g.id === group.id ? { ...g, categoryId: e.target.value } : g,
                ),
              )
            }
          >
            <option value="">按票据匹配</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.group}／{category.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {attachmentOnly && (
        <p className="rb-issues">
          每笔费用至少需一张发票，请将附件归入对应费用。
        </p>
      )}
      <div className="rb-controls">
        <Button
          onClick={() => {
            unsavedGroups.delete(batch.id);
            onCancel();
          }}
        >
          取消
        </Button>
        <Button
          disabled={attachmentOnly}
          variant="primary"
          onClick={async () => {
            if (await onSave(groupAssignments(groups)))
              unsavedGroups.delete(batch.id);
          }}
        >
          保存分组
        </Button>
      </div>
    </fieldset>
  );
}

export function ReimbursementBatchReview({
  batch,
  disabled,
  editing,
  setEditing,
  onReview,
}: {
  batch: ReimbursementBatch;
  disabled: boolean;
  editing: boolean;
  setEditing: (v: boolean) => void;
  onReview: (body: {
    assignments?: ExpenseAssignment[];
    retryFileIds?: string[];
  }) => Promise<boolean>;
}) {
  const skipped = batch.files.filter((file) =>
    batch.unassignedFileIds.includes(file.id),
  );
  const canEdit =
    batch.status === 'review' &&
    batch.files.some(
      (f) =>
        !batch.unavailableFileIds?.includes(f.id) &&
        !isUnreadable(f) &&
        f.status !== 'duplicate',
    );
  return (
    <section className="rb-section">
      <header>
        <h3>
          费用明细 <span>{batch.groups.length} 笔</span>
        </h3>
        {canEdit && !editing && (
          <Button
            variant="ghost"
            icon="edit"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            调整分组
          </Button>
        )}
      </header>
      {editing ? (
        <GroupEditor
          batch={batch}
          disabled={disabled}
          onCancel={() => setEditing(false)}
          onSave={async (assignments) => {
            const ok = await onReview({ assignments });
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : (
        <>
          {batch.groups.map((group, index) => (
            <GroupDetail
              key={group.id}
              group={group}
              index={index}
              files={batch.files}
              onRetry={batch.status === 'review' && !disabled ? (id) => void onReview({ retryFileIds: [id] }) : undefined}
            />
          ))}
          {skipped.length > 0 && (
            <div className="rb-skipped">
              <h4>
                未计入费用 <span>{skipped.length} 份</span>
              </h4>
              {skipped.map((file) => (
                <div key={file.id} className="rb-skipped-file">
                  <div>
                    <a
                      href={`/api/local/files/${encodeURIComponent(file.id)}/download`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {file.name}
                    </a>
                    <small>
                      {batch.unassignedReasons?.[file.id] ||
                        file.extractionError ||
                        file.error ||
                        '请核对材料归属'}
                    </small>
                    {file.recognition?.reviewIssues
                      ?.filter(
                        (issue) =>
                          issue.message !== batch.unassignedReasons?.[file.id],
                      )
                      .map((issue, i) => (
                        <small key={i}>{issue.message}</small>
                      ))}
                  </div>
                  {batch.status === 'review' && canRetry(file) && (
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => void onReview({ retryFileIds: [file.id] })}
                    >
                      重新识别
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
