import type { WorkMemoryRow, WorkMemoryScope, WorkMemorySearchHit } from './memory-types.js';

export function toMemory(row: Record<string, unknown>): WorkMemoryRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    scopeType: String(row.scope_type) as WorkMemoryScope,
    scopeId: String(row.scope_id),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    kind: String(row.kind),
    content: String(row.content),
    source: row.source == null ? null : String(row.source),
    confidence: Number(row.confidence ?? 1),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const word of lower.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    tokens.push(word);
  }
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const segment of cjk.split(/\s+/)) {
    if (segment.length === 1) {
      tokens.push(segment);
      continue;
    }
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.push(segment.slice(index, index + 2));
    }
  }
  return Array.from(new Set(tokens));
}

const VECTOR_DIMENSIONS = 256;

/**
 * 本地 hashed character n-gram 向量。
 * 不是神经 embedding；零外部依赖，作为 BM25 的补充相似度。
 */
export function vectorize(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  if (!text.trim()) return vector;
  const compact = text.toLowerCase().replace(/\s+/g, '');
  const features = [
    ...tokenize(text),
    ...Array.from(
      { length: Math.max(compact.length - 2, 0) },
      (_, index) => compact.slice(index, index + 3),
    ),
  ];
  for (const feature of features) {
    const hash = fnv1a(feature);
    const index = hash % VECTOR_DIMENSIONS;
    const sign = (hash >>> 8) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosine(left: number[], right: number[]): number {
  let dot = 0;
  for (let index = 0; index < VECTOR_DIMENSIONS; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}



export function rankMemories(input: {
  rows: WorkMemoryRow[];
  query: string;
  now: Date;
  limit?: number;
  fallback?: boolean;
}): WorkMemorySearchHit[] {
  const { rows, now } = input;
  const query = input.query.trim().toLowerCase();
  const tokens = tokenize(query);
  const queryVector = vectorize(query);
  const docs = rows.map((memory) => {
    const text = memory.content.toLowerCase();
    const docTokens = tokenize(text);
    return {
    memory,
    tokens: docTokens,
    vector: vectorize(text),
    length: Math.max(docTokens.length, 1),
    exact: query.length > 0 && text.includes(query),
    };
  });
  const avgLength =
    docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const documentFrequency = new Map<string, number>();
  for (const token of tokens) {
    documentFrequency.set(
    token,
    docs.filter((doc) => doc.tokens.includes(token)).length,
    );
  }
  const k1 = 1.2;
  const b = 0.75;
  const hits = docs.map((doc) => {
    let lexical = 0;
    for (const token of tokens) {
    const tf = doc.tokens.filter((item) => item === token).length;
    if (tf === 0) continue;
    const df = documentFrequency.get(token) ?? 0;
    const idf = Math.log(
      (docs.length - df + 0.5) / (df + 0.5) + 1,
    );
    lexical +=
      idf *
      ((tf * (k1 + 1)) /
      (tf + k1 * (1 - b + b * (doc.length / avgLength))));
    }
    const ageDays = Math.max(
    0,
    (now.getTime() - Date.parse(doc.memory.updatedAt)) / 86_400_000,
    );
    const recency = Math.exp(-ageDays / 45);
    const kindBonus = doc.memory.kind === 'decision' ? 0.25 : 0;
    const vectorScore = cosine(queryVector, doc.vector);
    return {
    ...doc.memory,
    matched:
      tokens.length === 0 ||
      lexical > 0 ||
      doc.exact ||
      vectorScore >= 0.25,
    lexicalScore: lexical,
    vectorScore,
    score:
      lexical +
      vectorScore * 1.4 +
      (doc.exact ? 4 : 0) +
      recency * 0.6 +
      doc.memory.confidence * 0.3 +
      kindBonus,
    };
  });
  const matched = hits.filter((hit) => hit.matched);
  const pool =
    matched.length > 0
    ? matched
    : input.fallback === false
      ? []
      : hits;
  if (pool.length === 0) return [];
  pool.sort(
    (left, right) =>
    right.score - left.score ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const top = pool.slice(0, Math.min(Math.max(input.limit ?? 8, 1), 30));
  return top;
}

export function rankVectorMemories(input: {
  rows: WorkMemoryRow[];
  query: string;
  vectors: number[][];
  queryVector: number[];
  now: Date;
  limit?: number;
  fallback?: boolean;
}): WorkMemorySearchHit[] {
  const { rows, vectors, now } = input;
  const query = input.query.trim().toLowerCase();
  const tokens = tokenize(query);
  const hits = rows.map((memory, index) => {
    const text = memory.content.toLowerCase();
    const docTokens = tokenize(text);
    const overlap =
    tokens.length === 0
      ? 0
      : tokens.filter((token) => docTokens.includes(token)).length /
      tokens.length;
    const vectorScore = cosine(input.queryVector, vectors[index] ?? []);
    const exact = query.length > 0 && text.includes(query);
    const ageDays = Math.max(
    0,
    (now.getTime() - Date.parse(memory.updatedAt)) / 86_400_000,
    );
    return {
    ...memory,
    lexicalScore: overlap,
    vectorScore,
    score:
      vectorScore * 2.2 +
      overlap * 1.2 +
      (exact ? 2 : 0) +
      Math.exp(-ageDays / 45) * 0.4 +
      memory.confidence * 0.2 +
      (memory.kind === 'decision' ? 0.2 : 0),
    };
  });
  const pool =
    input.fallback === false
    ? hits.filter((hit) => hit.vectorScore >= 0.15 || hit.lexicalScore > 0)
    : hits;
  if (pool.length === 0) return [];
  pool.sort((left, right) => right.score - left.score);
  const top = pool.slice(0, Math.min(Math.max(input.limit ?? 8, 1), 30));
  return top;
}
