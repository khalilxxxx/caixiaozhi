import { useCallback, useEffect, useRef, useState } from 'react';
import type { Money } from '@caixiaozhi/contracts/common';
import type { FileView } from '@caixiaozhi/contracts/files';
import type { InvoiceFields } from '@caixiaozhi/contracts/expenses';
import { api, ApiFailure, formatMoney, uploadBytes } from '../../api.js';
import { Empty, ErrorNotice, Field, Status } from '../../ui.js';

export type InvoiceView = {
  id: string;
  version: number;
  file_id: string;
  fields: InvoiceFields;
  confirmation_state: string;
  verification_state: string;
};
const moneyText = (value: Money | null | undefined) =>
  value
    ? `${BigInt(value.amount_minor) / 100n}.${(BigInt(value.amount_minor) % 100n).toString().padStart(2, '0')}`
    : '';
export function MoneyInput({
  value,
  onChange,
  disabled = false,
  label = '金额（元）',
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
}: {
  value: Money | null | undefined;
  onChange: (money: Money | null) => void;
  disabled?: boolean;
  label?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  const [text, setText] = useState(() => moneyText(value));
  const last = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (value?.amount_minor !== last.current) setText(moneyText(value));
  }, [value?.amount_minor]);
  return (
    <input
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      type="text"
      inputMode="decimal"
      pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{0,2})?"
      placeholder="0.00"
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next === '') {
          last.current = null;
          onChange(null);
          return;
        }
        if (/^(?:0|[1-9]\d*)(?:\.\d{0,2})?$/.test(next)) {
          const [whole = '0', fraction = ''] = next.split('.');
          const amount = (
            BigInt(whole) * 100n +
            BigInt(fraction.padEnd(2, '0'))
          ).toString();
          last.current = amount;
          onChange({ amount_minor: amount, currency: 'CNY' });
        }
      }}
    />
  );
}
const expenseTypes = {
  transport: '交通',
  lodging: '住宿',
  meals: '餐饮',
  office: '办公',
  other: '其他',
};
export function InvoicePanel({
  onChanged,
  onSelect,
}: {
  onChanged: () => void;
  onSelect?: (invoice: InvoiceView) => void;
}) {
  const [items, setItems] = useState<InvoiceView[]>([]),
    [selected, setSelected] = useState<InvoiceView | null>(null),
    [fields, setFields] = useState<InvoiceFields | null>(null),
    [expenseType, setExpenseType] =
      useState<InvoiceFields['expense_type']>(null),
    [entertainment, setEntertainment] = useState(false);
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [uploaded, setUploaded] = useState<FileView | null>(null),
    [taskId, setTaskId] = useState<string | null>(null),
    [taskState, setTaskState] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const reload = useCallback(async () => {
    try {
      const result = await api<{ items: InvoiceView[] }>(
        '/expenses/invoices?limit=100',
      );
      setItems(result.items);
    } catch (failure) {
      setError(failure);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!taskId || taskState === 'completed' || taskState === 'failed') return;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const task = await api<{
          state: string;
          invoices: InvoiceView[];
          error_code: string | null;
        }>(`/expenses/ocr-tasks/${taskId}`);
        setTaskState(task.state);
        if (task.state === 'completed') {
          setNotice('识别已完成，请逐项核对字段后确认。');
          await reload();
          if (task.invoices[0]) choose(task.invoices[0]);
        } else if (task.state === 'failed')
          setNotice('识别未完成。可重试，或根据原件人工录入票据。');
      } catch (failure) {
        setError(failure);
        setTaskState('failed');
      } finally {
        polling = false;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [taskId, taskState, reload]);
  const choose = (invoice: InvoiceView) => {
    setSelected(invoice);
    setFields(structuredClone(invoice.fields));
    setExpenseType(invoice.fields.expense_type);
    setEntertainment(false);
    setError(null);
  };
  const change = <K extends keyof InvoiceFields>(
    key: K,
    value: InvoiceFields[K],
  ) =>
    setFields((current) => (current ? { ...current, [key]: value } : current));
  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice('正在登记并上传原始文件…');
    try {
      if (file.size === 0 || file.size > 20_971_520)
        throw new ApiFailure(
          'VALIDATION_ERROR',
          '文件须大于0字节，且不超过20MiB。',
          400,
        );
      const bytes = await file.arrayBuffer();
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      )
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      const registered = await api<{
        file: FileView;
        upload_target: {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
      }>('/files', {
        method: 'POST',
        body: {
          filename: file.name,
          mime_type:
            file.type ||
            (/\.pdf$/i.test(file.name)
              ? 'application/pdf'
              : /\.png$/i.test(file.name)
                ? 'image/png'
                : 'image/jpeg'),
          size_bytes: file.size,
          profile: 'invoice-v1',
        },
      });
      const uploadedResult = await uploadBytes(registered.upload_target, bytes);
      const version = uploadedResult.version;
      if (!version)
        throw new ApiFailure(
          'VALIDATION_ERROR',
          '上传未返回有效文件版本，请刷新后重试。',
          400,
        );
      const checked = await api<FileView>(
        `/files/${registered.file.id}/finalize`,
        { method: 'POST', body: { expected_version: version, sha256: sha } },
      );
      setUploaded(checked);
      setNotice('文件已完成内容校验。请选择演示识别或人工录入。');
      onChanged();
    } catch (failure) {
      setError(failure);
      setNotice('');
    } finally {
      setBusy(false);
    }
  };
  const recognize = async () => {
    if (!uploaded) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api<{ task_id: string; status: string }>(
        '/expenses/ocr-tasks',
        {
          method: 'POST',
          body: { file_id: uploaded.id, file_version: uploaded.version },
        },
      );
      setTaskId(task.task_id);
      setTaskState(task.status);
      setNotice('识别任务已保存，正在等待实际处理。');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const manual = async () => {
    if (!uploaded) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string }>('/expenses/invoices/manual', {
        method: 'POST',
        body: { file_id: uploaded.id, file_version: uploaded.version },
      });
      choose(await api<InvoiceView>(`/expenses/invoices/${created.id}`));
      await reload();
      setNotice('请对照原件填写并确认。人工确认不等同税务核验。');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const saveCorrections = async () => {
    if (!selected || !fields) return;
    const corrections: Partial<InvoiceFields> = {};
    for (const field of Object.keys(fields) as Array<keyof InvoiceFields>) {
      const value = field === 'expense_type' ? expenseType : fields[field];
      if (JSON.stringify(value) !== JSON.stringify(selected.fields[field]))
        Object.assign(corrections, { [field]: value });
    }
    if (!Object.keys(corrections).length) {
      setError(
        new ApiFailure('VALIDATION_ERROR', '当前没有票面字段变化。', 400),
      );
      return;
    }
    const invalid = [...(form.current?.querySelectorAll('input') ?? [])].find(
      (input) =>
        input.validity.patternMismatch ||
        input.validity.typeMismatch ||
        input.validity.rangeOverflow ||
        input.validity.rangeUnderflow,
    );
    if (invalid) {
      invalid.reportValidity();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/expenses/invoices/${selected.id}`, {
        method: 'PATCH',
        body: { expected_version: selected.version, corrections },
      });
      choose(await api<InvoiceView>(`/expenses/invoices/${selected.id}`));
      await reload();
      setNotice('票面矫正已保存，当前需要重新核对并确认；原核验结果不再沿用。');
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!selected || !fields || !form.current?.reportValidity()) return;
    setBusy(true);
    setError(null);
    try {
      if (!expenseType)
        throw new ApiFailure('VALIDATION_ERROR', '请明确选择费用类型。', 400);
      await api(`/expenses/invoices/${selected.id}/confirm`, {
        method: 'POST',
        body: {
          expected_version: selected.version,
          fields: { ...fields, expense_type: expenseType },
          expense_type: expenseType,
          expense_subtype: entertainment ? 'business_entertainment' : null,
        },
      });
      choose(await api<InvoiceView>(`/expenses/invoices/${selected.id}`));
      await reload();
      setNotice('票面字段已确认；核验状态以服务端结果为准。');
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="invoice-panel">
      <ErrorNotice error={error} />
      <div className="upload-area">
        <Field
          label="上传票据原件"
          hint="PDF、PNG或JPEG，最多20MiB；合成样例与真实文件均通过相同内容校验。"
        >
          <input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = '';
            }}
          />
        </Field>
        {uploaded && (
          <div className="button-row">
            <span>{uploaded.filename}</span>
            <button
              disabled={busy || ['queued', 'running'].includes(taskState ?? '')}
              onClick={() => void recognize()}
            >
              演示识别
            </button>
            <button disabled={busy} onClick={() => void manual()}>
              根据原件人工录入
            </button>
            <a
              href={`/api/v1/files/${uploaded.id}/content`}
              target="_blank"
              rel="noreferrer"
            >
              查看原件
            </a>
          </div>
        )}
        {notice && (
          <p role="status" className="muted">
            {notice}
          </p>
        )}
        {taskState && (
          <p>
            识别状态{' '}
            <Status
              value={taskState}
              label={taskState === 'completed' ? '识别完成' : undefined}
            />
          </p>
        )}
      </div>
      <div className="section-heading-inline">
        <h3>本人票据</h3>
        <button disabled={busy} onClick={() => void reload()}>
          刷新票据
        </button>
      </div>
      {items.length === 0 ? (
        <Empty>先上传票据原件，再识别或人工录入。</Empty>
      ) : (
        <ul className="invoice-list">
          {items.map((invoice) => (
            <li key={invoice.id}>
              <button className="document-link" onClick={() => choose(invoice)}>
                {invoice.fields.invoice_number ?? '票据号码待核对'}
              </button>
              <span className="money">
                {formatMoney(invoice.fields.gross_amount)}
              </span>
              <Status value={invoice.confirmation_state} />
              {onSelect && invoice.confirmation_state === 'confirmed' && (
                <button onClick={() => onSelect(invoice)}>作为费用加入</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {selected && fields && (
        <section className="invoice-editor">
          <header className="section-heading-inline">
            <h3>核对票面字段</h3>
            <a
              href={`/api/v1/files/${selected.file_id}/content`}
              target="_blank"
              rel="noreferrer"
            >
              打开原件对照
            </a>
          </header>
          <p className="muted">
            版本 v{selected.version} · 核验状态{' '}
            <Status value={selected.verification_state} />
          </p>
          <form
            ref={form}
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <div className="form-grid">
              <Field label="票据号码">
                <input
                  required
                  maxLength={64}
                  value={fields.invoice_number ?? ''}
                  onChange={(e) =>
                    change('invoice_number', e.target.value || null)
                  }
                />
              </Field>
              <Field label="票据日期">
                <input
                  required
                  type="date"
                  value={fields.invoice_date ?? ''}
                  onChange={(e) =>
                    change('invoice_date', e.target.value || null)
                  }
                />
              </Field>
              <Field label="销售方">
                <input
                  required
                  value={fields.seller_name ?? ''}
                  onChange={(e) =>
                    change('seller_name', e.target.value || null)
                  }
                />
              </Field>
              <Field label="购买方">
                <input
                  required
                  value={fields.buyer_name ?? ''}
                  onChange={(e) => change('buyer_name', e.target.value || null)}
                />
              </Field>
              <Field label="价税合计（元）">
                <MoneyInput
                  value={fields.gross_amount}
                  onChange={(value) => change('gross_amount', value)}
                />
              </Field>
              <Field label="税额（元）">
                <MoneyInput
                  value={fields.tax_amount}
                  onChange={(value) => change('tax_amount', value)}
                />
              </Field>
              <Field label="不含税金额（元）">
                <MoneyInput
                  value={fields.net_amount}
                  onChange={(value) => change('net_amount', value)}
                />
              </Field>
              <Field label="票据种类">
                <select
                  value={fields.invoice_kind}
                  onChange={(e) =>
                    change(
                      'invoice_kind',
                      e.target.value as InvoiceFields['invoice_kind'],
                    )
                  }
                >
                  <option value="other">其他票据</option>
                  <option value="transport_ticket">交通票</option>
                  <option value="electronic">电子发票</option>
                  <option value="paper">纸质发票</option>
                </select>
              </Field>
              <Field label="费用类型">
                <select
                  required
                  value={expenseType ?? ''}
                  onChange={(e) =>
                    setExpenseType(
                      e.target.value as InvoiceFields['expense_type'],
                    )
                  }
                >
                  <option value="">请选择，不自动推断</option>
                  {Object.entries(expenseTypes).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="票据代码（适用时）">
                <input
                  value={fields.invoice_code ?? ''}
                  maxLength={64}
                  onChange={(e) =>
                    change('invoice_code', e.target.value || null)
                  }
                />
              </Field>
              <Field label="销售方税号（适用时）">
                <input
                  value={fields.seller_tax_id ?? ''}
                  onChange={(e) =>
                    change('seller_tax_id', e.target.value || null)
                  }
                />
              </Field>
              <Field label="购买方税号（适用时）">
                <input
                  value={fields.buyer_tax_id ?? ''}
                  onChange={(e) =>
                    change('buyer_tax_id', e.target.value || null)
                  }
                />
              </Field>
            </div>
            {expenseType === 'meals' && (
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={entertainment}
                  onChange={(e) => setEntertainment(e.target.checked)}
                />
                本次餐饮属于业务招待
              </label>
            )}
            <div className="button-row">
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveCorrections()}
              >
                保存票面矫正，稍后确认
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || selected.confirmation_state === 'confirmed'}
              >
                {busy ? '正在保存…' : '确认票面与费用类型'}
              </button>
              {onSelect && selected.confirmation_state === 'confirmed' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSelect(selected)}
                >
                  将当前票据加入费用
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </section>
  );
}
