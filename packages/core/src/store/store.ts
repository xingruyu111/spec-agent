/**
 * Store 门面：打开数据库、跑迁移、暴露事件与查询。
 *
 * 一个进程一个 Store；事务边界都在这里，外部拿不到裸连接去乱写。
 */

import type {
  GateAsk,
  GateDecision,
  GateKind,
  GatePayload,
  GateStatus,
  NodeRunStatus,
  RunStatus,
  TaskResult,
  TaskStatus,
  WorkflowSpec,
} from '@spec-agent/schema';
import { randomUUID } from 'node:crypto';
import type { Clock } from '@spec-agent/kernel';
import { createSystemClock } from '@spec-agent/kernel';
import type { Database } from './db.js';
import { openDatabase } from './db.js';
import { EventStore } from './event-store.js';
import { migrate, type Migration, type MigrateResult } from './migrations.js';
import { Projector } from './projector.js';

export type StoreOptions = {
  path: string;
  clock?: Clock;
  /** 仅测试用：覆盖迁移列表 */
  migrations?: Migration[];
};

export type TaskRow = {
  id: string;
  parentId: string | null;
  assignee: string;
  caller: string | null;
  title: string;
  status: TaskStatus;
  result: TaskResult | null;
  costUsd: number;
  planCostUsd: number;
  branch: string | null;
  repoPath: string | null;
  originNodeRunId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ProjectPlanStatus =
  | 'draft'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ProjectPlanItemStatus =
  | 'pending'
  | 'ready'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed';

export type ProjectIntegrationStatus =
  | 'pending'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'skipped';

export type ProjectPlanRow = {
  id: string;
  projectId: string | null;
  title: string;
  goal: string;
  status: ProjectPlanStatus;
  integrationStatus: ProjectIntegrationStatus;
  integrationError: string | null;
  verifyCommand: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type ProjectPlanItemRow = {
  id: string;
  planId: string;
  title: string;
  goal: string;
  assignee: string;
  milestone: string;
  repoPath: string | null;
  dependsOn: string[];
  taskId: string | null;
  status: ProjectPlanItemStatus;
  error: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type RunRow = {
  id: string;
  taskId: string;
  specId: string;
  status: RunStatus;
  params: Record<string, unknown>;
  costUsd: number;
  parentRunId: string | null;
  parentNodeRunId: string | null;
  /** 下一次 session 节点执行时强制增量刷新记忆 */
  memoryRefreshRequested: boolean;
  createdAt: string;
  finishedAt: string | null;
};

export type NodeRunRow = {
  id: string;
  runId: string;
  nodeId: string;
  status: NodeRunStatus;
  attempt: number;
  outputs: unknown[] | null;
  transcriptRef: string | null;
  sessionKey: string | null;
  sessionCumulativeUsd: number;
  /** 当前 session 已注入过的记忆内容，用于刷新时去重 */
  sessionMemoryKeys: string[];
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  error: unknown;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
};

export type GateRow = {
  id: string;
  taskId: string | null;
  nodeRunId: string | null;
  kind: GateKind;
  ask: GateAsk;
  status: GateStatus;
  decision: GateDecision | null;
  attempt: number;
  payload: GatePayload | null;
  result: unknown;
  decidedBy: string | null;
  requestedAt: string;
  decidedAt: string | null;
};

export type NotificationRow = {
  id: string;
  gateId: string;
  channel: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
};

export type MergeQueueRow = {
  id: string;
  taskId: string;
  nodeRunId: string;
  childTaskId: string;
  status: 'pending' | 'merged' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryScope = 'project' | 'agent' | 'task';

export type MemoryRow = {
  id: string;
  scope: MemoryScope;
  agentId: string | null;
  content: string;
  source: string | null;
  tags: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type MemoryOutboxRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  nodeRunId: string | null;
  kind: string;
  payload: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  remoteId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateMemoryInput = {
  scope: MemoryScope;
  agentId?: string | null;
  content: string;
  source?: string | null;
  tags?: string[];
  confidence?: number;
};

export class Store {
  readonly db: Database;
  readonly events: EventStore;
  readonly clock: Clock;
  readonly migration: MigrateResult;

  constructor(options: StoreOptions) {
    this.clock = options.clock ?? createSystemClock();
    this.db = openDatabase(options.path);
    try {
      this.migration = migrate(this.db, this.clock, options.migrations);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.events = new EventStore(this.db, new Projector());
  }

  /* ---------------- memory ---------------- */

  listMemories(
    filter: { scope?: MemoryScope; agentId?: string | null; limit?: number } = {},
  ): MemoryRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.scope) {
      where.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.agentId !== undefined) {
      if (filter.agentId === null || filter.agentId === '') {
        where.push('agent_id IS NULL');
      } else {
        where.push('agent_id = ?');
        params.push(filter.agentId);
      }
    }
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(toMemory);
  }

  createMemory(input: CreateMemoryInput): MemoryRow {
    const content = input.content.trim();
    if (!content) throw new Error('memory content 不能为空');
    const now = this.clock.iso();
    const row: MemoryRow = {
      id: randomUUID(),
      scope: input.scope,
      agentId: input.scope === 'agent' ? input.agentId ?? null : null,
      content: content.slice(0, 4000),
      source: input.source?.trim() || null,
      tags: Array.from(new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))).slice(0, 20),
      confidence: Math.min(Math.max(input.confidence ?? 1, 0), 1),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO memories
          (id, scope, agent_id, content, source, tags, confidence, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.scope,
        row.agentId,
        row.content,
        row.source,
        JSON.stringify(row.tags),
        row.confidence,
        row.createdAt,
        row.updatedAt,
        null,
      );
    return row;
  }

  deleteMemory(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  markMemoriesUsed(ids: string[]): void {
    const now = this.clock.iso();
    const stmt = this.db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(now, id);
  }

  enqueueMemoryOutbox(input: {
    projectId: string;
    taskId?: string | null;
    nodeRunId?: string | null;
    kind: string;
    payload: string;
  }): string {
    const id = randomUUID();
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO memory_outbox (
           id, project_id, task_id, node_run_id, kind, payload, status,
           attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.taskId ?? null,
        input.nodeRunId ?? null,
        input.kind,
        input.payload,
        now,
        now,
      );
    return id;
  }

  listPendingMemoryOutbox(limit = 20): MemoryOutboxRow[] {
    const now = this.clock.iso();
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_outbox
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(now, Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
    return rows.map(toMemoryOutbox);
  }

  getMemoryOutbox(id: string): MemoryOutboxRow | undefined {
    const row = this.db.prepare('SELECT * FROM memory_outbox WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toMemoryOutbox(row) : undefined;
  }

  markMemoryOutboxSent(id: string, remoteId?: string | null): void {
    const now = this.clock.iso();
    this.db
      .prepare(
        `UPDATE memory_outbox
         SET status = 'sent', remote_id = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(remoteId ?? null, now, id);
  }

  markMemoryOutboxFailed(
    id: string,
    error: string,
    nextAttemptAt: string | null,
  ): void {
    const now = this.clock.iso();
    this.db
      .prepare(
        `UPDATE memory_outbox
         SET status = CASE WHEN attempts + 1 >= 10 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1,
             error = ?,
             next_attempt_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(error.slice(0, 1000), nextAttemptAt, now, id);
  }

  memoryOutboxStats(): { pending: number; sent: number; failed: number } {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM memory_outbox GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const counts = { pending: 0, sent: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = Number(row.n);
    }
    return counts;
  }

  searchMemories(
    query: string,
    filter: { agentId?: string | null; limit?: number } = {},
  ): MemoryRow[] {
    const terms = Array.from(
      new Set(
        query
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .map((term) => term.trim())
          .flatMap((term) => {
            if (term.length <= 2 || !/[\u3400-\u9fff]/u.test(term)) return [term];
            // 中文没有空格：补 2-gram，让“组件目录”可以命中“组件放在…”。
            const grams: string[] = [term];
            for (let i = 0; i < term.length - 1; i += 1) {
              grams.push(term.slice(i, i + 2));
            }
            return grams;
          })
          .filter((term) => term.length >= 2),
      ),
    ).slice(0, 24);
    const pool = this.listMemories({ limit: 300 }).filter(
      (memory) =>
        memory.scope === 'project' ||
        (memory.scope === 'agent' && memory.agentId === (filter.agentId ?? null)),
    );
    const scored = pool.map((memory) => {
      const haystack = `${memory.content} ${memory.tags.join(' ')}`.toLowerCase();
      const matched = terms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return {
        memory,
        matched,
        score: matched + memory.confidence * 0.1,
      };
    });
    return scored
      .filter((entry) => terms.length === 0 || entry.matched > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      .slice(0, Math.min(Math.max(filter.limit ?? 8, 1), 50))
      .map((entry) => entry.memory);
  }

  memoryDigest(agentId: string | null, task: string, limit = 6): string[] {
    const memories = this.searchMemories(task, { agentId, limit });
    if (memories.length > 0) this.markMemoriesUsed(memories.map((memory) => memory.id));
    return memories.map((memory) => memory.content);
  }

  close(): void {
    this.db.close();
  }

  /* ---------------- 查询 ---------------- */

  getTask(id: string): TaskRow | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toTask(row) : undefined;
  }

  listTasks(limit = 50): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map(toTask);
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(taskId: string): RunRow[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow_runs WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(toRun);
  }

  listNodeRuns(runId: string): NodeRunRow[] {
    const rows = this.db
      .prepare('SELECT * FROM node_runs WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(toNodeRun);
  }

  getNodeRun(id: string): NodeRunRow | undefined {
    const row = this.db.prepare('SELECT * FROM node_runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toNodeRun(row) : undefined;
  }

  /** 记录节点级 Git checkpoint ref；正文/恢复仍由 Git 负责。 */
  setNodeCheckpoint(id: string, phase: 'before' | 'after', ref: string): void {
    const column = phase === 'before' ? 'checkpoint_before' : 'checkpoint_after';
    this.db.prepare(`UPDATE node_runs SET ${column} = ? WHERE id = ?`).run(ref, id);
  }

  clearNodeSession(id: string): void {
    this.db
      .prepare(
        `UPDATE node_runs
         SET transcript_ref = NULL, session_key = NULL, session_cumulative_usd = 0,
             session_memory_keys = NULL
         WHERE id = ?`,
      )
      .run(id);
  }

  setNodeMemoryKeys(id: string, keys: string[]): void {
    this.db
      .prepare('UPDATE node_runs SET session_memory_keys = ? WHERE id = ?')
      .run(JSON.stringify(keys), id);
  }

  requestMemoryRefresh(runId: string): void {
    this.db
      .prepare('UPDATE workflow_runs SET memory_refresh_requested = 1 WHERE id = ?')
      .run(runId);
  }

  consumeMemoryRefresh(runId: string): boolean {
    const row = this.db
      .prepare('SELECT memory_refresh_requested FROM workflow_runs WHERE id = ?')
      .get(runId) as { memory_refresh_requested?: number } | undefined;
    if (!row || Number(row.memory_refresh_requested) !== 1) return false;
    this.db
      .prepare('UPDATE workflow_runs SET memory_refresh_requested = 0 WHERE id = ?')
      .run(runId);
    return true;
  }

  listChildTasks(taskId: string): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(toTask);
  }

  getGate(id: string): GateRow | undefined {
    const row = this.db.prepare('SELECT * FROM gates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toGate(row) : undefined;
  }

  listPendingGates(): GateRow[] {
    const rows = this.db
      .prepare("SELECT * FROM gates WHERE status = 'pending' ORDER BY requested_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(toGate);
  }

  inboxCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM gates WHERE status = 'pending'")
      .get() as { n: number };
    return Number(row.n);
  }

  listGatesByNodeRun(nodeRunId: string): GateRow[] {
    const rows = this.db
      .prepare('SELECT * FROM gates WHERE node_run_id = ? ORDER BY requested_at ASC')
      .all(nodeRunId) as Array<Record<string, unknown>>;
    return rows.map(toGate);
  }

  saveSpec(id: string, spec: WorkflowSpec): void {
    this.db
      .prepare(
        `INSERT INTO workflow_specs (id, name, version, spec, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, spec.name, spec.version, JSON.stringify(spec), this.clock.iso());
  }

  getSpec(id: string): WorkflowSpec | undefined {
    const row = this.db.prepare('SELECT spec FROM workflow_specs WHERE id = ?').get(id) as
      | { spec: string }
      | undefined;
    return row ? (JSON.parse(row.spec) as WorkflowSpec) : undefined;
  }

  /** 按 'name@vN' 找最近保存的版本。 */
  getSpecByRef(ref: string): WorkflowSpec | undefined {
    const match = /^(.+)@v(\d+)$/.exec(ref);
    if (!match) return undefined;
    const row = this.db
      .prepare(
        'SELECT spec FROM workflow_specs WHERE name = ? AND version = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(match[1]!, Number(match[2])) as { spec: string } | undefined;
    return row ? (JSON.parse(row.spec) as WorkflowSpec) : undefined;
  }

  /** 任务与 spec 的绑定：每个任务可以有自己的规划结果 */
  bindSpec(taskId: string, specId: string): void {
    this.db
      .prepare(
        `INSERT INTO task_specs (task_id, spec_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET spec_id = excluded.spec_id`,
      )
      .run(taskId, specId, this.clock.iso());
  }

  getSpecIdForTask(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT spec_id FROM task_specs WHERE task_id = ?')
      .get(taskId) as { spec_id: string } | undefined;
    return row?.spec_id;
  }

  /* ---------------- 审批通知 outbox ---------------- */

  ensureNotification(gateId: string, channel: string): NotificationRow {
    const id = `${gateId}:${channel}`;
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_outbox
           (id, gate_id, channel, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(id, gateId, channel, now, now);
    return this.getNotification(id)!;
  }

  getNotification(id: string): NotificationRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM notification_outbox WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toNotification(row) : undefined;
  }

  listOverallNotifications(gateId?: string): NotificationRow[] {
    const rows = gateId
      ? (this.db
          .prepare('SELECT * FROM notification_outbox WHERE gate_id = ? ORDER BY created_at ASC')
          .all(gateId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM notification_outbox ORDER BY created_at ASC')
          .all() as Array<Record<string, unknown>>);
    return rows.map(toNotification);
  }

  listDueNotifications(now = this.clock.iso(), limit = 20): NotificationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notification_outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
      )
      .all(now, limit) as Array<Record<string, unknown>>;
    return rows.map(toNotification);
  }

  markNotificationSent(id: string): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
         SET status = 'sent', sent_at = ?, last_error = NULL
         WHERE id = ?`,
      )
      .run(this.clock.iso(), id);
  }

  markNotificationFailed(
    id: string,
    nextAttemptAt: string | null,
    error: string,
  ): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
         SET status = ?, attempts = attempts + 1,
             next_attempt_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(
        nextAttemptAt ? 'pending' : 'failed',
        nextAttemptAt ?? this.clock.iso(),
        error.slice(0, 1000),
        id,
      );
  }

  markNotificationSkipped(id: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE notification_outbox
         SET status = 'skipped', last_error = ?
         WHERE id = ?`,
      )
      .run(reason.slice(0, 1000), id);
  }

  /* ---------------- merge queue ---------------- */

  ensureMerge(
    taskId: string,
    nodeRunId: string,
    childTaskId: string,
  ): MergeQueueRow {
    const id = `${taskId}:${nodeRunId}`;
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO merge_queue
           (id, task_id, node_run_id, child_task_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(id, taskId, nodeRunId, childTaskId, now, now);
    return this.getMerge(nodeRunId)!;
  }

  getMerge(nodeRunId: string): MergeQueueRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM merge_queue WHERE node_run_id = ?')
      .get(nodeRunId) as Record<string, unknown> | undefined;
    return row ? toMergeQueue(row) : undefined;
  }

  listMerges(taskId?: string): MergeQueueRow[] {
    const rows = taskId
      ? (this.db
          .prepare('SELECT * FROM merge_queue WHERE task_id = ? ORDER BY created_at ASC')
          .all(taskId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM merge_queue ORDER BY created_at ASC')
          .all() as Array<Record<string, unknown>>);
    return rows.map(toMergeQueue);
  }

  markMergePending(nodeRunId: string): void {
    this.db
      .prepare(
        `UPDATE merge_queue SET status = 'pending', updated_at = ? WHERE node_run_id = ?`,
      )
      .run(this.clock.iso(), nodeRunId);
  }

  markMergeAttempt(nodeRunId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE merge_queue
         SET attempts = attempts + 1, status = 'pending', last_error = ?, updated_at = ?
         WHERE node_run_id = ?`,
      )
      .run(error.slice(0, 1000), this.clock.iso(), nodeRunId);
  }

  markMergeMerged(nodeRunId: string): void {
    this.db
      .prepare(
        `UPDATE merge_queue
         SET status = 'merged', last_error = NULL, updated_at = ?
         WHERE node_run_id = ?`,
      )
      .run(this.clock.iso(), nodeRunId);
  }

  markMergeFailed(nodeRunId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE merge_queue
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE node_run_id = ?`,
      )
      .run(error.slice(0, 1000), this.clock.iso(), nodeRunId);
  }

  /* ---------------- 项目计划 ---------------- */

  createProjectPlan(input: {
    id: string;
    projectId?: string | null;
    title: string;
    goal: string;
    verifyCommand?: string | null;
  }): ProjectPlanRow {
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO project_plans
           (id, project_id, title, goal, status, integration_status, verify_command, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', 'pending', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId?.trim() || null,
        input.title,
        input.goal,
        input.verifyCommand ?? null,
        now,
        now,
      );
    return this.getProjectPlan(input.id)!;
  }

  getProjectPlan(id: string): ProjectPlanRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_plans WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toProjectPlan(row) : undefined;
  }

  listProjectPlans(limit = 30, projectId?: string | null): ProjectPlanRow[] {
    const bounded = Math.min(Math.max(limit, 1), 100);
    const rows = projectId
      ? (this.db
          .prepare(
            'SELECT * FROM project_plans WHERE project_id = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(projectId, bounded) as Array<Record<string, unknown>>)
      : (this.db
          .prepare('SELECT * FROM project_plans ORDER BY created_at DESC LIMIT ?')
          .all(bounded) as Array<Record<string, unknown>>);
    return rows.map(toProjectPlan);
  }

  setProjectPlanStatus(id: string, status: ProjectPlanStatus): void {
    const finished = ['completed', 'failed', 'cancelled'].includes(status)
      ? this.clock.iso()
      : null;
    this.db
      .prepare(
        `UPDATE project_plans
         SET status = ?, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(status, this.clock.iso(), finished, id);
  }

  setProjectIntegration(
    id: string,
    status: ProjectIntegrationStatus,
    error?: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE project_plans
         SET integration_status = ?, integration_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error ?? null, this.clock.iso(), id);
  }

  setProjectVerifyCommand(id: string, command: string | null): void {
    this.db
      .prepare(
        'UPDATE project_plans SET verify_command = ?, updated_at = ? WHERE id = ?',
      )
      .run(command, this.clock.iso(), id);
  }

  createProjectPlanItem(input: {
    id: string;
    planId: string;
    title: string;
    goal: string;
    assignee: string;
    milestone: string;
    repoPath?: string | null;
    dependsOn?: string[];
    position: number;
  }): ProjectPlanItemRow {
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO project_plan_items
           (id, plan_id, title, goal, assignee, milestone, repo_path, depends_on,
            status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.planId,
        input.title,
        input.goal,
        input.assignee,
        input.milestone,
        input.repoPath ?? null,
        JSON.stringify(input.dependsOn ?? []),
        input.position,
        now,
        now,
      );
    return this.getProjectPlanItem(input.id)!;
  }

  getProjectPlanItem(id: string): ProjectPlanItemRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_plan_items WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toProjectPlanItem(row) : undefined;
  }

  listProjectPlanItems(planId: string): ProjectPlanItemRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM project_plan_items WHERE plan_id = ? ORDER BY position ASC, created_at ASC',
      )
      .all(planId) as Array<Record<string, unknown>>;
    return rows.map(toProjectPlanItem);
  }

  updateProjectPlanItem(
    id: string,
    patch: {
      status?: ProjectPlanItemStatus;
      taskId?: string | null;
      error?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.taskId !== undefined) {
      sets.push('task_id = ?');
      params.push(patch.taskId);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(this.clock.iso(), id);
    this.db
      .prepare(`UPDATE project_plan_items SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
  }
}

/* ------------------------------------------------------------------ */
/* 行映射                                                              */
/* ------------------------------------------------------------------ */

function toProjectPlan(row: Record<string, unknown>): ProjectPlanRow {
  return {
    id: String(row.id),
    projectId:
      row.project_id === null || row.project_id === undefined
        ? null
        : String(row.project_id),
    title: String(row.title),
    goal: String(row.goal),
    status: String(row.status) as ProjectPlanStatus,
    integrationStatus: String(row.integration_status) as ProjectIntegrationStatus,
    integrationError:
      row.integration_error === null ? null : String(row.integration_error),
    verifyCommand:
      row.verify_command === null ? null : String(row.verify_command),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function toProjectPlanItem(row: Record<string, unknown>): ProjectPlanItemRow {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    title: String(row.title),
    goal: String(row.goal),
    assignee: String(row.assignee),
    milestone: String(row.milestone),
    repoPath: row.repo_path === null || row.repo_path === undefined ? null : String(row.repo_path),
    dependsOn: parseJson<string[]>(row.depends_on) ?? [],
    taskId: row.task_id === null ? null : String(row.task_id),
    status: String(row.status) as ProjectPlanItemStatus,
    error: row.error === null ? null : String(row.error),
    position: Number(row.position),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toTask(row: Record<string, unknown>): TaskRow {
  return {
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    assignee: String(row.assignee),
    caller: row.caller === null ? null : String(row.caller),
    title: String(row.title),
    status: String(row.status) as TaskStatus,
    result: parseJson<TaskResult>(row.result),
    costUsd: Number(row.cost_usd),
    planCostUsd: Number(row.plan_cost_usd ?? 0),
    branch: row.branch === null ? null : String(row.branch),
    repoPath: row.repo_path === null || row.repo_path === undefined ? null : String(row.repo_path),
    originNodeRunId:
      row.origin_node_run_id === null ? null : String(row.origin_node_run_id),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function toRun(row: Record<string, unknown>): RunRow {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    specId: String(row.spec_id),
    status: String(row.status) as RunStatus,
    params: parseJson<Record<string, unknown>>(row.params) ?? {},
    costUsd: Number(row.cost_usd),
    parentRunId: row.parent_run_id === null ? null : String(row.parent_run_id),
    parentNodeRunId:
      row.parent_node_run_id === null ? null : String(row.parent_node_run_id),
    memoryRefreshRequested: Number(row.memory_refresh_requested ?? 0) === 1,
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function toNodeRun(row: Record<string, unknown>): NodeRunRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    status: String(row.status) as NodeRunStatus,
    attempt: Number(row.attempt),
    outputs: parseJson<unknown[]>(row.outputs),
    transcriptRef: row.transcript_ref === null || row.transcript_ref === undefined ? null : String(row.transcript_ref),
    sessionKey: row.session_key === null || row.session_key === undefined ? null : String(row.session_key),
    sessionCumulativeUsd: Number(row.session_cumulative_usd ?? 0),
    sessionMemoryKeys: (() => {
      const parsed = parseJson<unknown>(row.session_memory_keys);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [];
    })(),
    checkpointBefore: row.checkpoint_before === null || row.checkpoint_before === undefined ? null : String(row.checkpoint_before),
    checkpointAfter: row.checkpoint_after === null || row.checkpoint_after === undefined ? null : String(row.checkpoint_after),
    error: parseJson<unknown>(row.error),
    costUsd: Number(row.cost_usd),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function toGate(row: Record<string, unknown>): GateRow {
  return {
    id: String(row.id),
    taskId: row.task_id === null ? null : String(row.task_id),
    nodeRunId: row.node_run_id === null ? null : String(row.node_run_id),
    kind: String(row.kind) as GateKind,
    ask: String(row.ask) as GateAsk,
    status: String(row.status) as GateStatus,
    decision: row.decision === null ? null : (String(row.decision) as GateDecision),
    attempt: Number(row.attempt),
    payload: parseJson<GatePayload>(row.payload),
    result: parseJson<unknown>(row.result),
    decidedBy: row.decided_by === null ? null : String(row.decided_by),
    requestedAt: String(row.requested_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
  };
}

function toNotification(row: Record<string, unknown>): NotificationRow {
  return {
    id: String(row.id),
    gateId: String(row.gate_id),
    channel: String(row.channel),
    status: String(row.status) as NotificationRow['status'],
    attempts: Number(row.attempts),
    nextAttemptAt: String(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    sentAt: row.sent_at === null ? null : String(row.sent_at),
  };
}

function toMergeQueue(row: Record<string, unknown>): MergeQueueRow {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    nodeRunId: String(row.node_run_id),
    childTaskId: String(row.child_task_id),
    status: String(row.status) as MergeQueueRow['status'],
    attempts: Number(row.attempts),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMemoryOutbox(row: Record<string, unknown>): MemoryOutboxRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    nodeRunId:
      row.node_run_id === null || row.node_run_id === undefined
        ? null
        : String(row.node_run_id),
    kind: String(row.kind),
    payload: String(row.payload),
    status: String(row.status) as MemoryOutboxRow['status'],
    attempts: Number(row.attempts),
    nextAttemptAt:
      row.next_attempt_at === null || row.next_attempt_at === undefined
        ? null
        : String(row.next_attempt_at),
    remoteId:
      row.remote_id === null || row.remote_id === undefined ? null : String(row.remote_id),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toMemory(row: Record<string, unknown>): MemoryRow {  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    agentId: row.agent_id === null ? null : String(row.agent_id),
    content: String(row.content),
    source: row.source === null ? null : String(row.source),
    tags: parseJson<string[]>(row.tags) ?? [],
    confidence: Number(row.confidence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
  };
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
