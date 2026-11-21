import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toAssignment } from './rows.js';
import type { WorkAssignmentRow, AssignmentState, WorkItemState } from './types.js';

export class AssignmentRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  createAssignment(input: {
    workItemId: string;
    agentId: string;
    groupId?: string | null;
    role?: WorkAssignmentRow['role'];
    requestedByEventId?: string | null;
    dependsOn?: string[];
    maxAttempts?: number;
  }): WorkAssignmentRow {
    const now = this.clock.iso();
    const dependsOn = Array.from(new Set(input.dependsOn ?? []));
    for (const dependencyId of dependsOn) {
      const dependency = this.getAssignment(dependencyId);
      if (!dependency || dependency.workItemId !== input.workItemId) {
        throw new Error(`依赖 Assignment 不属于当前 Work Item：${dependencyId}`);
      }
    }
    const row: WorkAssignmentRow = {
      id: `asg-${randomUUID()}`,
      workItemId: input.workItemId,
      agentId: input.agentId,
      groupId: input.groupId ?? null,
      role: input.role ?? 'owner',
      state: 'queued',
      requestedByEventId: input.requestedByEventId ?? null,
      runId: null,
      dependsOn,
      attempts: 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? 3),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO work_assignments
           (id, work_item_id, agent_id, group_id, role, state,
            requested_by_event_id, run_id, attempts, max_attempts,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workItemId,
        row.agentId,
        row.groupId,
        row.role,
        row.state,
        row.requestedByEventId,
        row.runId,
        row.attempts,
        row.maxAttempts,
        row.createdAt,
        row.updatedAt,
      );
    const insertDep = this.db.prepare(
      `INSERT INTO work_assignment_deps (assignment_id, depends_on_id)
       VALUES (?, ?)`,
    );
    for (const dependencyId of dependsOn) {
      insertDep.run(row.id, dependencyId);
    }
    return row;
  }

  updateAssignment(id: string, patch: {
    state?: AssignmentState;
    runId?: string | null;
  }): WorkAssignmentRow {
    const current = this.db
      .prepare('SELECT * FROM work_assignments WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!current) throw new Error(`assignment 不存在：${id}`);
    const row = toAssignment(current);
    const next: WorkAssignmentRow = {
      ...row,
      ...(patch.state ? { state: patch.state } : {}),
      ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
      updatedAt: this.clock.iso(),
    };
    this.db
      .prepare(
        'UPDATE work_assignments SET state = ?, run_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(next.state, next.runId, next.updatedAt, id);
    return this.withDeps(next);
  }

  listAssignments(workItemId: string): WorkAssignmentRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM work_assignments WHERE work_item_id = ? ORDER BY created_at',
      )
      .all(workItemId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.withDeps(toAssignment(row)));
  }

  getAssignment(id: string): WorkAssignmentRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM work_assignments WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.withDeps(toAssignment(row)) : undefined;
  }

  incrementAttempts(id: string): WorkAssignmentRow {
    this.db
      .prepare(
        'UPDATE work_assignments SET attempts = attempts + 1, updated_at = ? WHERE id = ?',
      )
      .run(this.clock.iso(), id);
    const assignment = this.getAssignment(id);
    if (!assignment) throw new Error(`assignment 不存在：${id}`);
    return assignment;
  }

  resetAssignment(id: string, maxAttempts?: number): WorkAssignmentRow {
    this.db
      .prepare(
        `UPDATE work_assignments
         SET state = 'queued', attempts = 0, max_attempts = COALESCE(?, max_attempts),
             run_id = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(maxAttempts ?? null, this.clock.iso(), id);
    const assignment = this.getAssignment(id);
    if (!assignment) throw new Error(`assignment 不存在：${id}`);
    return assignment;
  }

  private withDeps(row: WorkAssignmentRow): WorkAssignmentRow {
    const deps = this.db
      .prepare(
        `SELECT depends_on_id FROM work_assignment_deps
         WHERE assignment_id = ? ORDER BY depends_on_id`,
      )
      .all(row.id) as Array<{ depends_on_id: string }>;
    return {
      ...row,
      dependsOn: deps.map((dep) => String(dep.depends_on_id)),
    };
  }

  listAssignmentsByAgent(projectId: string, agentId: string) {
    const rows = this.db
      .prepare(
        `SELECT a.*, i.title AS item_title, i.state AS item_state
         FROM work_assignments a
         JOIN work_items i ON i.id = a.work_item_id
         WHERE i.project_id = ? AND a.agent_id = ?
         ORDER BY a.created_at DESC LIMIT 20`,
      )
      .all(projectId, agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.withDeps(toAssignment(row)),
      itemTitle: String(row.item_title),
      itemState: String(row.item_state) as WorkItemState,
    }));
  }
}
