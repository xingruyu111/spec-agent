import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.js';

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SelectGroup = {
  label?: string;
  options: SelectOption[];
};

export type SelectChangeEvent = {
  target: { value: string; name?: string };
};

export type SelectProps = {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  title?: string;
  'aria-label'?: string;
  children?: ReactNode;
};

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return '';
}

function optionsOf(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ value?: unknown; disabled?: boolean; children?: ReactNode }>(child)) {
      return;
    }
    if (child.type === 'option') {
      const label = textOf(child.props.children);
      options.push({
        value: String(child.props.value ?? label),
        label,
        disabled: Boolean(child.props.disabled),
      });
    }
  });
  return options;
}

function groupsOf(children: ReactNode): SelectGroup[] {
  const groups: SelectGroup[] = [];
  let loose: SelectOption[] = [];
  const flushLoose = (): void => {
    if (loose.length === 0) return;
    groups.push({ options: loose });
    loose = [];
  };

  Children.forEach(children, (child) => {
    if (!isValidElement<{ label?: ReactNode; children?: ReactNode }>(child)) {
      return;
    }
    if (child.type === 'optgroup') {
      flushLoose();
      groups.push({
        label: textOf(child.props.label),
        options: optionsOf(child.props.children),
      });
    } else if (child.type === Fragment) {
      loose.push(...optionsOf(child.props.children));
    } else {
      loose.push(...optionsOf([child]));
    }
  });
  flushLoose();
  return groups;
}

export function Select({
  value,
  defaultValue,
  onChange,
  disabled,
  className,
  id,
  name,
  title,
  'aria-label': ariaLabel,
  children,
}: SelectProps) {
  const groups = useMemo(() => groupsOf(children), [children]);
  const options = useMemo(
    () => groups.flatMap((group) => group.options),
    [groups],
  );
  const [internalValue, setInternalValue] = useState(() =>
    String(defaultValue ?? options[0]?.value ?? ''),
  );
  const selectedValue = value !== undefined ? String(value) : internalValue;
  const selected =
    options.find((option) => option.value === selectedValue) ?? null;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const updatePosition = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 168);
    const below = window.innerHeight - rect.bottom;
    const estimatedHeight = Math.min(280, options.length * 30 + 12);
    const top =
      below < estimatedHeight + 12 && rect.top > estimatedHeight
        ? rect.top - estimatedHeight - 4
        : rect.bottom + 4;
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8),
    );
    setPosition({ left, top, width });
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onViewport = (): void => updatePosition();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const index = options.findIndex(
      (option) => option.value === selectedValue && !option.disabled,
    );
    setActiveIndex(index >= 0 ? index : options.findIndex((option) => !option.disabled));
  }, [open, options, selectedValue]);

  const choose = (option: SelectOption): void => {
    if (option.disabled) return;
    if (value === undefined) setInternalValue(option.value);
    setOpen(false);
    onChange?.({ target: { value: option.value, ...(name ? { name } : {}) } });
  };

  const move = (direction: 1 | -1): void => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < options.length; step += 1) {
      next = (next + direction + options.length) % options.length;
      if (!options[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const option = options[activeIndex];
      if (option) choose(option);
    }
  };

  let optionIndex = -1;

  return (
    <div className={cx('ui-select', className)} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className="ui-select__trigger"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className={cx('ui-select__value', !selected && 'is-placeholder')}>
          {selected?.label ?? '请选择'}
        </span>
        <svg
          className="ui-select__chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {name ? <input type="hidden" name={name} value={selectedValue} /> : null}
      {open && position
        ? createPortal(
            <div
              ref={popoverRef}
              className="ui-select-popover"
              style={{
                left: position.left,
                top: position.top,
                width: position.width,
              }}
              role="listbox"
              aria-label={ariaLabel}
            >
              {groups.map((group, groupIndex) => (
                <div className="ui-select-group" key={group.label ?? groupIndex}>
                  {group.label ? (
                    <div className="ui-select-group__label">{group.label}</div>
                  ) : null}
                  {group.options.map((option) => {
                    optionIndex += 1;
                    const index = optionIndex;
                    const isSelected = option.value === selectedValue;
                    return (
                      <button
                        key={`${option.value}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={cx(
                          'ui-select-option',
                          index === activeIndex && 'is-active',
                          isSelected && 'is-selected',
                        )}
                        disabled={option.disabled}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(option)}
                      >
                        <span>{option.label}</span>
                        {isSelected ? (
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="m5 12 4 4L19 6"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
              {groups.length === 0 ? (
                <div className="ui-select-empty">没有选项</div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
