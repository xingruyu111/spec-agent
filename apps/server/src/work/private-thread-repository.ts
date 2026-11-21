import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toPrivateMessage, toPrivateThread } from './rows.js';
import type { PrivateMessageRow, PrivateThreadRow, WorkActorType } from './types.js';

export class PrivateThreadRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  getPrivateThread(id: string): PrivateThreadRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM private_threads WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toPrivateThread(row) : undefined;
  }

  getOrCreatePrivateThread(input: {
    projectId: string;
    agentId: string;
    userId: string;
  }): PrivateThreadRow {    const existing = this.db
      .prepare(
        `SELECT * FROM private_threads
         WHERE project_id = ? AND agent_id = ? AND user_id = ?`,
      )
      .get(input.projectId, input.agentId, input.userId) as
      | Record<string, unknown>
      | undefined;
    if (existing) return toPrivateThread(existing);
    const now = this.clock.iso();
    const row: PrivateThreadRow = {
      id: `dm-${randomUUID()}`,
      projectId: input.projectId,
      agentId: input.agentId,
      userId: input.userId,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO private_threads
           (id, project_id, agent_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.agentId,
        row.userId,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  addPrivateMessage(input: {
    threadId: string;
    actorType: WorkActorType;
    actorId: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): PrivateMessageRow {
    const row: PrivateMessageRow = {
      id: `dmmsg-${randomUUID()}`,
      threadId: input.threadId,
      actorType: input.actorType,
      actorId: input.actorId,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO private_messages
           (id, thread_id, actor_type, actor_id, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.threadId,
        row.actorType,
        row.actorId,
        row.content,
        JSON.stringify(row.metadata),
        row.createdAt,
      );
    this.db
      .prepare('UPDATE private_threads SET updated_at = ? WHERE id = ?')
      .run(row.createdAt, row.threadId);
    return row;
  }

  listPrivateMessages(threadId: string, limit = 200): PrivateMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM private_messages
         WHERE thread_id = ? ORDER BY created_at LIMIT ?`,
      )
      .all(threadId, Math.min(Math.max(limit, 1), 500)) as Array<
      Record<string, unknown>
    >;
    return rows.map(toPrivateMessage);
  }

}
