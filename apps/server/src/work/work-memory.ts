/**
 * v2 工作记忆。
 *
 * 作用域与 Work Item 绑定：execution / group / project / agent / private / org。
 * 记忆是派生视图，必须带 source；同一 source 重跑会更新而不是重复插入。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import type { EmbeddingProvider } from '../infra/embeddings.js';
import { MemoryEmbeddingStore } from './memory-embeddings.js';
import { MemoryMaintenance } from './memory-maintenance.js';
import { MemoryRetrieval } from './memory-retrieval.js';
import { MemoryWriter } from './memory-writer.js';

export type * from './memory-types.js';
import { cosine, fnv1a, normalize, rankMemories, rankVectorMemories, toMemory, tokenize, vectorize } from './memory-ranking.js';
import type { WorkMemoryScope, WorkMemoryRow, WorkMemorySearchHit, WorkMemoryConflict, WorkMemoryVersionRow } from './memory-types.js';

export class WorkMemoryStore {
  private readonly embeddings: MemoryEmbeddingStore;
  private readonly maintenance: MemoryMaintenance;
  private readonly retrieval: MemoryRetrieval;
  private readonly writer: MemoryWriter;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly options: {
      embeddingProvider?: EmbeddingProvider;
    } = {},
  ) {
    this.embeddings = new MemoryEmbeddingStore(db, clock, options.embeddingProvider);
    this.maintenance = new MemoryMaintenance(db, clock, () => this.embeddings.clear());
    this.retrieval = new MemoryRetrieval(
      db,
      clock,
      (input) => this.list(input),
      this.embeddings,
      this.maintenance,
      Boolean(options.embeddingProvider),
    );
    this.writer = new MemoryWriter(db, clock, (input) => this.retrieval.findConflicts(input));
  }


  write(input: Parameters<MemoryWriter['write']>[0]) {
    return this.writer.write(input);
  }

  list(input: {
    projectId: string;
    scopeType: WorkMemoryScope;
    scopeId: string;
    limit?: number;
    includeExpired?: boolean;
  }): WorkMemoryRow[] {
    const now = this.clock.iso();
    const rows = this.db
      .prepare(
        `SELECT * FROM work_memories
         WHERE project_id = ? AND scope_type = ? AND scope_id = ?
           ${input.includeExpired ? '' : 'AND (expires_at IS NULL OR expires_at > ?)'}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(
        input.projectId,
        input.scopeType,
        input.scopeId,
        ...(input.includeExpired ? [] : [now]),
        Math.min(Math.max(input.limit ?? 20, 1), 100),
      ) as Array<Record<string, unknown>>;
    return rows.map(toMemory);
  }

  cleanupExpiredAll() {
    return this.maintenance.cleanupExpiredAll();
  }

  cleanupExpired(projectId: string) {
    return this.maintenance.cleanupExpired(projectId);
  }

  delete(id: string, projectId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM work_memories WHERE id = ? AND project_id = ?')
      .run(id, projectId);
    return Number(result.changes) > 0;
  }

  getMemory(id: string, projectId: string): WorkMemoryRow | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM work_memories WHERE id = ? AND project_id = ?',
      )
      .get(id, projectId) as Record<string, unknown> | undefined;
    return row ? toMemory(row) : undefined;
  }

  updateContent(
    id: string,
    projectId: string,
    content: string,
  ): WorkMemoryRow | undefined {
    const next = content.trim().slice(0, 4000);
    if (!next) throw new Error('memory content 不能为空');
    const current = this.db
      .prepare(
        'SELECT * FROM work_memories WHERE id = ? AND project_id = ?',
      )
      .get(id, projectId) as Record<string, unknown> | undefined;
    if (!current) return undefined;
    const previous = toMemory(current);
    if (previous.content !== next) {
      this.db
        .prepare(
          `INSERT INTO work_memory_versions
             (id, memory_id, project_id, content, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `memver-${randomUUID()}`,
          id,
          projectId,
          previous.content,
          previous.source,
          this.clock.iso(),
        );
    }
    this.db
      .prepare(
        `UPDATE work_memories SET content = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(next, this.clock.iso(), id, projectId);
    const row = this.db
      .prepare(
        'SELECT * FROM work_memories WHERE id = ? AND project_id = ?',
      )
      .get(id, projectId) as Record<string, unknown> | undefined;
    return row ? toMemory(row) : undefined;
  }

  restoreVersion(
    memoryId: string,
    versionId: string,
    projectId: string,
  ): WorkMemoryRow | undefined {
    const version = this.db
      .prepare(
        `SELECT * FROM work_memory_versions
         WHERE id = ? AND memory_id = ? AND project_id = ?`,
      )
      .get(versionId, memoryId, projectId) as
      | Record<string, unknown>
      | undefined;
    if (!version) return undefined;
    return this.updateContent(memoryId, projectId, String(version.content));
  }

  listVersions(
    memoryId: string,
    projectId: string,
  ): WorkMemoryVersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_memory_versions
         WHERE memory_id = ? AND project_id = ?
         ORDER BY created_at DESC`,
      )
      .all(memoryId, projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      memoryId: String(row.memory_id),
      content: String(row.content),
      source: row.source == null ? null : String(row.source),
      createdAt: String(row.created_at),
    }));
  }

  expire(id: string, projectId: string, at?: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE work_memories SET expires_at = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(at ?? this.clock.iso(), this.clock.iso(), id, projectId);
    return Number(result.changes) > 0;
  }

  search(input: {
    projectId: string;
    query: string;
    scopeIds?: Partial<Record<WorkMemoryScope, string>>;
    limit?: number;
    fallback?: boolean;
    now?: Date;
  }) {
    return this.retrieval.search(input);
  }

  async searchAsync(input: {
    projectId: string;
    query: string;
    scopeIds?: Partial<Record<WorkMemoryScope, string>>;
    limit?: number;
    fallback?: boolean;
    now?: Date;
  }) {
    return this.retrieval.searchAsync(input);
  }

  embeddingStats(projectId?: string) {
    return this.retrieval.embeddingStats(projectId);
  }

  cleanupVersions(options: { olderThanDays?: number; keepPerMemory?: number } = {}) {
    return this.retrieval.cleanupVersions(options);
  }

  cleanupVectors(options: { olderThanDays?: number } = {}) {
    return this.retrieval.cleanupVectors(options);
  }

  findConflicts(input: {
    projectId: string;
    scopeType: WorkMemoryScope;
    scopeId: string;
    content: string;
    threshold?: number;
    limit?: number;
  }) {
    return this.retrieval.findConflicts(input);
  }

  forContext(input: {
    projectId: string;
    groupId?: string | null;
    agentId?: string | null;
    privateThreadId?: string | null;
    assignmentId?: string | null;
  }) {
    return this.retrieval.forContext(input);
  }
}

export class WorkMemoryWriter {
  constructor(private readonly store: WorkMemoryStore) {}

  recordCompletion(input: {
    projectId: string;
    groupId?: string | null;
    privateThreadId?: string | null;
    agentId: string;
    assignmentId: string;
    workItemId: string;
    title: string;
    kind: 'done' | 'blocked';
    summary: string;
  }): void {
    const content = `[${input.kind}] ${input.title}：${input.summary.slice(0, 1200)}`;
    this.store.write({
      projectId: input.projectId,
      scopeType: 'execution',
      scopeId: input.assignmentId,
      agentId: input.agentId,
      kind: 'summary',
      content,
      source: `assignment:${input.assignmentId}`,
      ttlDays: 30,
    });
    if (input.groupId) {
      this.store.write({
        projectId: input.projectId,
        scopeType: 'group',
        scopeId: input.groupId,
        agentId: input.agentId,
        kind: input.kind === 'done' ? 'decision' : 'blocker',
        content,
        source: `workitem:${input.workItemId}`,
        autoResolveConflicts: true,
        ttlDays: 90,
      });
    }
    if (input.privateThreadId) {
      this.store.write({
        projectId: input.projectId,
        scopeType: 'private',
        scopeId: input.privateThreadId,
        agentId: input.agentId,
        kind: 'summary',
        content,
        source: `workitem:${input.workItemId}`,
        ttlDays: 180,
      });
    }
    if (input.kind === 'done') {
      this.store.write({
        projectId: input.projectId,
        scopeType: 'project',
        scopeId: input.projectId,
        agentId: null,
        kind: 'summary',
        content,
        source: `workitem:${input.workItemId}`,
        confidence: 0.8,
        autoResolveConflicts: true,
      });
    }
  }
}

