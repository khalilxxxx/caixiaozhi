import { useId, useLayoutEffect, useRef, useState } from 'react';
import { formatCents } from './RulesSubmission';
import { Icon } from './ui';
import type {
  WorkDocumentContent,
  WorkExpense,
  WorkFile,
} from './work-document-model';
import './work-invoice-images.css';

const sampleImages = import.meta.glob<string>('./invoice-samples/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

export function expenseAmount(expense: WorkExpense) {
  return expense.currency && expense.currency !== 'CNY'
    ? `${expense.currency} ${(expense.amountCents / 100).toFixed(2)}`
    : formatCents(expense.amountCents);
}

export interface WorkInvoice {
  file: WorkFile;
  expenses: WorkExpense[];
  image?: string;
  sample: boolean;
}

function sourcePreview(file: WorkFile) {
  if (!file.previewImageUrl) return undefined;
  try {
    const url = new URL(file.previewImageUrl, window.location.origin);
    return url.origin === window.location.origin || url.protocol === 'https:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function workInvoices(doc: WorkDocumentContent): WorkInvoice[] {
  return (doc.files ?? [])
    .filter((file) =>
      file.kind ? file.kind === 'invoice' : /发票|invoice/i.test(file.name),
    )
    .map((file) => {
      const original = sourcePreview(file);
      const fixture =
        doc.synthetic &&
        sampleImages[
          `./invoice-samples/${doc.id}-v${doc.decision?.fromVersion ?? doc.version}-${file.id}.webp`
        ];
      return {
        file,
        expenses:
          doc.expenses?.filter(
            (expense) =>
              expense.sourceFileId === file.id ||
              expense.invoiceFileIds?.includes(file.id),
          ) ?? [],
        image: original || fixture || undefined,
        sample: !original && !!fixture,
      };
    });
}

export function WorkInvoiceList({
  invoices,
  onOpen,
}: {
  invoices: WorkInvoice[];
  onOpen: (invoice: WorkInvoice) => void;
}) {
  if (!invoices.length)
    return <p className="wd-empty wd-invoice-empty">本单未关联发票。</p>;
  return (
    <ul className="wd-invoices">
      {invoices.map((invoice) => {
        const { file, expenses, image, sample } = invoice;
        const content = (
          <>
            <span className="wd-invoice-thumb">
              {image ? (
                <img src={image} loading="lazy" alt="" />
              ) : (
                <Icon name="file" size={25} />
              )}
            </span>
            <span className="wd-invoice-caption">
              <strong>{file.name}</strong>
              {expenses.length > 0 && (
                <small>{expenses.map((item) => item.name).join('、')}</small>
              )}
              <small>
                {!image
                  ? '来源系统暂未提供影像'
                  : sample
                    ? '样例影像'
                    : '原始影像'}
                {expenses.length === 1 &&
                  ` · 费用 ${expenseAmount(expenses[0]!)}`}
              </small>
            </span>
            {image && <Icon name="chevron" size={14} />}
          </>
        );
        return (
          <li key={file.id}>
            {image ? (
              <button
                className="wd-invoice-entry"
                type="button"
                onClick={() => onOpen(invoice)}
                aria-label={`查看影像，${file.name}`}
              >
                {content}
              </button>
            ) : (
              <div className="wd-invoice-entry">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function WorkInvoiceViewer({
  invoices,
  active,
  onSelect,
  onClose,
}: {
  invoices: WorkInvoice[];
  active: WorkInvoice;
  onSelect: (invoice: WorkInvoice) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const usable = invoices.filter((invoice) => invoice.image);
  const index = usable.findIndex(
    (invoice) => invoice.file.id === active.file.id,
  );
  const prev = usable[index - 1];
  const next = usable[index + 1];
  useLayoutEffect(() => {
    const el = dialog.current;
    const origin = document.activeElement;
    el?.showModal();
    return () => {
      el?.close();
      if (origin instanceof HTMLElement && origin.isConnected)
        origin.focus({ preventScroll: true });
    };
  }, []);

  function change(invoice: WorkInvoice | undefined) {
    if (!invoice) return;
    setZoom(false);
    setFailed(false);
    area.current?.scrollTo(0, 0);
    onSelect(invoice);
  }

  return (
    <dialog
      ref={dialog}
      className="wd-image-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
        if (
          !zoom &&
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        ) {
          event.preventDefault();
          change(event.key === 'ArrowLeft' ? prev : next);
        }
      }}
      onClick={(event) => {
        if (event.target !== dialog.current) return;
        const box = dialog.current.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <header className="wd-image-head">
        <div>
          <h3 id={titleId}>{active.file.name}</h3>
          <span>
            {active.sample ? '样例影像' : '发票影像'}
            {active.expenses.length
              ? ` · ${active.expenses.map((item) => item.name).join('、')}`
              : ''}
          </span>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭发票影像">
          <Icon name="close" size={19} />
        </button>
      </header>
      <div className="wd-image-canvas" ref={area} data-zoom={zoom || undefined}>
        {failed ? (
          <p role="status">影像当前无法加载。</p>
        ) : (
          <img
            src={active.image}
            alt={
              active.file.name + (active.sample ? '，样例影像' : '，原始影像')
            }
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <footer className="wd-image-foot">
        <div className="wd-image-pager">
          <button
            type="button"
            disabled={!prev}
            aria-label="上一张发票"
            onClick={() => change(prev)}
          >
            <Icon name="back" size={16} />
          </button>
          <span aria-live="polite">
            {index + 1} / {usable.length}
          </span>
          <button
            type="button"
            disabled={!next}
            aria-label="下一张发票"
            onClick={() => change(next)}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
        {active.file.hasLocalOriginal && (
          <a
            href={
              '/api/local/files/' +
              encodeURIComponent(active.file.id) +
              '/download'
            }
            download
          >
            下载原件
          </a>
        )}
        <button
          type="button"
          disabled={failed}
          aria-pressed={zoom}
          onClick={() => setZoom(!zoom)}
        >
          <Icon name="search" size={15} />
          {zoom ? '适应窗口' : '放大'}
        </button>
      </footer>
    </dialog>
  );
}
