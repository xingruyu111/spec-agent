/**
 * Outbox Worker：把 pending 回执发送到外部 transport。
 * 失败按指数退避，attempts 达到 maxAttempts 后标记 failed。
 */

import type { WorkOutboxRow } from './work-store.js';
import type { WorkService } from './work-service.js';

export { createOutboxTransport, GitHubCommentTransport, parseGitHubIssueUrl, parseReviewCommentId, type OutboxTransport } from './outbox-transports.js';
import type { OutboxTransport } from './outbox-transports.js';

export type OutboxWorkerOptions = {
  work: WorkService;
  projectId?: string;
  transport: OutboxTransport;
  intervalMs?: number;
};

export class OutboxWorker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: OutboxWorkerOptions) {}

  async runOne(id: string): Promise<{
    outbox: WorkOutboxRow | undefined;
    error?: string;
  }> {
    const row = this.options.work.outboxItem(id);
    if (!row) return { outbox: undefined, error: '回执不存在' };
    if (row.status !== 'pending') {
      return { outbox: row, error: `回执状态为 ${row.status}` };
    }
    try {
      await this.options.transport.send(row);
      const updated = this.options.work.recordOutboxAttempt(row.id, {
        success: true,
      });
      this.options.work.noteOutboxResult(row, true);
      return { outbox: updated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = row.attempts + 1;
      const nextAttemptAt =
        attempts >= row.maxAttempts
          ? null
          : new Date(Date.now() + Math.min(60_000, 2 ** attempts * 1000))
              .toISOString();
      const updated = this.options.work.recordOutboxAttempt(row.id, {
        success: false,
        error: message,
        nextAttemptAt,
      });
      this.options.work.noteOutboxResult(row, false, message);
      return {
        outbox: updated,
        error: message,
      };
    }
  }

  async runOnce(): Promise<{ sent: number; failed: number; pending: number }> {    const rows = this.options.projectId
      ? this.options.work.pendingOutbox(this.options.projectId)
      : this.options.work.pendingOutboxAll();
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.options.transport.send(row);
        this.options.work.recordOutboxAttempt(row.id, { success: true });
        this.options.work.noteOutboxResult(row, true);
        sent += 1;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const attempts = row.attempts + 1;
        const nextAttemptAt =
          attempts >= row.maxAttempts
            ? null
            : new Date(
                Date.now() + Math.min(60_000, 2 ** attempts * 1000),
              ).toISOString();
        const updated = this.options.work.recordOutboxAttempt(row.id, {
          success: false,
          error: message,
          nextAttemptAt,
        });
        this.options.work.noteOutboxResult(row, false, message);
        if (updated?.status === 'failed') failed += 1;
      }
    }
    return { sent, failed, pending: rows.length - sent - failed };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.error('[outbox-worker]', error);
      });
    }, this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}



