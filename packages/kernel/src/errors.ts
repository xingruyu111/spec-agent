/**
 * 统一错误与 Result。
 *
 * 约定：
 * - 所有可预期的失败都抛 AppError，带稳定 code；
 * - 不把 Error 直接跨层传（序列化后只剩 message）；
 * - Result 只用于"可恢复的失败"，不该拿它吞掉编程错误。
 */

import type { ErrorInfo } from '@spec-agent/schema';

export type AppErrorOptions = {
  details?: unknown;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }

  toJSON(): ErrorInfo {
    if (this.details === undefined) {
      return { code: this.code, message: this.message };
    }
    return { code: this.code, message: this.message, detail: this.details };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (isAppError(error)) return error.toJSON();
  if (error instanceof Error) {
    return {
      code: 'E_UNKNOWN',
      message: `${error.name}: ${error.message}`,
      detail: error.stack,
    };
  }
  if (typeof error === 'string') {
    return { code: 'E_UNKNOWN', message: error };
  }
  return { code: 'E_UNKNOWN', message: safeStringify(error) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E = AppError> = { readonly ok: false; readonly error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  if (result.error instanceof Error) throw result.error;
  throw new AppError('E_UNWRAP', `unwrap 失败：${safeStringify(result.error)}`);
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
