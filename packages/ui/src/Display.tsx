import {
  createElement,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { cx } from './cx.js';

export type SurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'article' | 'section';
  tone?: 'base' | 'subtle';
  padding?: 'none' | 'sm' | 'md' | 'lg';
};

export function Surface({
  as = 'div',
  tone = 'base',
  padding = 'md',
  className,
  ...props
}: SurfaceProps) {
  return createElement(as, {
    ...props,
    className: cx(
      'ui-surface',
      `ui-surface--${tone}`,
      `ui-surface--pad-${padding}`,
      className,
    ),
  });
}

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx('ui-badge', `ui-badge--${tone}`, className)}>
      {children}
    </span>
  );
}

export function Tag({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx('ui-tag', `ui-badge--${tone}`, className)}>
      {children}
    </span>
  );
}

export function Spinner({
  size = 'md',
  label,
}: {
  size?: 'sm' | 'md';
  label?: string;
}) {
  return (
    <span
      className={cx('ui-spinner', `ui-spinner--${size}`)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('ui-empty', className)}>
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
      {action}
    </div>
  );
}

export function SectionHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('ui-section-head', className)}>
      <div className="ui-section-head__copy">
        <span>{title}</span>
        {meta ? <small>{meta}</small> : null}
      </div>
      {actions ? <div className="ui-section-head__actions">{actions}</div> : null}
    </div>
  );
}
