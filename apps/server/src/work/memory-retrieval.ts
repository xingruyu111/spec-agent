import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toMemory, cosine, normalize, rankMemories, rankVectorMemories, tokenize, vectorize } from './memory-ranking.js';
import type { WorkMemoryConflict, WorkMemoryRow, WorkMemoryScope, WorkMemorySearchHit } from './memory-types.js';
import { MemoryEmbeddingStore } from './memory-embeddings.js';
import { MemoryMaintenance } from './memory-maintenance.js';

type ListInput = {
  projectId: string;
  scopeType: WorkMemoryScope;
  scopeId: string;
  limit?: number;
  includeExpired?: boolean;
};

export class MemoryRetrieval {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly list: (input: ListInput) => WorkMemoryRow[],
    private readonly embeddings: MemoryEmbeddingStore,
    private readonly maintenance: MemoryMaintenance,
    private readonly hasProvider: boolean,
  ) {}

  private loadCandidates(
    projectId: string,
    scopeIds: Partial<Record<WorkMemoryScope, string>> | undefined,
    now: Date,
  ): WorkMemoryRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM work_memories
           WHERE project_id = ? ORDER BY updated_at DESC LIMIT 500`,
        )
        .all(projectId) as Array<Record<string, unknown>>
    )
      .map(toMemory)
      .filter((memory) => {
        if (memory.expiresAt && Date.parse(memory.expiresAt) <= now.getTime()) {
          return false;
        }
        const scopeId = scopeIds?.[memory.scopeType];
        return scopeId === undefined || scopeId === memory.scopeId;
      });
  }

  /**
   * 词法检索：中文 bigram + 英文词，BM25 近似打分，再叠加时间/置信度/决定权重。
   * 不引入向量库；先保证小数据量下可解释、可测试。
   */
  search(input: {
    projectId: string;
    query: string;
    scopeIds?: Partial<Record<WorkMemoryScope, string>>;
    limit?: number;
    /** 无词法命中时是否回退最近记忆；管理 UI 应传 false */
    fallback?: boolean;
    now?: Date;
  }): WorkMemorySearchHit[] {
    const now = input.now ?? new Date(this.clock.iso());
    const rows = this.loadCandidates(input.projectId, input.scopeIds, now);
    if (rows.length === 0) return [];

    const top = rankMemories({
      rows,
      query: input.query,
      now,
      limit: input.limit,
      fallback: input.fallback,
    });
    if (top.length > 0) {
      const usedAt = this.clock.iso();
      const statement = this.db.prepare(
        'UPDATE work_memories SET last_used_at = ? WHERE id = ?',
      );
      for (const hit of top) {
        statement.run(usedAt, hit.id);
        hit.lastUsedAt = usedAt;
      }
    }
    return top;
  }

  /**
   * 外部 Embedding 检索。未配置 provider 或调用失败时回退到本地词法检索。
   */
  async searchAsync(input: {
    projectId: string;
    query: string;
    scopeIds?: Partial<Record<WorkMemoryScope, string>>;
    limit?: number;
    fallback?: boolean;
    now?: Date;
  }): Promise<WorkMemorySearchHit[]> {
    if (!this.hasProvider) return this.search(input);
    const now = input.now ?? new Date(this.clock.iso());
    const rows = this.loadCandidates(input.projectId, input.scopeIds, now).slice(
      0,
      100,
    );
    if (rows.length === 0) return [];
    let queryVector: number[];
    let documentVectors: number[][];
    try {
      const vectors = await this.embeddings.embedTexts(
        [input.query, ...rows.map((memory) => memory.content)],
        input.projectId,
      );
      queryVector = vectors[0] ?? [];
      documentVectors = vectors.slice(1);
    } catch (error) {
      this.embeddings.recordFailure(
        input.projectId,
        error instanceof Error ? error.message : String(error),
      );
      return this.search(input);
    }
    if (queryVector.length === 0) return this.search(input);
    const top = rankVectorMemories({
      rows,
      query: input.query,
      vectors: documentVectors,
      queryVector,
      now,
      limit: input.limit,
      fallback: input.fallback,
    });
    const usedAt = this.clock.iso();
    const statement = this.db.prepare(
      'UPDATE work_memories SET last_used_at = ? WHERE id = ?',
    );
    for (const hit of top) {
      statement.run(usedAt, hit.id);
      hit.lastUsedAt = usedAt;
    }
    return top;
  }

  embeddingStats(projectId?: string) {
    return this.embeddings.stats(projectId);
  }

  cleanupVersions(options: { olderThanDays?: number; keepPerMemory?: number } = {}) {
    return this.maintenance.cleanupVersions(options);
  }

  cleanupVectors(options: { olderThanDays?: number } = {}) {
    return this.maintenance.cleanupVectors(options);
  }

  findConflicts(input: {
    projectId: string;
    scopeType: WorkMemoryScope;
    scopeId: string;
    content: string;
    threshold?: number;
    limit?: number;
  }): WorkMemoryConflict[] {
    const content = input.content.trim();
    if (!content) return [];
    const now = this.clock.iso();
    const rows = this.list({
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      limit: 200,
    });
    const queryTokens = new Set(tokenize(content));
    const queryVector = vectorize(content);
    const threshold = input.threshold ?? 0.35;
    return rows
      .filter(
        (memory) =>
          normalize(memory.content) !== normalize(content) &&
          (!memory.expiresAt || memory.expiresAt > now),
      )
      .map((memory) => {
        const tokens = new Set(tokenize(memory.content));
        const intersection = [...queryTokens].filter((token) =>
          tokens.has(token),
        ).length;
        const union = new Set([...queryTokens, ...tokens]).size;
        const jaccard = union === 0 ? 0 : intersection / union;
        const cosineScore = cosine(queryVector, vectorize(memory.content));
        return {
          memory,
          score: cosineScore * 0.7 + jaccard * 0.3,
        };
      })
      .filter((candidate) => candidate.score >= threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(Math.max(input.limit ?? 10, 1), 50));
  }

  forContext(input: {
    projectId: string;
    groupId?: string | null;
    agentId?: string | null;
    privateThreadId?: string | null;
    assignmentId?: string | null;
  }): WorkMemoryRow[] {
    const rows: WorkMemoryRow[] = [];
    const collect = (scopeType: WorkMemoryScope, scopeId: string, limit: number) => {
      rows.push(...this.list({ projectId: input.projectId, scopeType, scopeId, limit }));
    };
    collect('org', 'org', 5);
    collect('project', input.projectId, 10);
    if (input.groupId) collect('group', input.groupId, 10);
    if (input.agentId) collect('agent', input.agentId, 8);
    if (input.privateThreadId) collect('private', input.privateThreadId, 5);
    if (input.assignmentId) collect('execution', input.assignmentId, 5);
    return rows;
  }
}

