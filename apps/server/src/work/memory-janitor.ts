/**
 * 记忆 Janitor：定时清理过期记忆与旧 embedding 向量。
 * 默认一小时一次；错误只记录，不影响服务。
 */

import type { WorkMemoryStore } from './work-memory.js';
import type { WorkService } from './work-service.js';

export type MemoryJanitorOptions = {
  memories: WorkMemoryStore;
  work?: WorkService;
  intervalMs?: number;
  vectorDays?: number;
  versionDays?: number;
  keepVersions?: number;
  outboxAuditDays?: number;
  runOnStart?: boolean;
};

export class MemoryJanitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: MemoryJanitorOptions) {}

  runOnce(): {
    memories: number;
    vectors: number;
    versions: number;
    attempts: number;
  } {
    const memories = this.options.memories.cleanupExpiredAll();
    const vectors = this.options.memories.cleanupVectors({
      olderThanDays: this.options.vectorDays ?? 30,
    });
    const versions = this.options.memories.cleanupVersions({
      olderThanDays: this.options.versionDays ?? 90,
      keepPerMemory: this.options.keepVersions ?? 10,
    });
    const attempts =
      this.options.work?.cleanupOutboxAttempts(
        this.options.outboxAuditDays ?? 180,
      ) ?? 0;
    return { memories, vectors, versions, attempts };
  }

  start(): void {
    if (this.timer) return;
    if (this.options.runOnStart) {
      try {
        this.runOnce();
      } catch (error) {
        console.error('[memory-janitor]', error);
      }
    }
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch (error) {
        console.error('[memory-janitor]', error);
      }
    }, this.options.intervalMs ?? 3_600_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
