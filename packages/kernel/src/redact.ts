/**
 * 脱敏。
 *
 * 两道防线：
 * 1. 按字段名：token / secret / password / authorization / apiKey ...
 * 2. 按值的形态：sk-、ghp_、AKIA、Bearer ...
 *
 * 目标是"日志和事件里不出现明文密钥"。做不到绝对安全，
 * 但能挡住最常见的泄露路径。
 */

import { toErrorInfo } from './errors.js';

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

const SECRET_KEY =
  /(token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key)/i;

const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[A-Za-z0-9_-]{12,}/g, replacement: 'sk-***' },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, replacement: 'ghp_***' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA***' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, replacement: '$1***' },
];

export function redactString(text: string): string {
  let out = text;
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactValue(value: unknown): unknown {
  return walk(value, new WeakSet<object>(), 0);
}

function walk(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return toErrorInfo(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, seen, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : walk(item, seen, depth + 1);
  }
  return out;
}
