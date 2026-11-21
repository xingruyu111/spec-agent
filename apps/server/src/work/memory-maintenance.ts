import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';

export class MemoryMaintenance {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly clearVectors: () => void,
  ) {}

  cleanupExpiredAll(): number {
    const now = this.clock.iso();
    const result = this.db
      .prepare(
        `DELETE FROM work_memories
         WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(now);
    return Number(result.changes);
  }

  cleanupExpired(projectId: string): number {    const result = this.db
      .prepare(
        `DELETE FROM work_memories
         WHERE project_id = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(projectId, this.clock.iso());
    return Number(result.changes);
  }


  cleanupVersions(
    options: { olderThanDays?: number; keepPerMemory?: number } = {},
  ): number {
    const days = options.olderThanDays ?? 90;
    const keep = Math.max(Math.floor(options.keepPerMemory ?? 10), 1);
    let deleted = 0;
    if (days >= 0) {
      const cutoff = new Date(
        Date.now() - days * 86_400_000,
      ).toISOString();
      deleted += Number(
        this.db
          .prepare('DELETE FROM work_memory_versions WHERE created_at < ?')
          .run(cutoff).changes,
      );
    }
    deleted += Number(
      this.db
        .prepare(
          `DELETE FROM work_memory_versions WHERE id IN (
             SELECT id FROM (
               SELECT id,
                      ROW_NUMBER() OVER (
                        PARTITION BY memory_id ORDER BY created_at DESC
                      ) AS rank
               FROM work_memory_versions
             ) WHERE rank > ?
           )`,
        )
        .run(keep).changes,
    );
    return deleted;
  }

  cleanupVectors(options: { olderThanDays?: number } = {}): number {    const days = options.olderThanDays ?? 30;
    const result =
      days < 0
        ? this.db.prepare('DELETE FROM work_memory_vectors').run()
        : this.db
            .prepare('DELETE FROM work_memory_vectors WHERE updated_at < ?')
            .run(
              new Date(Date.now() - days * 86_400_000).toISOString(),
            );
    this.clearVectors();
    return Number(result.changes);
  }

  /**
   * 同作用域相似事实检测。相似度高且内容不同才视为冲突候选。
   */
}

