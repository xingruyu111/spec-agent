/**
 * 稳定序列化：key 排序、丢弃 undefined。
 * 用于算 spec hash，必须保证同样内容得到同样字符串，
 * 不管对象字面量的 key 顺序如何。
 */

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    out[key] = sortValue(item);
  }
  return out;
}
