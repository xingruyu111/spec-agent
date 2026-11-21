import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toWorkItem } from './rows.js';
import type { WorkActorType, WorkItemRow, WorkItemState } from './types.js';

export class WorkItemRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  createWorkItem(input: {
    projectId: string;
    groupId?: string | null;
    originEventId?: string | null;
    requestedBy: { type: WorkActorType; id: string };
    title: string;
    intent?: string | null;
    priority?: number;
    state?: WorkItemState;
  }): WorkItemRow {
    const now = this.clock.iso();
    const row: WorkItemRow = {
      id: `wi-${randomUUID()}`,
      projectId: input.projectId,
      groupId: input.groupId ?? null,
      originEventId: input.originEventId ?? null,
      requestedByType: input.requestedBy.type,
      requestedById: input.requestedBy.id,
      title: input.title,
      intent: input.intent ?? null,
      state: input.state ?? 'inbox',
      priority: input.priority ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO work_items
           (id, project_id, group_id, origin_event_id, requested_by_type,
            requested_by_id, title, intent, state, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.groupId,
        row.originEventId,
        row.requestedByType,
        row.requestedById,
        row.title,
        row.intent,
        row.state,
        row.priority,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  getWorkItem(id: string): WorkItemRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM work_items WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toWorkItem(row) : undefined;
  }

  listWorkItems(
    projectId: string,
    state?: WorkItemState,
    limit = 100,
  ): WorkItemRow[] {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const rows = state
      ? (this.db
          .prepare(
            `SELECT * FROM work_items
             WHERE project_id = ? AND state = ?
             ORDER BY priority DESC, created_at DESC LIMIT ?`,
          )
          .all(projectId, state, bounded) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `SELECT * FROM work_items
             WHERE project_id = ?
             ORDER BY priority DESC, created_at DESC LIMIT ?`,
          )
          .all(projectId, bounded) as Array<Record<string, unknown>>);
    return rows.map(toWorkItem);
  }

  updateWorkItem(id: string, patch: {
    state?: WorkItemState;
    title?: string;
    intent?: string | null;
    priority?: number;
  }): WorkItemRow {
    const current = this.getWorkItem(id);
    if (!current) throw new Error(`work item 不存在：${id}`);
    const next: WorkItemRow = {
      ...current,
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      updatedAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `UPDATE work_items
         SET state = ?, title = ?, intent = ?, priority = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.state,
        next.title,
        next.intent,
        next.priority,
        next.updatedAt,
        id,
      );
    return next;
  }

}
