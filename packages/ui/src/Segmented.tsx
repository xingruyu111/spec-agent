import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { cx } from './cx.js';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
};

type WalkKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End';

function isWalkKey(key: string): key is WalkKey {
  return (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End'
  );
}

function walk<T extends string>(
  options: ReadonlyArray<SegmentedOption<T>>,
  from: number,
  key: WalkKey,
): SegmentedOption<T> | undefined {
  const enabled = options.filter((option) => !option.disabled);
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  for (let offset = 1; offset < options.length; offset += 1) {
    const index = (((from + step * offset) % options.length) + options.length) %
      options.length;
    const candidate = options[index];
    if (candidate && !candidate.disabled) return candidate;
  }
  return undefined;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.findIndex((option) => option.value === value);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !root.contains(document.activeElement)) return;
    root
      .querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
  }, [value]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!isWalkKey(event.key)) return;
    event.preventDefault();
    const target = walk(options, selected, event.key);
    if (target && target.value !== value) onChange(target.value);
  };

  const indicator = {
    '--ui-segment-count': String(options.length),
    '--ui-segment-index': String(selected),
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={cx('ui-segmented', className)}
      role="tablist"
      aria-label={ariaLabel}
      style={indicator}
    >
      <span aria-hidden="true" className="ui-segmented__indicator" />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            className={cx('ui-segmented__item', active && 'active')}
            aria-selected={active}
            aria-controls={undefined}
            tabIndex={active ? 0 : -1}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            onKeyDown={onKeyDown}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
