/**
 * 结构化日志。
 *
 * 默认输出 JSON 行；测试里注入 sink 断言内容。
 * 所有字段在写出前脱敏，包括 child 上挂的 bindings。
 */

import type { Clock } from './clock.js';
import { createSystemClock } from './clock.js';
import { redactValue } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  time: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
};

export type LogSink = (record: LogRecord) => void;

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  readonly level: LogLevel;
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export type LoggerOptions = {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  sink?: LogSink;
  clock?: Clock;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? createSystemClock();

  function emit(target: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[target] < ORDER[level]) return;
    const record: LogRecord = {
      ...bindings,
      ...(fields ?? {}),
      time: clock.iso(),
      level: target,
      msg,
    };
    sink(redactValue(record) as LogRecord);
  }

  return {
    level,
    child(extra) {
      return createLogger({ level, sink, clock, bindings: { ...bindings, ...extra } });
    },
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === 'warn' || record.level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
