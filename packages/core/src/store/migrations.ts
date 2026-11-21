/**
 * 迁移。
 *
 * 手写编号 SQL，不引 ORM。每个版本在一个事务里执行，失败整版回滚。
 * 迁移只增不改：已经发出去的版本号不再动。
 */

import type { Clock } from '@spec-agent/kernel';
import type { Database } from './db.js';

export type Migration = {
  version: number;
  name: string;
  up: string;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    up: `
      CREATE TABLE IF NOT EXISTS tasks (
        id           TEXT PRIMARY KEY,
        parent_id    TEXT,
        assignee     TEXT NOT NULL,
        caller       TEXT,
        title        TEXT NOT NULL,
        status       TEXT NOT NULL,
        result       TEXT,
        cost_usd     REAL NOT NULL DEFAULT 0,
        branch       TEXT,
        created_at   TEXT NOT NULL,
        finished_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL REFERENCES tasks(id),
        spec_id      TEXT NOT NULL,
        status       TEXT NOT NULL,
        params       TEXT NOT NULL,
        cost_usd     REAL NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        finished_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_task ON workflow_runs(task_id);

      CREATE TABLE IF NOT EXISTS node_runs (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL REFERENCES workflow_runs(id),
        node_id      TEXT NOT NULL,
        status       TEXT NOT NULL,
        attempt      INTEGER NOT NULL DEFAULT 1,
        inputs       TEXT,
        outputs      TEXT,
        error        TEXT,
        cost_usd     REAL NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        finished_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_node_runs_run ON node_runs(run_id, created_at);

      CREATE TABLE IF NOT EXISTS gates (
        id           TEXT PRIMARY KEY,
        task_id      TEXT,
        node_run_id  TEXT,
        kind         TEXT NOT NULL,
        ask          TEXT NOT NULL,
        status       TEXT NOT NULL,
        decision     TEXT,
        attempt      INTEGER NOT NULL DEFAULT 1,
        payload      TEXT,
        result       TEXT,
        decided_by   TEXT,
        requested_at TEXT NOT NULL,
        decided_at   TEXT,
        remind_at    TEXT,
        escalate_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gates_pending ON gates(status, requested_at);

      CREATE TABLE IF NOT EXISTS events (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        id             TEXT NOT NULL UNIQUE,
        ts             TEXT NOT NULL,
        type           TEXT NOT NULL,
        v              INTEGER NOT NULL,
        actor_type     TEXT NOT NULL,
        actor_id       TEXT,
        task_id        TEXT,
        run_id         TEXT,
        node_run_id    TEXT,
        correlation_id TEXT NOT NULL,
        causation_id   TEXT,
        payload        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, seq);
    `,
  },
  {
    version: 2,
    name: 'workflow_specs',
    up: `
      CREATE TABLE IF NOT EXISTS workflow_specs (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        version    INTEGER NOT NULL,
        spec       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'lineage',
    up: `
      ALTER TABLE tasks ADD COLUMN origin_node_run_id TEXT;
      ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT;
      ALTER TABLE workflow_runs ADD COLUMN parent_node_run_id TEXT;
    `,
  },
  {
    version: 4,
    name: 'task_specs',
    up: `
      CREATE TABLE IF NOT EXISTS task_specs (
        task_id    TEXT PRIMARY KEY,
        spec_id    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'notification_outbox',
    up: `
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id              TEXT PRIMARY KEY,
        gate_id         TEXT NOT NULL,
        channel         TEXT NOT NULL,
        status          TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error      TEXT,
        created_at      TEXT NOT NULL,
        sent_at         TEXT,
        UNIQUE(gate_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_due
        ON notification_outbox(status, next_attempt_at);
    `,
  },
  {
    version: 6,
    name: 'merge_queue',
    up: `
      CREATE TABLE IF NOT EXISTS merge_queue (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        node_run_id   TEXT NOT NULL,
        child_task_id TEXT NOT NULL,
        status        TEXT NOT NULL,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE(node_run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_merge_queue_task
        ON merge_queue(task_id, created_at);
    `,
  },
  {
    version: 7,
    name: 'planner_cost',
    up: `
      ALTER TABLE tasks ADD COLUMN plan_cost_usd REAL NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 8,
    name: 'chat_and_memory',    up: `
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        mode           TEXT NOT NULL DEFAULT 'qa',
        dsh_session_id TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
        ON chat_sessions(updated_at);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        role          TEXT NOT NULL,
        content       TEXT NOT NULL,
        mode          TEXT NOT NULL DEFAULT 'qa',
        status        TEXT NOT NULL DEFAULT 'complete',
        task_id       TEXT,
        change_set_id TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS change_sets (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        summary     TEXT NOT NULL,
        operations  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        created_at  TEXT NOT NULL,
        applied_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_change_sets_session
        ON change_sets(session_id, created_at);

      CREATE TABLE IF NOT EXISTS memories (
        id           TEXT PRIMARY KEY,
        scope        TEXT NOT NULL,
        agent_id     TEXT,
        content      TEXT NOT NULL,
        source       TEXT,
        tags         TEXT NOT NULL DEFAULT '[]',
        confidence   REAL NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(scope, agent_id, updated_at);
    `,
  },
  {
    version: 9,
    name: 'memory_extractions',
    up: `
      CREATE TABLE IF NOT EXISTS memory_extractions (
        task_id    TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status     TEXT NOT NULL,
        error      TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_extractions_status
        ON memory_extractions(status, updated_at);
    `,
  },
  {
    version: 10,
    name: 'chat_reasoning',
    up: `
      ALTER TABLE chat_messages ADD COLUMN reasoning TEXT;
    `,
  },
  {
    version: 11,
    name: 'project_plans',
    up: `
      CREATE TABLE IF NOT EXISTS project_plans (
        id                 TEXT PRIMARY KEY,
        title              TEXT NOT NULL,
        goal               TEXT NOT NULL,
        status             TEXT NOT NULL,
        integration_status TEXT NOT NULL DEFAULT 'pending',
        integration_error  TEXT,
        verify_command     TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        finished_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_plans_created
        ON project_plans(created_at);

      CREATE TABLE IF NOT EXISTS project_plan_items (
        id          TEXT PRIMARY KEY,
        plan_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        goal        TEXT NOT NULL,
        assignee    TEXT NOT NULL,
        milestone   TEXT NOT NULL,
        depends_on  TEXT NOT NULL DEFAULT '[]',
        task_id     TEXT,
        status      TEXT NOT NULL DEFAULT 'pending',
        error       TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_plan_items_plan
        ON project_plan_items(plan_id, position);
    `,
  },
  {
    version: 12,
    name: 'chat_project_plan_drafts',
    up: `
      ALTER TABLE chat_messages ADD COLUMN project_plan_draft_id TEXT;

      CREATE TABLE IF NOT EXISTS project_plan_drafts (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL,
        title          TEXT NOT NULL,
        goal           TEXT NOT NULL,
        verify_command TEXT,
        workstreams    TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        error          TEXT,
        plan_id        TEXT,
        created_at     TEXT NOT NULL,
        applied_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_project_plan_drafts_session
        ON project_plan_drafts(session_id, created_at);
    `,
  },
  {
    version: 13,
    name: 'task_repositories',
    up: `
      ALTER TABLE tasks ADD COLUMN repo_path TEXT;
      ALTER TABLE project_plan_items ADD COLUMN repo_path TEXT;
    `,
  },
  {
    version: 14,
    name: 'node_transcript_refs',
    up: `
      ALTER TABLE node_runs ADD COLUMN transcript_ref TEXT;
    `,
  },
  {
    version: 15,
    name: 'chat_session_model_routes',
    up: `
      ALTER TABLE chat_sessions ADD COLUMN provider_id TEXT;
      ALTER TABLE chat_sessions ADD COLUMN model TEXT;
    `,
  },
  {
    version: 16,
    name: 'node_session_links',
    up: `
      ALTER TABLE node_runs ADD COLUMN session_key TEXT;
      ALTER TABLE node_runs ADD COLUMN session_cumulative_usd REAL NOT NULL DEFAULT 0;
      ALTER TABLE node_runs ADD COLUMN checkpoint_before TEXT;
      ALTER TABLE node_runs ADD COLUMN checkpoint_after TEXT;
    `,
  },
  {
    version: 17,
    name: 'memory_outbox',
    up: `
      CREATE TABLE IF NOT EXISTS memory_outbox (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        node_run_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        remote_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_outbox_pending
        ON memory_outbox(status, next_attempt_at, created_at);
    `,
  },
  {
    version: 18,
    name: 'session_memory_refresh',
    up: `
      ALTER TABLE node_runs ADD COLUMN session_memory_keys TEXT;
      ALTER TABLE workflow_runs ADD COLUMN memory_refresh_requested INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 19,
    name: 'conversation_participants',
    up: `
      ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'assistant';
      ALTER TABLE chat_sessions ADD COLUMN assistant_agent_id TEXT NOT NULL DEFAULT 'assistant';
      ALTER TABLE chat_sessions ADD COLUMN primary_agent_id TEXT;

      CREATE TABLE IF NOT EXISTS chat_participants (
        session_id TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        role       TEXT NOT NULL,
        joined_at  TEXT NOT NULL,
        PRIMARY KEY (session_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_participants_agent
        ON chat_participants(agent_id, session_id);

      INSERT OR IGNORE INTO chat_participants (session_id, agent_id, role, joined_at)
        SELECT id, assistant_agent_id, 'assistant', created_at FROM chat_sessions;

      ALTER TABLE chat_messages ADD COLUMN sender_type TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE chat_messages ADD COLUMN sender_agent_id TEXT;
      ALTER TABLE chat_messages ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]';

      UPDATE chat_messages
        SET sender_type = CASE
          WHEN role = 'user' THEN 'user'
          WHEN role = 'system' THEN 'system'
          ELSE 'assistant'
        END;
    `,
  },
  {
    version: 20,
    name: 'chat_workflow_drafts',
    up: `
      CREATE TABLE IF NOT EXISTS chat_workflow_drafts (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        goal            TEXT NOT NULL,
        title           TEXT NOT NULL,
        assignee        TEXT NOT NULL,
        spec_json       TEXT NOT NULL,
        plan_usage_json TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        task_id         TEXT,
        error           TEXT,
        created_at      TEXT NOT NULL,
        applied_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_workflow_drafts_session
        ON chat_workflow_drafts(session_id, created_at);

      ALTER TABLE chat_messages ADD COLUMN workflow_draft_id TEXT;
    `,
  },
  {
    version: 21,
    name: 'conversation_agent_sessions',
    up: `
      ALTER TABLE chat_participants ADD COLUMN agent_session_id TEXT;
    `,
  },
  {
    version: 22,
    name: 'conversation_subprojects',
    up: `
      CREATE TABLE IF NOT EXISTS chat_subprojects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_subprojects_updated
        ON chat_subprojects(updated_at DESC);

      ALTER TABLE chat_sessions ADD COLUMN subproject_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_subproject
        ON chat_sessions(subproject_id, updated_at DESC);
    `,
  },
  {
    version: 23,
    name: 'organization_projects',
    up: `
      ALTER TABLE chat_subprojects RENAME TO chat_projects;
      ALTER TABLE chat_sessions RENAME COLUMN subproject_id TO project_id;
      ALTER TABLE chat_projects ADD COLUMN root TEXT;
      ALTER TABLE chat_projects ADD COLUMN repo_path TEXT;
      ALTER TABLE chat_projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE chat_workflow_drafts ADD COLUMN repo_path TEXT;
      CREATE INDEX IF NOT EXISTS idx_chat_projects_updated
        ON chat_projects(status, updated_at DESC);
    `,
  },
  {
    version: 24,
    name: 'project_plans_by_project',
    up: `
      ALTER TABLE project_plans ADD COLUMN project_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_project_plans_project
        ON project_plans(project_id, created_at DESC);
    `,
  },
  {
    version: 25,
    name: 'chat_permission_mode',
    up: `
      ALTER TABLE chat_sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only';
    `,
  },
  {
    version: 26,
    name: 'group_work_items',
    up: `      CREATE TABLE IF NOT EXISTS work_groups (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        name        TEXT NOT NULL,
        topic       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_groups_project
        ON work_groups(project_id, created_at);

      CREATE TABLE IF NOT EXISTS work_group_members (
        group_id    TEXT NOT NULL REFERENCES work_groups(id) ON DELETE CASCADE,
        member_type TEXT NOT NULL,
        member_id   TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member',
        created_at  TEXT NOT NULL,
        PRIMARY KEY (group_id, member_type, member_id)
      );

      CREATE TABLE IF NOT EXISTS domain_events (
        id             TEXT PRIMARY KEY,
        project_id     TEXT,
        group_id       TEXT,
        type           TEXT NOT NULL,
        actor_type     TEXT NOT NULL,
        actor_id       TEXT NOT NULL,
        payload        TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id   TEXT,
        dedupe_key     TEXT NOT NULL UNIQUE,
        depth          INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_domain_events_group
        ON domain_events(group_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_domain_events_correlation
        ON domain_events(correlation_id, created_at);

      CREATE TABLE IF NOT EXISTS work_items (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        group_id          TEXT,
        origin_event_id   TEXT,
        requested_by_type TEXT NOT NULL,
        requested_by_id   TEXT NOT NULL,
        title             TEXT NOT NULL,
        intent            TEXT,
        state             TEXT NOT NULL,
        priority          INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_items_project
        ON work_items(project_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_work_items_group
        ON work_items(group_id, state, created_at DESC);

      CREATE TABLE IF NOT EXISTS work_assignments (
        id                   TEXT PRIMARY KEY,
        work_item_id         TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        agent_id             TEXT NOT NULL,
        group_id             TEXT,
        role                 TEXT NOT NULL DEFAULT 'owner',
        state                TEXT NOT NULL,
        requested_by_event_id TEXT,
        run_id               TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_assignments_item
        ON work_assignments(work_item_id, created_at);

      CREATE TABLE IF NOT EXISTS work_reports (
        id            TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        summary       TEXT NOT NULL,
        artifacts     TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_reports_assignment
        ON work_reports(assignment_id, created_at);
    `,
  },
  {
    version: 27,
    name: 'private_threads',
    up: `
      CREATE TABLE IF NOT EXISTS private_threads (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, agent_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_private_threads_project
        ON private_threads(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS private_messages (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL REFERENCES private_threads(id) ON DELETE CASCADE,
        actor_type  TEXT NOT NULL,
        actor_id    TEXT NOT NULL,
        content     TEXT NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_private_messages_thread
        ON private_messages(thread_id, created_at);
    `,
  },
  {
    version: 28,
    name: 'work_memories',
    up: `
      CREATE TABLE IF NOT EXISTS work_memories (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        scope_type  TEXT NOT NULL,
        scope_id    TEXT NOT NULL,
        agent_id    TEXT,
        kind        TEXT NOT NULL DEFAULT 'fact',
        content     TEXT NOT NULL,
        source      TEXT,
        confidence  REAL NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_memories_scope
        ON work_memories(project_id, scope_type, scope_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_memories_source
        ON work_memories(project_id, scope_type, scope_id, source)
        WHERE source IS NOT NULL;
    `,
  },
  {
    version: 29,
    name: 'work_memory_retrieval',
    up: `
      ALTER TABLE work_memories ADD COLUMN expires_at TEXT;
      ALTER TABLE work_memories ADD COLUMN last_used_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_work_memories_expiry
        ON work_memories(project_id, expires_at);
    `,
  },
  {
    version: 30,
    name: 'assignment_dependencies',
    up: `
      CREATE TABLE IF NOT EXISTS work_assignment_deps (
        assignment_id  TEXT NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE,
        depends_on_id  TEXT NOT NULL REFERENCES work_assignments(id) ON DELETE CASCADE,
        PRIMARY KEY (assignment_id, depends_on_id)
      );
      CREATE INDEX IF NOT EXISTS idx_work_assignment_deps_dep
        ON work_assignment_deps(depends_on_id);
    `,
  },
  {
    version: 31,
    name: 'assignment_attempts',
    up: `
      ALTER TABLE work_assignments ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE work_assignments ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
    `,
  },
  {
    version: 32,
    name: 'work_outbox',
    up: `
      CREATE TABLE IF NOT EXISTS work_outbox (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        group_id     TEXT,
        work_item_id TEXT,
        source       TEXT NOT NULL,
        external_id  TEXT,
        kind         TEXT NOT NULL,
        payload      TEXT NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_outbox_status
        ON work_outbox(project_id, status, created_at);
    `,
  },
  {
    version: 33,
    name: 'outbox_retry',
    up: `
      ALTER TABLE work_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE work_outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE work_outbox ADD COLUMN last_error TEXT;
      ALTER TABLE work_outbox ADD COLUMN next_attempt_at TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_work_outbox_unique
        ON work_outbox(project_id, source, external_id, work_item_id, kind)
        WHERE external_id IS NOT NULL AND work_item_id IS NOT NULL;
    `,
  },
  {
    version: 34,
    name: 'work_source_rules',
    up: `
      CREATE TABLE IF NOT EXISTS work_source_rules (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        group_id   TEXT,
        source     TEXT NOT NULL,
        actions    TEXT NOT NULL DEFAULT '[]',
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, group_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_work_source_rules_project
        ON work_source_rules(project_id, source);
    `,
  },
  {
    version: 35,
    name: 'source_rule_labels_authors',
    up: `
      ALTER TABLE work_source_rules ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE work_source_rules ADD COLUMN authors TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 36,
    name: 'work_item_comments',
    up: `
      CREATE TABLE IF NOT EXISTS work_item_comments (
        id           TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        author_type  TEXT NOT NULL,
        author_id    TEXT NOT NULL,
        content      TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_item_comments_item
        ON work_item_comments(work_item_id, created_at);
    `,
  },
  {
    version: 37,
    name: 'comment_updated_at',
    up: `
      ALTER TABLE work_item_comments ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      UPDATE work_item_comments SET updated_at = created_at WHERE updated_at = '';
    `,
  },
  {
    version: 38,
    name: 'memory_vectors',
    up: `
      CREATE TABLE IF NOT EXISTS work_memory_vectors (
        model      TEXT NOT NULL,
        text_hash  TEXT NOT NULL,
        vector     TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (model, text_hash)
      );
    `,
  },
  {
    version: 39,
    name: 'memory_versions',
    up: `
      CREATE TABLE IF NOT EXISTS work_memory_versions (
        id         TEXT PRIMARY KEY,
        memory_id  TEXT NOT NULL,
        project_id TEXT NOT NULL,
        content    TEXT NOT NULL,
        source     TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_versions_memory
        ON work_memory_versions(memory_id, created_at);
    `,
  },
  {
    version: 40,
    name: 'embedding_metrics',
    up: `
      CREATE TABLE IF NOT EXISTS work_embedding_metrics (
        model      TEXT PRIMARY KEY,
        calls      INTEGER NOT NULL DEFAULT 0,
        failures   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 41,
    name: 'embedding_project_metrics',
    up: `
      CREATE TABLE IF NOT EXISTS work_embedding_project_metrics (
        project_id TEXT NOT NULL,
        model      TEXT NOT NULL,
        calls      INTEGER NOT NULL DEFAULT 0,
        failures   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, model)
      );
    `,
  },
  {
    version: 42,
    name: 'outbox_attempts',
    up: `
      CREATE TABLE IF NOT EXISTS work_outbox_attempts (
        id         TEXT PRIMARY KEY,
        outbox_id  TEXT NOT NULL,
        attempt    INTEGER NOT NULL,
        ok         INTEGER NOT NULL,
        error      TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_attempts_outbox
        ON work_outbox_attempts(outbox_id, created_at);
    `,
  },
];

export type MigrateResult = { applied: number[]; currentVersion: number };

export function migrate(
  db: Database,
  clock: Clock,
  migrations: Migration[] = MIGRATIONS,
): MigrateResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  const applied = new Set(rows.map((row) => Number(row.version)));

  const appliedNow: number[] = [];
  for (const migration of migrations) {
    const current = applied.has(migration.version);
    if (current) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        clock.iso(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    appliedNow.push(migration.version);
  }

  const latest = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  return { applied: appliedNow, currentVersion: Number(latest.version) };
}
