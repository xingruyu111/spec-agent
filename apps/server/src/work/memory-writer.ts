import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { normalize, toMemory } from './memory-ranking.js';
import type { WorkMemoryConflict, WorkMemoryRow, WorkMemoryScope } from './memory-types.js';

type FindConflicts = (input: {
  projectId: string;
  scopeType: WorkMemoryScope;
  scopeId: string;
  content: string;
  threshold?: number;
  limit?: number;
}) => WorkMemoryConflict[];

export class MemoryWriter {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly findConflicts: FindConflicts,
  ) {}

  write(input: {
    projectId: string;
    scopeType: WorkMemoryScope;
    scopeId: string;
    agentId?: string | null;
    kind?: string;
    content: string;
    source?: string | null;
    confidence?: number;
    expiresAt?: string | null;
    /** 相对 TTL；与 expiresAt 二选一 */
    ttlDays?: number;
    supersedes?: string[];
    /** 自动把同作用域高相似旧事实标记过期 */
    autoResolveConflicts?: boolean;
  }): WorkMemoryRow {
    const content = input.content.trim().slice(0, 4000);
    if (!content) throw new Error('memory content 不能为空');
    const now = this.clock.iso();
    const expiresAt =
      input.expiresAt ??
      (input.ttlDays !== undefined
        ? new Date(
            new Date(now).getTime() + input.ttlDays * 86_400_000,
          ).toISOString()
        : null);
    const conflicts = input.autoResolveConflicts
      ? this.findConflicts({
          projectId: input.projectId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          content,
          threshold: 0.35,
          limit: 20,
        }).map((conflict) => conflict.memory.id)
      : [];
    for (const id of [...(input.supersedes ?? []), ...conflicts]) {
      this.db
        .prepare(
          `UPDATE work_memories SET expires_at = ?, updated_at = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(now, now, id, input.projectId);
    }
    const existing = input.source
      ? (this.db
          .prepare(
            `SELECT * FROM work_memories
             WHERE project_id = ? AND scope_type = ? AND scope_id = ? AND source = ?`,
          )
          .get(
            input.projectId,
            input.scopeType,
            input.scopeId,
            input.source,
          ) as Record<string, unknown> | undefined)
      : undefined;
    if (existing) {
      const row = toMemory(existing);
      this.db
        .prepare(
          `UPDATE work_memories
           SET content = ?, kind = ?, confidence = ?, expires_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          content,
          input.kind ?? row.kind,
          Math.min(Math.max(input.confidence ?? row.confidence, 0), 1),
          expiresAt ?? row.expiresAt,
          now,
          row.id,
        );
      return {
        ...row,
        content,
        kind: input.kind ?? row.kind,
        confidence: input.confidence ?? row.confidence,
        expiresAt: expiresAt ?? row.expiresAt,
        updatedAt: now,
      };
    }
    const sameContent = (
      this.db
        .prepare(
          `SELECT * FROM work_memories
           WHERE project_id = ? AND scope_type = ? AND scope_id = ?
           ORDER BY updated_at DESC LIMIT 50`,
        )
        .all(input.projectId, input.scopeType, input.scopeId) as Array<
        Record<string, unknown>
      >
    )
      .map(toMemory)
      .find((memory) => normalize(memory.content) === normalize(content));
    if (sameContent) {
      this.db
        .prepare(
          `UPDATE work_memories
           SET content = ?, kind = ?, confidence = ?, expires_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          content,
          input.kind ?? sameContent.kind,
          Math.min(Math.max(input.confidence ?? sameContent.confidence, 0), 1),
          expiresAt ?? sameContent.expiresAt,
          now,
          sameContent.id,
        );
      return {
        ...sameContent,
        content,
        kind: input.kind ?? sameContent.kind,
        confidence: input.confidence ?? sameContent.confidence,
        expiresAt: expiresAt ?? sameContent.expiresAt,
        updatedAt: now,
      };
    }
    const row: WorkMemoryRow = {
      id: `mem-${randomUUID()}`,
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      agentId: input.agentId ?? null,
      kind: input.kind ?? 'fact',
      content,
      source: input.source ?? null,
      confidence: Math.min(Math.max(input.confidence ?? 1, 0), 1),
      expiresAt,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO work_memories
           (id, project_id, scope_type, scope_id, agent_id, kind, content,
            source, confidence, expires_at, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.scopeType,
        row.scopeId,
        row.agentId,
        row.kind,
        row.content,
        row.source,
        row.confidence,
        row.expiresAt,
        row.lastUsedAt,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

}
