/**
 * 可注入时钟。
 *
 * 所有"现在几点"和"睡一会"都必须走这里，测试才能控制时间。
 * 不要在业务代码里直接 new Date() 或 setTimeout。
 */

import { AppError } from './errors.js';

export interface Clock {
  /** Unix 毫秒 */
  now(): number;
  /** ISO 8601；不传则取当前时间 */
  iso(at?: number): string;
  /** 可被 AbortSignal 打断的等待 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    iso: (at = Date.now()) => new Date(at).toISOString(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (ms < 0 || !Number.isFinite(ms)) {
          reject(new AppError('E_CLOCK_DURATION', `非法的等待时长：${ms}`));
          return;
        }
        if (signal?.aborted) {
          reject(new AppError('E_ABORTED', '等待被中止'));
          return;
        }

        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);

        function onAbort(): void {
          clearTimeout(timer);
          reject(new AppError('E_ABORTED', '等待被中止'));
        }

        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  };
}
