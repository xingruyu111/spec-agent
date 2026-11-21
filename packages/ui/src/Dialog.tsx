import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.js';
import { IconButton } from './Button';

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  maxWidth?: number;
  className?: string;
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
  maxWidth = 720,
  className,
}: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="ui-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={cx('ui-dialog', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        style={{ width, maxWidth }}
        tabIndex={-1}
      >
        {title || description ? (
          <header className="ui-dialog__head">
            <div>
              {title ? (
                <h2 className="ui-dialog__title" id={titleId}>
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p className="ui-dialog__description">{description}</p>
              ) : null}
            </div>
            <IconButton label="关闭" size="sm" onClick={onClose}>
              ×
            </IconButton>
          </header>
        ) : null}
        <div className="ui-dialog__body">{children}</div>
        {footer ? <footer className="ui-dialog__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
