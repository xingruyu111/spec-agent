import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx.js';

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return <input {...props} ref={ref} className={cx('ui-input', className)} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea {...props} ref={ref} className={cx('ui-textarea', className)} />
  );
});

export type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
};

export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cx('ui-field', className)}>
      {label ? (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <div className="ui-field__message ui-field__message--error" role="alert">
          {error}
        </div>
      ) : hint ? (
        <div className="ui-field__message">{hint}</div>
      ) : null}
    </div>
  );
}

export function FieldSet({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className="ui-fieldset" aria-describedby={hint ? id : undefined}>
      <legend className="ui-field__label">{label}</legend>
      {children}
      {hint ? (
        <div className="ui-field__message" id={id}>
          {hint}
        </div>
      ) : null}
    </fieldset>
  );
}
