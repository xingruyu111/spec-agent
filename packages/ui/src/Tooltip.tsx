import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { cx } from './cx.js';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export type TooltipProps = {
  label: string;
  side?: TooltipSide;
  delayMs?: number;
  disabled?: boolean;
  className?: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
};

export function Tooltip({
  label,
  side = 'top',
  delayMs = 0,
  disabled = false,
  className,
  children,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clear, []);

  const show = (): void => {
    if (disabled) return;
    clear();
    if (delayMs <= 0) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, delayMs);
  };

  const hide = (): void => {
    clear();
    setOpen(false);
  };

  const anchor = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
  });

  return (
    <span
      className={cx('ui-tooltip-anchor', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide();
      }}
    >
      {anchor}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={cx('ui-tooltip', `ui-tooltip--${side}`)}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
