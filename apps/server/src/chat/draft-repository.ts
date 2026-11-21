import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { WorkflowSpec } from '@spec-agent/schema';
import type { ProjectPlanDraftItem } from '@spec-agent/runtime';
import type { Clock } from '@spec-agent/kernel';
import { toChangeSet, toProjectPlanDraft, toWorkflowDraft } from './store-rows.js';
import type {
  ChangeSetRow,
  ChangeSetStatus,
  CreateChangeSetInput,
  ProjectPlanDraftRow,
  ProjectPlanDraftStatus,
  WorkflowDraftRow,
  WorkflowDraftStatus,
} from './store-types.js';

export class ChatDraftRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  createChangeSet(input: CreateChangeSetInput): ChangeSetRow {
    const now = this.clock.iso();
    const changeSet: ChangeSetRow = {
      id: randomUUID(),
      sessionId: input.sessionId,
      summary: input.summary.trim().slice(0, 500) || '配置变更',
      operations: input.operations,
      status: 'pending',
      error: null,
      createdAt: now,
      appliedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO change_sets
          (id, session_id, summary, operations, status, error, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        changeSet.id,
        changeSet.sessionId,
        changeSet.summary,
        JSON.stringify(changeSet.operations),
        changeSet.status,
        changeSet.error,
        changeSet.createdAt,
        changeSet.appliedAt,
      );
    return changeSet;
  }

  getChangeSet(id: string): ChangeSetRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM change_sets WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toChangeSet(row) : undefined;
  }

  updateChangeSet(
    id: string,
    patch: { status?: ChangeSetStatus; error?: string | null },
  ): ChangeSetRow {
    const current = this.getChangeSet(id);
    if (!current) throw new Error(`change set 不存在：${id}`);
    const next: ChangeSetRow = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.status === 'applied' ? { appliedAt: this.clock.iso() } : {}),
    };
    this.db
      .prepare(
        `UPDATE change_sets SET status = ?, error = ?, applied_at = ? WHERE id = ?`,
      )
      .run(next.status, next.error, next.appliedAt, id);
    return next;
  }

  createProjectPlanDraft(input: {
    sessionId: string;
    title: string;
    goal: string;
    verifyCommand?: string | null;
    workstreams: ProjectPlanDraftItem[];
  }): ProjectPlanDraftRow {
    const draft: ProjectPlanDraftRow = {
      id: randomUUID(),
      sessionId: input.sessionId,
      title: input.title.trim().slice(0, 200) || '项目计划草案',
      goal: input.goal.trim(),
      verifyCommand: input.verifyCommand?.trim() || null,
      workstreams: input.workstreams,
      status: 'pending',
      error: null,
      planId: null,
      createdAt: this.clock.iso(),
      appliedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO project_plan_drafts
          (id, session_id, title, goal, verify_command, workstreams, status, error, plan_id, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(
        draft.id,
        draft.sessionId,
        draft.title,
        draft.goal,
        draft.verifyCommand,
        JSON.stringify(draft.workstreams),
        draft.createdAt,
      );
    return draft;
  }

  getProjectPlanDraft(id: string): ProjectPlanDraftRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM project_plan_drafts WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toProjectPlanDraft(row) : undefined;
  }

  updateProjectPlanDraft(
    id: string,
    patch: {
      status?: ProjectPlanDraftStatus;
      error?: string | null;
      planId?: string | null;
    },
  ): ProjectPlanDraftRow {
    const current = this.getProjectPlanDraft(id);
    if (!current) throw new Error(`project plan draft 不存在：${id}`);
    const next: ProjectPlanDraftRow = {
      ...current,
      ...patch,
      appliedAt: patch.status === 'applied' ? this.clock.iso() : current.appliedAt,
    };
    this.db
      .prepare(
        `UPDATE project_plan_drafts
         SET status = ?, error = ?, plan_id = ?, applied_at = ? WHERE id = ?`,
      )
      .run(next.status, next.error, next.planId, next.appliedAt, id);
    return next;
  }

  createWorkflowDraft(input: {
    sessionId: string;
    goal: string;
    title: string;
    assignee: string;
    spec: WorkflowSpec;
    planUsage?: unknown;
    repoPath?: string | null;
  }): WorkflowDraftRow {
    const draft: WorkflowDraftRow = {
      id: randomUUID(),
      sessionId: input.sessionId,
      goal: input.goal.trim(),
      title: input.title.trim().slice(0, 200) || input.goal.trim().slice(0, 80),
      assignee: input.assignee,
      spec: input.spec,
      planUsage: input.planUsage ?? null,
      repoPath: input.repoPath?.trim() || null,
      status: 'pending',
      taskId: null,
      error: null,
      createdAt: this.clock.iso(),
      appliedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO chat_workflow_drafts
          (id, session_id, goal, title, assignee, spec_json, plan_usage_json,
           repo_path, status, task_id, error, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(
        draft.id,
        draft.sessionId,
        draft.goal,
        draft.title,
        draft.assignee,
        JSON.stringify(draft.spec),
        draft.planUsage === null ? null : JSON.stringify(draft.planUsage),
        draft.repoPath,
        draft.createdAt,
      );
    return draft;
  }

  getWorkflowDraft(id: string): WorkflowDraftRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM chat_workflow_drafts WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toWorkflowDraft(row) : undefined;
  }

  updateWorkflowDraft(
    id: string,
    patch: {
      status?: WorkflowDraftStatus;
      taskId?: string | null;
      error?: string | null;
    },
  ): WorkflowDraftRow {
    const current = this.getWorkflowDraft(id);
    if (!current) throw new Error(`workflow draft 不存在：${id}`);
    const next: WorkflowDraftRow = {
      ...current,
      ...patch,
      appliedAt: patch.status === 'applied' ? this.clock.iso() : current.appliedAt,
    };
    this.db
      .prepare(
        `UPDATE chat_workflow_drafts
         SET status = ?, task_id = ?, error = ?, applied_at = ? WHERE id = ?`,
      )
      .run(next.status, next.taskId, next.error, next.appliedAt, id);
    return next;
  }

  /** 自动记忆提取的持久 claim；服务重启后 sweeper 可以发现漏掉的任务。 */
}
