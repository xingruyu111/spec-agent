import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toAssignment, toReport, toWorkItemComment } from './rows.js';
import type { WorkItemCommentRow, WorkActorType, WorkAssignmentRow, WorkReportRow, WorkItemState } from './types.js';

export class WorkItemAuxRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  listWorkItemComments(workItemId: string): WorkItemCommentRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_item_comments
         WHERE work_item_id = ? ORDER BY created_at ASC`,
      )
      .all(workItemId) as Array<Record<string, unknown>>;
    return rows.map(toWorkItemComment);
  }

  addWorkItemComment(input: {
    workItemId: string;
    authorType: WorkActorType;
    authorId: string;
    content: string;
  }): WorkItemCommentRow {
    const row: WorkItemCommentRow = {
      id: `wic-${randomUUID()}`,
      workItemId: input.workItemId,
      authorType: input.authorType,
      authorId: input.authorId,
      content: input.content,
      createdAt: this.clock.iso(),
      updatedAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO work_item_comments
           (id, work_item_id, author_type, author_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workItemId,
        row.authorType,
        row.authorId,
        row.content,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  updateWorkItemComment(
    commentId: string,
    content: string,
  ): WorkItemCommentRow | undefined {
    this.db
      .prepare(
        'UPDATE work_item_comments SET content = ?, updated_at = ? WHERE id = ?',
      )
      .run(content, this.clock.iso(), commentId);
    const row = this.db
      .prepare('SELECT * FROM work_item_comments WHERE id = ?')
      .get(commentId) as Record<string, unknown> | undefined;
    return row ? toWorkItemComment(row) : undefined;
  }

  deleteWorkItemComment(commentId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM work_item_comments WHERE id = ?')
      .run(commentId);
    return Number(result.changes) > 0;
  }

  listQueuedAssignments(projectId: string) {    const rows = this.db
      .prepare(
        `SELECT a.*, i.title AS item_title, i.state AS item_state
         FROM work_assignments a
         JOIN work_items i ON i.id = a.work_item_id
         WHERE i.project_id = ? AND a.state = 'queued'
         ORDER BY i.priority DESC, a.created_at ASC LIMIT 200`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.withDeps(toAssignment(row)),
      itemTitle: String(row.item_title),
      itemState: String(row.item_state) as WorkItemState,
    }));
  }

  listDeadLetters(projectId: string) {    const rows = this.db
      .prepare(
        `SELECT a.*, i.title AS item_title, i.state AS item_state
         FROM work_assignments a
         JOIN work_items i ON i.id = a.work_item_id
         WHERE i.project_id = ?
           AND a.state IN ('blocked', 'failed')
           AND a.attempts >= a.max_attempts
         ORDER BY a.updated_at DESC LIMIT 100`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.withDeps(toAssignment(row)),
      itemTitle: String(row.item_title),
      itemState: String(row.item_state) as WorkItemState,
    }));
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

  addReport(input: {
    assignmentId: string;
    kind: WorkReportRow['kind'];
    summary: string;
    artifacts?: unknown[];
  }): WorkReportRow {
    const row: WorkReportRow = {
      id: `report-${randomUUID()}`,
      assignmentId: input.assignmentId,
      kind: input.kind,
      summary: input.summary,
      artifacts: input.artifacts ?? [],
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO work_reports
           (id, assignment_id, kind, summary, artifacts, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.assignmentId,
        row.kind,
        row.summary,
        JSON.stringify(row.artifacts),
        row.createdAt,
      );
    return row;
  }

  listReports(assignmentId: string): WorkReportRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM work_reports WHERE assignment_id = ? ORDER BY created_at',
      )
      .all(assignmentId) as Array<Record<string, unknown>>;
    return rows.map(toReport);
  }

}
