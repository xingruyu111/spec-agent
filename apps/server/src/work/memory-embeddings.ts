import { createHash } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import type { EmbeddingProvider } from '../infra/embeddings.js';

export class MemoryEmbeddingStore {
  private readonly cache = new Map<string, number[]>();
  private metrics = { calls: 0, failures: 0, lastError: null as string | null };

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly provider?: EmbeddingProvider,
  ) {
    const model = provider?.model;
    if (!model) return;
    const row = this.db
      .prepare('SELECT * FROM work_embedding_metrics WHERE model = ?')
      .get(model) as { calls?: number; failures?: number; last_error?: string | null } | undefined;
    if (row) {
      this.metrics = {
        calls: Number(row.calls ?? 0),
        failures: Number(row.failures ?? 0),
        lastError: row.last_error ?? null,
      };
    }
  }

  recordFailure(projectId: string | undefined, message: string): void {
    this.metrics.failures += 1;
    this.metrics.lastError = message;
    this.persist(0, 1, this.metrics.lastError, projectId);
  }

  clear(): void {
    this.cache.clear();
  }

  async embedTexts(
    texts: string[],
    projectId?: string,
  ): Promise<number[][]> {
    const provider = this.provider;
    if (!provider) throw new Error('embedding provider 未配置');
    const vectors = texts.map((text) => this.cachedVector(text));
    const missing = texts.filter((_, index) => !vectors[index]);
    const uniqueMissing = [...new Set(missing)];
    if (uniqueMissing.length > 0) {
      this.metrics.calls += 1;
      this.persist(1, 0, null, projectId);
      const embedded = await provider.embed(uniqueMissing);
      const byText = new Map<string, number[]>();
      uniqueMissing.forEach((text, index) => {
        const vector = embedded[index];
        if (vector) byText.set(text, vector);
      });
      for (const text of uniqueMissing) {
        const vector = byText.get(text);
        if (vector) this.storeVector(text, vector);
      }
      texts.forEach((text, index) => {
        if (!vectors[index]) vectors[index] = byText.get(text);
      });
    }
    return vectors.map((vector, index) => {
      if (!vector) throw new Error(`embedding 缓存缺失：${index}`);
      return vector;
    });
  }

  private cachedVector(text: string): number[] | undefined {
    const key = this.embeddingKey(text);
    const inMemory = this.cache.get(key);
    if (inMemory) return inMemory;
    const provider = this.provider;
    if (!provider) return undefined;
    const row = this.db
      .prepare(
        `SELECT vector FROM work_memory_vectors
         WHERE model = ? AND text_hash = ?`,
      )
      .get(provider.model, this.textHash(text)) as
      | { vector?: string }
      | undefined;
    if (!row?.vector) return undefined;
    try {
      const vector = JSON.parse(row.vector) as number[];
      this.cache.set(key, vector);
      return vector;
    } catch {
      return undefined;
    }
  }

  private storeVector(text: string, vector: number[]): void {
    const provider = this.provider;
    if (!provider) return;
    this.cache.set(this.embeddingKey(text), vector);
    this.db
      .prepare(
        `INSERT INTO work_memory_vectors
           (model, text_hash, vector, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(model, text_hash) DO UPDATE SET
           vector = excluded.vector, updated_at = excluded.updated_at`,
      )
      .run(
        provider.model,
        this.textHash(text),
        JSON.stringify(vector),
        this.clock.iso(),
      );
  }

  private textHash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  private embeddingKey(text: string): string {
    return `${this.provider?.model ?? 'local'}:${text}`;
  }

  private persist(
    callsDelta: number,
    failuresDelta: number,
    lastError: string | null,
    projectId?: string,
  ): void {
    const model = this.provider?.model;
    if (!model) return;
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO work_embedding_metrics
           (model, calls, failures, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET
           calls = calls + excluded.calls,
           failures = failures + excluded.failures,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run(model, callsDelta, failuresDelta, lastError, now);
    if (projectId) {
      this.db
        .prepare(
          `INSERT INTO work_embedding_project_metrics
             (project_id, model, calls, failures, last_error, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, model) DO UPDATE SET
             calls = calls + excluded.calls,
             failures = failures + excluded.failures,
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
        .run(
          projectId,
          model,
          callsDelta,
          failuresDelta,
          lastError,
          now,
        );
    }
  }

  stats(projectId?: string): {
    model: string | null;
    calls: number;
    failures: number;
    lastError: string | null;
    vectors: number;
    cachedTexts: number;
    project: {
      calls: number;
      failures: number;
      lastError: string | null;
    } | null;
  } {
    const model = this.provider?.model ?? null;
    const row = model
      ? (this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM work_memory_vectors WHERE model = ?',
          )
          .get(model) as { count?: number })
      : undefined;
    const projectRow =
      projectId && model
        ? (this.db
            .prepare(
              `SELECT calls, failures, last_error
               FROM work_embedding_project_metrics
               WHERE project_id = ? AND model = ?`,
            )
            .get(projectId, model) as
            | {
                calls?: number;
                failures?: number;
                last_error?: string | null;
              }
            | undefined)
        : undefined;
    return {
      model,
      ...this.metrics,
      vectors: Number(row?.count ?? 0),
      cachedTexts: this.cache.size,
      project: projectRow
        ? {
            calls: Number(projectRow.calls ?? 0),
            failures: Number(projectRow.failures ?? 0),
            lastError: projectRow.last_error ?? null,
          }
        : null,
    };
  }

}
