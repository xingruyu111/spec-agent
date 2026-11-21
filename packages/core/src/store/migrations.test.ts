import { describe, expect, it } from 'vitest';
import { AppError } from '@spec-agent/kernel';
import { openDatabase, transaction } from './db.js';
import { migrate, MIGRATIONS, type Migration } from './migrations.js';
import { fixedClock } from './__fixtures__/index.js';

describe('migrate', () => {
  it('首次迁移建表并记录版本', () => {
    const db = openDatabase(':memory:');
    try {
      const result = migrate(db, fixedClock());
      expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]);
      expect(result.currentVersion).toBe(42);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'events',
          'tasks',
          'workflow_runs',
          'node_runs',
          'gates',
          'workflow_specs',
          'task_specs',
          'notification_outbox',
          'merge_queue',
          'chat_sessions',
          'chat_messages',
          'chat_participants',
          'chat_projects',
          'chat_workflow_drafts',
          'change_sets',
          'memories',
          'memory_extractions',
          'project_plans',
          'project_plan_items',
          'project_plan_drafts',
          'schema_migrations',
          'work_groups',
          'work_group_members',
          'domain_events',
          'work_items',
          'work_assignments',
          'work_reports',
          'private_threads',
          'private_messages',
          'work_memories',
          'work_assignment_deps',
          'work_outbox',
          'work_source_rules',
          'work_item_comments',
          'work_memory_vectors',
          'work_memory_versions',
          'work_embedding_metrics',
          'work_embedding_project_metrics',
          'work_outbox_attempts',
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('重复迁移不重复执行', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, fixedClock());
      const second = migrate(db, fixedClock());
      expect(second.applied).toEqual([]);
      expect(second.currentVersion).toBe(42);

      const rows = db.prepare('SELECT * FROM schema_migrations').all();
      expect(rows).toHaveLength(42);
    } finally {
      db.close();
    }
  });

  it('迁移时间来自注入的时钟', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, fixedClock());
      const row = db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 1').get() as {
        applied_at: string;
      };
      expect(row.applied_at).toBe('2026-10-26T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('v19 为旧会话补助理参与者并回填消息 sender', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, fixedClock(), MIGRATIONS.slice(0, 18));
      db.prepare(
        `INSERT INTO chat_sessions (id, title, mode, created_at, updated_at)
         VALUES ('old-session', '旧会话', 'qa', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO chat_messages
           (id, session_id, role, content, mode, status, created_at)
         VALUES ('old-user', 'old-session', 'user', '你好', 'qa', 'complete', '2026-01-01T00:00:01.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO chat_messages
           (id, session_id, role, content, mode, status, created_at)
         VALUES ('old-assistant', 'old-session', 'assistant', '你好', 'qa', 'complete', '2026-01-01T00:00:02.000Z')`,
      ).run();

      const result = migrate(db, fixedClock());
      expect(result.applied).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]);

      const session = db
        .prepare("SELECT kind, assistant_agent_id FROM chat_sessions WHERE id = 'old-session'")
        .get() as { kind: string; assistant_agent_id: string };
      expect(session).toEqual({ kind: 'assistant', assistant_agent_id: 'assistant' });

      const participant = db
        .prepare(
          "SELECT agent_id, role FROM chat_participants WHERE session_id = 'old-session'",
        )
        .get() as { agent_id: string; role: string };
      expect(participant).toEqual({ agent_id: 'assistant', role: 'assistant' });

      const messages = db
        .prepare(
          "SELECT id, sender_type, mentions_json FROM chat_messages WHERE session_id = 'old-session' ORDER BY created_at",
        )
        .all() as Array<{ id: string; sender_type: string; mentions_json: string }>;
      expect(messages).toEqual([
        { id: 'old-user', sender_type: 'user', mentions_json: '[]' },
        { id: 'old-assistant', sender_type: 'assistant', mentions_json: '[]' },
      ]);
    } finally {
      db.close();
    }
  });

  it('某一版失败时整体回滚，已成功的版本保留', () => {
    const db = openDatabase(':memory:');
    try {
      const migrations: Migration[] = [
        { version: 1, name: 'ok', up: 'CREATE TABLE a (id INTEGER);' },
        { version: 2, name: 'bad', up: 'CREATE TABLE b (id INTEGER); NOT SQL AT ALL;' },
      ];
      expect(() => migrate(db, fixedClock(), migrations)).toThrow();

      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>;
      expect(versions.map((r) => Number(r.version))).toEqual([1]);

      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(names).toContain('a');
      expect(names).not.toContain('b');
    } finally {
      db.close();
    }
  });
});

describe('transaction', () => {
  it('提交后可见，回滚后不可见', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');

      transaction(db, () => {
        db.prepare('INSERT INTO t VALUES (?)').run(1);
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });

      expect(() =>
        transaction(db, () => {
          db.prepare('INSERT INTO t VALUES (?)').run(2);
          throw new AppError('E_TEST', '故意失败');
        }),
      ).toThrowError(/故意失败/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('支持显式非 IMMEDIATE 事务', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE t (v INTEGER)');
      transaction(
        db,
        () => {
          db.prepare('INSERT INTO t VALUES (?)').run(1);
        },
        { immediate: false },
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe('db', () => {
  it('打开连接后启用外键与 WAL', () => {
    const db = openDatabase(':memory:');
    try {
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(Number(fk.foreign_keys)).toBe(1);
      const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
      expect(Number(timeout.timeout)).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('外键约束生效', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, fixedClock());
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_runs (id, task_id, spec_id, status, params, created_at)
             VALUES ('run_x', 'missing_task', 'spec', 'running', '{}', 'now')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});





















