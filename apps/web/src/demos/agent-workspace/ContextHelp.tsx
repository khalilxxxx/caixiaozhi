import { useEffect, useId, useRef, useState } from 'react';
import { HelpPanel } from './Supporting';
import { Icon } from './ui';
import './context-help.css';

/** A separate dialog keeps the underlying upload/edit panel and its draft mounted. */
export function ContextHelp({
  skillsContext = false,
}: {
  skillsContext?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [toolPanel, setToolPanel] = useState<{
    kind: string | null;
    toolId?: string;
  }>({ kind: null });
  useEffect(() => {
    const update = (event: Event) =>
      setToolPanel(
        (event as CustomEvent<{ kind: string | null; toolId?: string }>).detail,
      );
    window.addEventListener('caixiaozhi-tool-panel-change', update);
    return () =>
      window.removeEventListener('caixiaozhi-tool-panel-change', update);
  }, []);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = () => setOpen(false);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        className="help-trigger"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="help" size={14} />
        使用指引
      </button>
      <dialog
        ref={dialog}
        className="context-help-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation();
        }}
        onClose={() => {
          setOpen(false);
          trigger.current?.focus();
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
            close();
        }}
      >
        <header>
          <h2 id={titleId}>使用指引</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭使用指引"
            onClick={close}
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="context-help-body">
          {open && (
            <HelpPanel
              skillsContext={skillsContext}
              toolPanel={toolPanel}
              onClose={close}
            />
          )}
        </div>
      </dialog>
    </>
  );
}
