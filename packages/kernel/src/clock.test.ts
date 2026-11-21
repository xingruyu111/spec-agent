import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from './errors.js';
import { createSystemClock } from './clock.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('clock', () => {
  it('now 返回毫秒时间戳', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T05:00:00.000Z'));
    const clock = createSystemClock();
    expect(clock.now()).toBe(Date.parse('2026-10-26T05:00:00.000Z'));
  });

  it('iso 输出带毫秒的 ISO 字符串', () => {
    const clock = createSystemClock();
    expect(clock.iso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(clock.iso(1_700_000_000_123)).toBe('2023-11-14T22:13:20.123Z');
  });

  it('sleep 到点 resolve', async () => {
    vi.useFakeTimers();
    const clock = createSystemClock();
    let done = false;
    const promise = clock.sleep(100).then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(done).toBe(true);
  });

  it('信号已中止时立即 reject', async () => {
    const controller = new AbortController();
    controller.abort();
    const clock = createSystemClock();
    await expect(clock.sleep(100, controller.signal)).rejects.toBeInstanceOf(AppError);
  });

  it('等待过程中中止会 reject 并清掉定时器', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const clock = createSystemClock();
    const promise = clock.sleep(1000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'E_ABORTED' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('拒绝负数和非法时长', async () => {
    const clock = createSystemClock();
    await expect(clock.sleep(-1)).rejects.toMatchObject({ code: 'E_CLOCK_DURATION' });
    await expect(clock.sleep(Number.NaN)).rejects.toMatchObject({ code: 'E_CLOCK_DURATION' });
    await expect(clock.sleep(Number.POSITIVE_INFINITY)).rejects.toMatchObject({
      code: 'E_CLOCK_DURATION',
    });
  });
});
