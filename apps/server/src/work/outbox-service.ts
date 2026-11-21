import type { WorkOutboxRow, WorkStore } from './work-store.js';

export class OutboxService {
  constructor(private readonly store: WorkStore) {}

  outbox(projectId: string, status?: 'pending' | 'sent' | 'failed') {
    return this.store.listOutbox(projectId, status);
  }

  outboxItem(id: string) {
    return this.store.getOutbox(id);
  }

  outboxAttempts(id: string) {
    return this.store.listOutboxAttempts(id);
  }

  cleanupOutboxAttempts(olderThanDays = 180) {
    return this.store.cleanupOutboxAttempts(olderThanDays);
  }

  outboxAudit(projectId: string) {
    return this.store.listProjectOutboxAttempts(projectId);
  }

  noteOutboxResult(
    row: WorkOutboxRow,
    ok: boolean,
    error?: string | null,
  ): void {
    this.store.appendEvent({
      projectId: row.projectId,
      groupId: row.groupId,
      type: ok ? 'outbox.sent' : 'outbox.failed',
      actor: { type: 'system', id: 'outbox' },
      payload: {
        outboxId: row.id,
        source: row.source,
        externalId: row.externalId,
        ...(error ? { error } : {}),
      },
      correlationId: `outbox:${row.id}`,
    });
  }

  markOutbox(id: string, status: 'pending' | 'sent' | 'failed') {
    return this.store.markOutbox(id, status);
  }

  pendingOutbox(projectId: string, limit = 20) {
    return this.store.listPendingOutbox(projectId, limit);
  }

  pendingOutboxAll(limit = 50) {
    return this.store.listPendingOutboxAll(limit);
  }

  recordOutboxAttempt(
    id: string,
    input: { success: boolean; error?: string; nextAttemptAt?: string | null },
  ) {
    return this.store.recordOutboxAttempt(id, input);
  }

  retryOutbox(id: string) {
    return this.store.retryOutbox(id);
  }

}
