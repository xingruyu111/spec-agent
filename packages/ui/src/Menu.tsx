import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from './cx.js';

export type MenuItem = {
  id?: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
};

export type MenuProps = {
  label: string;
  trigger: ReactNode;
  items: ReadonlyArray<MenuItem>;
  align?: 'start' | 'end';
  className?: string;
};

export function Menu({
  label,
  trigger,
  items,
  align = 'end',
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (root && menu && window.innerHeight - root.bottom < menu.height + 8) {
      setPlacement('top');
    } else {
      setPlacement('bottom');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    first?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={cx('ui-menu-root', className)} ref={rootRef}>
      <button
        type="button"
        className="ui-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={cx(
            'ui-menu',
            `ui-menu--${align}`,
            `ui-menu--${placement}`,
          )}
          role="menu"
          aria-label={label}
        >
          {items.map((item, index) => (
            <button
              key={item.id ?? `${item.label}-${index}`}
              type="button"
              role="menuitem"
              className={cx('ui-menu__item', item.danger && 'danger')}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
