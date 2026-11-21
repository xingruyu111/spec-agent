import { describe, expect, it, vi } from 'vitest';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { createLogger, type LogRecord } from './logger.js';
import { REDACTED } from './redact.js';

function fixedClock(): Clock {
  return {
    now: () => 1_700_000_000_000,
    iso: () => '2023-11-14T22:13:20.000Z',
    sleep: async () => {},
  };
}

function capture(): { records: LogRecord[]; sink: (r: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

describe('createLogger', () => {
  it('输出 time / level / msg', () => {
    const { records, sink } = capture();
    const logger = createLogger({ level: 'debug', sink, clock: fixedClock() });
    logger.info('hello', { a: 1 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      time: '2023-11-14T22:13:20.000Z',
      level: 'info',
      msg: 'hello',
      a: 1,
    });
  });

  it('低于级别的日志不输出', () => {
    const { records, sink } = capture();
    const logger = createLogger({ level: 'warn', sink, clock: fixedClock() });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('child 继承 bindings 且不污染父级', () => {
    const { records, sink } = capture();
    const parent = createLogger({ level: 'info', sink, clock: fixedClock() });
    const child = parent.child({ taskId: 't1' });
    child.info('from child');
    parent.info('from parent');
    expect(records[0]).toMatchObject({ taskId: 't1', msg: 'from child' });
    expect(records[1]).not.toHaveProperty('taskId');
  });

  it('多级 child 合并 bindings', () => {
    const { records, sink } = capture();
    const logger = createLogger({ level: 'info', sink, clock: fixedClock() })
      .child({ a: 1 })
      .child({ b: 2 });
    logger.info('x');
    expect(records[0]).toMatchObject({ a: 1, b: 2 });
  });

  it('字段覆盖 bindings，但核心字段不被覆盖', () => {
    const { records, sink } = capture();
    const logger = createLogger({
      level: 'info',
      sink,
      clock: fixedClock(),
      bindings: { a: 'from-binding', level: 'debug' },
    });
    logger.info('x', { a: 'from-field', msg: 'nope', time: 'nope' });
    expect(records[0]).toMatchObject({
      a: 'from-field',
      msg: 'x',
      level: 'info',
      time: '2023-11-14T22:13:20.000Z',
    });
  });

  it('写出前脱敏', () => {
    const { records, sink } = capture();
    const logger = createLogger({ level: 'info', sink, clock: fixedClock() });
    logger.info('call', { token: 'secret-value', note: 'sk-abcdefghijklmnop' });
    expect(records[0]!.token).toBe(REDACTED);
    expect(records[0]!.note).toBe('sk-***');
  });

  it('Error 字段序列化成 ErrorInfo', () => {
    const { records, sink } = capture();
    const logger = createLogger({ level: 'info', sink, clock: fixedClock() });
    logger.error('failed', { err: new AppError('E_X', '坏了') });
    expect(records[0]!.err).toEqual({ code: 'E_X', message: '坏了' });
  });

  it('默认 sink 输出 JSON 行，warn/error 走 stderr', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const logger = createLogger({ level: 'debug', clock: fixedClock() });
      logger.info('hello');
      logger.error('bad', { code: 'E_X' });

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(String(logSpy.mock.calls[0]![0])).toContain('"msg":"hello"');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]![0])).toContain('"level":"error"');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('不传选项时使用默认级别与系统时钟', () => {
    const { records, sink } = capture();
    const logger = createLogger({ sink });
    logger.debug('ignored');
    logger.info('hello');
    expect(logger.level).toBe('info');
    expect(records).toHaveLength(1);
    expect(records[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
