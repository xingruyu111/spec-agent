import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@spec-agent/core';
import { MemoryJanitor } from '../../apps/server/src/work/memory-janitor.js';
import { WorkMemoryStore } from '../../apps/server/src/work/work-memory.js';
import { WorkService } from '../../apps/server/src/work/work-service.js';
import { WorkStore } from '../../apps/server/src/work/work-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('MemoryJanitor', () => {
  it('清理过期记忆与旧向量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-janitor-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const memories = new WorkMemoryStore(store.db, store.clock);
      const workStore = new WorkStore(store.db, store.clock);
      const work = new WorkService(workStore);
      const outbox = workStore.enqueueOutbox({
        projectId: 'p1',
        source: 'github',
        externalId: 'audit-1',
        workItemId: 'wi-audit',
        kind: 'comment',
        payload: { body: 'x' },
      });
      work.recordOutboxAttempt(outbox.id, { success: true });
      store.db
        .prepare('UPDATE work_outbox_attempts SET created_at = ?')
        .run('2000-01-01T00:00:00.000Z');
      const versioned = memories.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: 'v0',
        source: 'versioned',
      });
      memories.updateContent(versioned.id, 'p1', 'v1');
      memories.updateContent(versioned.id, 'p1', 'v2');
      memories.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '过期事实',
        source: 'expired',
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
      memories.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '长期事实',
        source: 'active',
      });
      store.db
        .prepare(
          `INSERT INTO work_memory_vectors (model, text_hash, vector, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('m1', 'old', '[1,0]', '2000-01-01T00:00:00.000Z');
      store.db
        .prepare(
          `INSERT INTO work_memory_vectors (model, text_hash, vector, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('m1', 'recent', '[0,1]', store.clock.iso());

      const janitor = new MemoryJanitor({
        memories,
        work,
        vectorDays: 30,
        versionDays: -1,
        keepVersions: 1,
        outboxAuditDays: 30,
      });
      const result = janitor.runOnce();
      expect(result.memories).toBe(1);
      expect(result.vectors).toBe(1);
      expect(result.versions).toBe(1);
      expect(result.attempts).toBe(1);
      expect(memories.listVersions(versioned.id, 'p1')).toHaveLength(1);
      expect(
        memories.list({
          projectId: 'p1',
          scopeType: 'project',
          scopeId: 'p1',
        }),
      ).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
