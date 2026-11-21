import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from './cx.js';

export const Checkbox = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <input
      {...props}
      ref={ref}
      type="checkbox"
      className={cx('ui-checkbox', className)}
    />
  );
});
