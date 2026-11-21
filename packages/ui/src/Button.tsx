import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.js';

export type ButtonVariant =
  | 'primary'
  | 'ghost'
  | 'outline'
  | 'toolbar'
  | 'danger'
  | 'secondary'
  | 'plain';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  block?: boolean;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'ghost',
      size = 'md',
      icon,
      block = false,
      loading = false,
      className,
      disabled,
      children,
      type = 'button',
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={cx(
          'ui-button',
          `ui-button--${variant}`,
          `ui-button--${size}`,
          block && 'ui-button--block',
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
      >
        {loading ? <span className="ui-spinner ui-spinner--sm" aria-hidden /> : null}
        {icon != null ? <span className="ui-button__icon">{icon}</span> : null}
        {children}
      </button>
    );
  },
);

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: ButtonSize;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { label, size = 'md', className, type = 'button', children, ...props },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={cx(
          'ui-icon-button',
          `ui-button--${size}`,
          className,
        )}
        aria-label={label}
        title={props.title ?? label}
      >
        {children}
      </button>
    );
  },
);
