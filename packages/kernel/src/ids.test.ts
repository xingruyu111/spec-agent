import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import {
  asArtifactId,
  asEventId,
  asGateId,
  asMessageId,
  asNodeRunId,
  asRunId,
  asTaskId,
  createIdFactory,
  encodeRandom,
  encodeTime,
  idBody,
  isUlid,
  timeFromUlid,
  ULID_LENGTH,
} from './ids.js';

function fixedClock(now: number): Clock {
  return {
    now: () => now,
    iso: () => new Date(now).toISOString(),
    sleep: async () => {},
  };
}

function sequenceClock(times: number[]): Clock {
  let index = 0;
  return {
    now: () => times[Math.min(index++, times.length - 1)]!,
    iso: () => new Date(0).toISOString(),
    sleep: async () => {},
  };
}

const zeroRandom = (): Uint8Array => new Uint8Array(10);
const fullRandom = (): Uint8Array => new Uint8Array(10).fill(0xff);

describe('encodeTime', () => {
  it('编码 0 和 1', () => {
    expect(encodeTime(0)).toBe('0000000000');
    expect(encodeTime(1)).toBe('0000000001');
  });

  it('跨位进位', () => {
    expect(encodeTime(31)).toBe('000000000Z');
    expect(encodeTime(32)).toBe('0000000010');
  });

  it('48 位最大值', () => {
    expect(encodeTime(2 ** 48 - 1)).toBe('7ZZZZZZZZZ');
  });

  it('拒绝负数、小数和越界值', () => {
    expect(() => encodeTime(-1)).toThrow(AppError);
    expect(() => encodeTime(1.5)).toThrow(AppError);
    expect(() => encodeTime(2 ** 48)).toThrow(AppError);
  });
});

describe('encodeRandom', () => {
  it('全 0 和全 1 的编码', () => {
    expect(encodeRandom(zeroRandom())).toBe('0000000000000000');
    expect(encodeRandom(fullRandom())).toBe('ZZZZZZZZZZZZZZZZ');
  });

  it('随机字节不足会报错', () => {
    expect(() => encodeRandom(new Uint8Array(9))).toThrow(AppError);
  });
});

describe('ULID 校验与解析', () => {
  it('接受标准 ULID 与小写', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(true);
  });

  it('拒绝长度不对或含非法字符', () => {
    expect(isUlid('01ARZ3NDEK')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAU')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
  });

  it('时间戳可往返', () => {
    for (const time of [0, 1, 1_469_918_176_385, 2 ** 48 - 1]) {
      const id = `${encodeTime(time)}${encodeRandom(zeroRandom())}`;
      expect(timeFromUlid(id)).toBe(time);
    }
  });

  it('非法 id 解析会报错', () => {
    expect(() => timeFromUlid('nope')).toThrow(AppError);
  });
});

describe('createIdFactory', () => {
  it('生成带前缀的 26 位 body', () => {
    const factory = createIdFactory({ clock: fixedClock(1_700_000_000_000), random: zeroRandom });
    const id = factory.task();
    expect(id).toMatch(/^task_/);
    expect(idBody(id)).toHaveLength(ULID_LENGTH);
    expect(isUlid(idBody(id))).toBe(true);
    expect(timeFromUlid(idBody(id))).toBe(1_700_000_000_000);
  });

  it('每种 id 用不同前缀', () => {
    const factory = createIdFactory({ clock: fixedClock(1_700_000_000_000), random: zeroRandom });
    expect(factory.task()).toMatch(/^task_/);
    expect(factory.run()).toMatch(/^run_/);
    expect(factory.nodeRun()).toMatch(/^nrun_/);
    expect(factory.gate()).toMatch(/^gate_/);
    expect(factory.event()).toMatch(/^evt_/);
    expect(factory.artifact()).toMatch(/^art_/);
    expect(factory.message()).toMatch(/^msg_/);
  });

  it('同样的时间与随机源得到同样的 id', () => {
    const a = createIdFactory({ clock: fixedClock(1_700_000_000_000), random: zeroRandom });
    const b = createIdFactory({ clock: fixedClock(1_700_000_000_000), random: zeroRandom });
    expect(a.task()).toBe(b.task());
  });

  it('同一毫秒内严格递增', () => {
    const factory = createIdFactory({ clock: fixedClock(1_700_000_000_000), random: zeroRandom });
    let previous = '';
    for (let i = 0; i < 100; i += 1) {
      const id = factory.event();
      expect(id > previous).toBe(true);
      previous = id;
    }
  });

  it('时钟回拨时 id 不倒退', () => {
    const factory = createIdFactory({
      clock: sequenceClock([1_700_000_000_000, 1_600_000_000_000, 1_500_000_000_000]),
      random: zeroRandom,
    });
    const first = factory.task();
    const second = factory.task();
    const third = factory.task();
    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
    // 时间部分沿用最大值
    expect(timeFromUlid(idBody(third))).toBe(1_700_000_000_000);
  });

  it('随机位用尽时报 E_ID_OVERFLOW', () => {
    const factory = createIdFactory({ clock: fixedClock(1_700_000_000_000), random: fullRandom });
    factory.task();
    expect(() => factory.task()).toThrowError(/随机位已用尽/);
  });

  it('asTaskId 只做边界转换', () => {
    expect(asTaskId('task_abc')).toBe('task_abc');
  });

  it('没有注入随机源时使用系统随机', () => {
    const factory = createIdFactory({ clock: fixedClock(1_700_000_000_000) });
    const first = factory.task();
    const second = factory.task();
    expect(first).not.toBe(second);
    expect(isUlid(idBody(first))).toBe(true);
  });

  it('所有边界转换函数都只做转换', () => {
    expect(asTaskId('t')).toBe('t');
    expect(asRunId('r')).toBe('r');
    expect(asNodeRunId('n')).toBe('n');
    expect(asGateId('g')).toBe('g');
    expect(asEventId('e')).toBe('e');
    expect(asArtifactId('a')).toBe('a');
    expect(asMessageId('m')).toBe('m');
  });

  it('idBody 对无前缀的裸 ULID 原样返回', () => {
    expect(idBody('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });
});
