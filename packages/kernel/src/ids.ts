/**
 * ULID 生成。
 *
 * 为什么不用 UUID：ULID 前 10 位是时间戳，天然按时间排序，
 * 事件表的 seq 虽然也是递增的，但 id 本身可排序在日志和调试时更省事。
 *
 * 格式：<prefix>_<10 位时间><16 位随机>，例如 task_01JB7...
 * 前缀只是给人看的；编译器靠 branded type 区分。
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type {
  ArtifactId,
  EventId,
  GateId,
  MessageId,
  NodeRunId,
  RunId,
  TaskId,
} from '@spec-agent/schema';
import { AppError } from './errors.js';
import type { Clock } from './clock.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_BYTES = 10;
const MAX_TIME = 281_474_976_710_655; // 2^48 - 1

export const ULID_LENGTH = TIME_LEN + RANDOM_LEN;

export function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new AppError('E_ID_TIME_RANGE', `时间戳超出 ULID 范围：${time}`);
  }
  let rest = time;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = ENCODING[rest % 32]! + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

export function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length < RANDOM_BYTES) {
    throw new AppError('E_ID_RANDOM_SHORT', `随机字节不足 ${RANDOM_BYTES} 个`);
  }
  let n = 0n;
  for (let i = 0; i < RANDOM_BYTES; i += 1) {
    n = (n << 8n) | BigInt(bytes[i]!);
  }
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out = ENCODING[Number(n & 31n)]! + out;
    n >>= 5n;
  }
  return out;
}

export function isUlid(value: string): boolean {
  if (value.length !== ULID_LENGTH) return false;
  const upper = value.toUpperCase();
  for (const char of upper) {
    if (!ENCODING.includes(char)) return false;
  }
  return true;
}

export function timeFromUlid(value: string): number {
  const upper = value.toUpperCase();
  if (!isUlid(upper)) {
    throw new AppError('E_ID_INVALID', `不是合法的 ULID：${value}`);
  }
  let time = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    time = time * 32 + ENCODING.indexOf(upper[i]!);
  }
  return time;
}

function increment(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i]! < 0xff) {
      bytes[i] = bytes[i]! + 1;
      return;
    }
    bytes[i] = 0;
  }
  throw new AppError('E_ID_OVERFLOW', '同一毫秒内的 ULID 随机位已用尽');
}

const PREFIX = {
  task: 'task_',
  run: 'run_',
  nodeRun: 'nrun_',
  gate: 'gate_',
  event: 'evt_',
  artifact: 'art_',
  message: 'msg_',
} as const;

export type IdFactory = {
  task(): TaskId;
  run(): RunId;
  nodeRun(): NodeRunId;
  gate(): GateId;
  event(): EventId;
  artifact(): ArtifactId;
  message(): MessageId;
};

export type IdFactoryOptions = {
  clock: Clock;
  /** 注入随机源，测试用 */
  random?: (size: number) => Uint8Array;
  /** 注入时间，测试用；默认读 clock.now() */
};

/**
 * 单调递增的 id 工厂：同一毫秒内随机位 +1，
 * 时钟回拨时沿用上一次的时间，保证 id 不倒退。
 */
export function createIdFactory(options: IdFactoryOptions): IdFactory {
  const random = options.random ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)));
  let lastTime = -1;
  let lastRandom: Uint8Array = new Uint8Array(RANDOM_BYTES);

  function next(prefix: string): string {
    const now = options.clock.now();
    if (now > lastTime) {
      lastTime = now;
      lastRandom = random(RANDOM_BYTES);
    } else {
      increment(lastRandom);
    }
    return `${prefix}${encodeTime(lastTime)}${encodeRandom(lastRandom)}`;
  }

  return {
    task: () => next(PREFIX.task) as TaskId,
    run: () => next(PREFIX.run) as RunId,
    nodeRun: () => next(PREFIX.nodeRun) as NodeRunId,
    gate: () => next(PREFIX.gate) as GateId,
    event: () => next(PREFIX.event) as EventId,
    artifact: () => next(PREFIX.artifact) as ArtifactId,
    message: () => next(PREFIX.message) as MessageId,
  };
}

/* ------------------------------------------------------------------ */
/* 边界转换：只在数据库、JSON、测试 fixture 处使用                      */
/* ------------------------------------------------------------------ */

export const asTaskId = (value: string): TaskId => value as TaskId;
export const asRunId = (value: string): RunId => value as RunId;
export const asNodeRunId = (value: string): NodeRunId => value as NodeRunId;
export const asGateId = (value: string): GateId => value as GateId;
export const asEventId = (value: string): EventId => value as EventId;
export const asArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const asMessageId = (value: string): MessageId => value as MessageId;

/** 去掉前缀后的 ULID 部分，用于解析时间。 */
export function idBody(value: string): string {
  const index = value.indexOf('_');
  return index === -1 ? value : value.slice(index + 1);
}
