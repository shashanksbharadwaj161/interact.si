import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { Button } from './primitives';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** When false, Esc and backdrop clicks are ignored (used while an action is in flight). */
  dismissible?: boolean;
};

/**
 * Modal built on the native <dialog>: the browser traps focus, makes the rest of the page inert and
 * handles Esc. We add initial focus (`data-autofocus`) and explicit focus restoration.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissible = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      const first = d.querySelector<HTMLElement>('[data-autofocus]') ?? d.querySelector<HTMLElement>('input,textarea,select,button:not(.dialog-x)');
      first?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  useEffect(
    () => () => {
      const d = ref.current;
      if (d?.open) d.close();
      opener.current?.focus?.();
    },
    [],
  );

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClose={() => {
        opener.current?.focus?.();
        if (open && dismissible) onClose();
      }}
      onMouseDown={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog-card">
          <header className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="iconbtn dialog-x" aria-label="Close dialog" title="Close" disabled={!dismissible} onClick={onClose}>
              <X size={16} />
            </button>
          </header>
          {description && (
            <p id={descId} className="dialog-desc">
              {description}
            </p>
          )}
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

type ConfirmProps = {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', danger, busy, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
