import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toOutbox } from './rows.js';
import type { WorkOutboxAttemptRow, WorkOutboxRow } from './types.js';

export class WorkOutboxRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  enqueueOutbox(input: {
    projectId: string;
    groupId?: string | null;
    workItemId?: string | null;
    source: string;
    externalId?: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }): WorkOutboxRow {
    const existing =
      input.externalId && input.workItemId
        ? (this.db
            .prepare(
              `SELECT * FROM work_outbox
               WHERE project_id = ? AND source = ? AND external_id = ?
                 AND work_item_id = ? AND kind = ?`,
            )
            .get(
              input.projectId,
              input.source,
              input.externalId,
              input.workItemId,
              input.kind,
            ) as Record<string, unknown> | undefined)
        : undefined;
    if (existing) return toOutbox(existing);
    const now = this.clock.iso();
    const row: WorkOutboxRow = {
      id: `outbox-${randomUUID()}`,
      projectId: input.projectId,
      groupId: input.groupId ?? null,
      workItemId: input.workItemId ?? null,
      source: input.source,
      externalId: input.externalId ?? null,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO work_outbox
           (id, project_id, group_id, work_item_id, source, external_id,
            kind, payload, status, attempts, max_attempts, last_error,
            next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.groupId,
        row.workItemId,
        row.source,
        row.externalId,
        row.kind,
        JSON.stringify(row.payload),
        row.status,
        row.attempts,
        row.maxAttempts,
        row.lastError,
        row.nextAttemptAt,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  listProjectOutboxAttempts(projectId: string): Array<
    WorkOutboxAttemptRow & {
      externalId: string | null;
      source: string;
      workItemId: string | null;
    }
  > {
    const rows = this.db
      .prepare(
        `SELECT a.*, o.external_id, o.source, o.work_item_id
         FROM work_outbox_attempts a
         JOIN work_outbox o ON o.id = a.outbox_id
         WHERE o.project_id = ?
         ORDER BY a.created_at DESC LIMIT 2000`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      outboxId: String(row.outbox_id),
      attempt: Number(row.attempt),
      ok: Number(row.ok) === 1,
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
      externalId: row.external_id == null ? null : String(row.external_id),
      source: String(row.source),
      workItemId: row.work_item_id == null ? null : String(row.work_item_id),
    }));
  }

  cleanupOutboxAttempts(olderThanDays = 180): number {    const cutoff = new Date(
      Date.now() - Math.max(olderThanDays, 0) * 86_400_000,
    ).toISOString();
    const result = this.db
      .prepare('DELETE FROM work_outbox_attempts WHERE created_at < ?')
      .run(cutoff);
    return Number(result.changes);
  }

  listOutboxAttempts(    outboxId: string,
    limit = 50,
  ): WorkOutboxAttemptRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_outbox_attempts
         WHERE outbox_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(outboxId, Math.min(Math.max(limit, 1), 200)) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      outboxId: String(row.outbox_id),
      attempt: Number(row.attempt),
      ok: Number(row.ok) === 1,
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
    }));
  }

  getOutbox(id: string): WorkOutboxRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM work_outbox WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toOutbox(row) : undefined;
  }

  listOutbox(    projectId: string,
    status?: WorkOutboxRow['status'],
    limit = 100,
  ): WorkOutboxRow[] {
    const rows = status
      ? (this.db
          .prepare(
            `SELECT * FROM work_outbox
             WHERE project_id = ? AND status = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(projectId, status, Math.min(Math.max(limit, 1), 500)) as Array<
          Record<string, unknown>
        >)
      : (this.db
          .prepare(
            `SELECT * FROM work_outbox
             WHERE project_id = ?
             ORDER BY created_at ASC LIMIT ?`,
          )
          .all(projectId, Math.min(Math.max(limit, 1), 500)) as Array<
          Record<string, unknown>
        >);
    return rows.map(toOutbox);
  }

  markOutbox(
    id: string,
    status: WorkOutboxRow['status'],
  ): WorkOutboxRow | undefined {
    this.db
      .prepare(
        'UPDATE work_outbox SET status = ?, updated_at = ? WHERE id = ?',
      )
      .run(status, this.clock.iso(), id);
    const row = this.db
      .prepare('SELECT * FROM work_outbox WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toOutbox(row) : undefined;
  }

  listPendingOutbox(projectId: string, limit = 20): WorkOutboxRow[] {
    const now = this.clock.iso();
    const rows = this.db
      .prepare(
        `SELECT * FROM work_outbox
         WHERE project_id = ? AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(projectId, now, Math.min(Math.max(limit, 1), 100)) as Array<
      Record<string, unknown>
    >;
    return rows.map(toOutbox);
  }

  listPendingOutboxAll(limit = 50): WorkOutboxRow[] {
    const now = this.clock.iso();
    const rows = this.db
      .prepare(
        `SELECT * FROM work_outbox
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(now, Math.min(Math.max(limit, 1), 200)) as Array<
      Record<string, unknown>
    >;
    return rows.map(toOutbox);
  }

  retryOutbox(id: string): WorkOutboxRow | undefined {
    this.db
      .prepare(
        `UPDATE work_outbox
         SET status = 'pending', attempts = 0, last_error = NULL,
             next_attempt_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.clock.iso(), id);
    const row = this.db
      .prepare('SELECT * FROM work_outbox WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toOutbox(row) : undefined;
  }

  recordOutboxAttempt(
    id: string,
    input: {
      success: boolean;
      error?: string;
      nextAttemptAt?: string | null;
    },
  ): WorkOutboxRow | undefined {    const current = this.db
      .prepare('SELECT * FROM work_outbox WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!current) return undefined;
    const row = toOutbox(current);
    const attempts = input.success ? row.attempts : row.attempts + 1;
    const status = input.success
      ? 'sent'
      : attempts >= row.maxAttempts
        ? 'failed'
        : 'pending';
    this.db
      .prepare(
        `INSERT INTO work_outbox_attempts
           (id, outbox_id, attempt, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `outbox-attempt-${randomUUID()}`,
        id,
        Math.max(row.attempts + 1, 1),
        input.success ? 1 : 0,
        input.success ? null : input.error ?? '发送失败',
        this.clock.iso(),
      );
    this.db
      .prepare(
        `UPDATE work_outbox
         SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        attempts,
        input.success ? null : input.error ?? '发送失败',
        input.success ? null : input.nextAttemptAt ?? null,
        this.clock.iso(),
        id,
      );
    const updated = this.db
      .prepare('SELECT * FROM work_outbox WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return updated ? toOutbox(updated) : undefined;
  }

}

