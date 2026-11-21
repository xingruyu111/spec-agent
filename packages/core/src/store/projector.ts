/**
 * 投影：把事件折叠成可查询的读模型。
 *
 * 原则：
 * - 只读事件，不改事件；
 * - 未知事件类型直接忽略，保证向前兼容；
 * - 事件缺关键 id 属于编程错误，抛 E_PROJECTION，让整个事务回滚。
 */

import type { AnyEvent, TaskResult } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';
import type { Database } from './db.js';

export class Projector {
  apply(db: Database, event: AnyEvent): void {
    switch (event.type) {
      case 'task.created':
        return this.taskCreated(db, event);
      case 'task.claimed':
      case 'task.started':
        return this.updateTaskStatus(db, event, 'running');
      case 'task.waiting_children':
        return this.updateTaskStatus(db, event, 'waiting_children');
      case 'task.waiting_gate':
        return this.updateTaskStatus(db, event, 'waiting_gate');
      case 'task.waiting_input':
        return this.updateTaskStatus(db, event, 'waiting_input');
      case 'task.resumed':
        return this.updateTaskStatus(db, event, 'running');
      case 'task.finished':
        return this.taskFinished(db, event);
      case 'task.failed':
        return this.taskFailed(db, event);
      case 'task.cancelled':
        return this.updateTaskStatus(db, event, 'cancelled', true);
      case 'task.reopened':
        return this.taskReopened(db, event);

      case 'workflow.run.started':
        return this.runStarted(db, event);
      case 'workflow.run.waiting':
        return this.updateRunStatus(db, event, 'waiting');
      case 'workflow.run.finished':
        return this.runFinished(db, event);
      case 'workflow.run.replanned':
        return this.runReplanned(db, event);
      case 'workflow.run.failed':
        return this.updateRunStatus(db, event, 'failed', true);
      case 'run.cancelled':
        return this.updateRunStatus(db, event, 'cancelled', true);
      case 'workflow.run.reopened':
        return this.runReopened(db, event);

      case 'node.ready':
        return this.nodeReady(db, event);
      case 'node.started':
        return this.nodeStarted(db, event);
      case 'node.verifying':
        return this.nodeVerifying(db, event);
      case 'node.waiting_gate':
        return this.updateNodeStatus(db, event, 'waiting_gate');
      case 'node.finished':
        return this.nodeFinished(db, event);
      case 'node.failed':
        return this.nodeFailed(db, event);
      case 'node.retried':
        return this.nodeRetried(db, event);
      case 'node.skipped':
        return this.updateNodeStatus(db, event, 'skipped', true);
      case 'node.cancelled':
        return this.updateNodeStatus(db, event, 'cancelled', true);
      case 'node.reset':
        return this.nodeReset(db, event);
      case 'node.interrupted':
        return this.nodeInterrupted(db, event);

      case 'gate.requested':
        return this.gateRequested(db, event);
      case 'gate.passed':
        return this.gateDecided(db, event, 'passed');
      case 'gate.failed':
        return this.gateDecided(db, event, 'failed');
      case 'gate.cancelled':
        return this.updateGateStatus(db, event, 'cancelled');
      case 'gate.overridden':
        return this.gateOverridden(db, event);
      case 'gate.reminded':
      case 'node.checkpoint':
        return;

      default:
        // trace / message / git 等事件暂不进投影
        return;
    }
  }

  /* ---------------- task ---------------- */

  private taskCreated(db: Database, event: Extract<AnyEvent, { type: 'task.created' }>): void {
    const taskId = requireTaskId(event);
    db.prepare(
      `INSERT INTO tasks (id, parent_id, assignee, caller, title, status, cost_usd, plan_cost_usd, created_at, branch, origin_node_run_id, repo_path)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      taskId,
      event.payload.parentTaskId ?? null,
      event.payload.assignee,
      event.payload.caller,
      event.payload.title,
      event.payload.plannerUsage?.usd ?? 0,
      event.payload.plannerUsage?.usd ?? 0,
      event.ts,
      event.payload.branch ?? null,
      event.payload.originNodeRunId ?? null,
      event.payload.repoPath ?? null,
    );
  }

  private updateTaskStatus(
    db: Database,
    event: AnyEvent,
    status: string,
    finish = false,
  ): void {
    const taskId = requireTaskId(event);
    db.prepare(
      `UPDATE tasks SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
    ).run(status, finish ? event.ts : null, taskId);
  }

  private taskFinished(db: Database, event: Extract<AnyEvent, { type: 'task.finished' }>): void {
    const taskId = requireTaskId(event);
    db.prepare(
      `UPDATE tasks SET status = 'succeeded', result = ?, cost_usd = ? + plan_cost_usd, finished_at = ? WHERE id = ?`,
    ).run(json(event.payload.result), event.payload.result.usage?.usd ?? 0, event.ts, taskId);
  }

  private taskFailed(db: Database, event: Extract<AnyEvent, { type: 'task.failed' }>): void {
    const taskId = requireTaskId(event);
    const partial: TaskResult | undefined = event.payload.partial;
    db.prepare(
      `UPDATE tasks SET status = 'failed', result = ?, finished_at = ? WHERE id = ?`,
    ).run(json(partial ?? null), event.ts, taskId);
  }

  private taskReopened(
    db: Database,
    event: Extract<AnyEvent, { type: 'task.reopened' }>,
  ): void {
    const taskId = requireTaskId(event);
    db.prepare(
      `UPDATE tasks SET status = 'running', result = NULL, finished_at = NULL WHERE id = ?`,
    ).run(taskId);
  }

  /* ---------------- run ---------------- */

  private runStarted(db: Database, event: Extract<AnyEvent, { type: 'workflow.run.started' }>): void {
    const taskId = requireTaskId(event);
    const runId = requireRunId(event);
    db.prepare(
      `INSERT INTO workflow_runs
        (id, task_id, spec_id, status, params, created_at, parent_run_id, parent_node_run_id)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      runId,
      taskId,
      event.payload.specId,
      json(event.payload.params),
      event.ts,
      event.payload.parentRunId ?? null,
      event.payload.parentNodeRunId ?? null,
    );
  }

  private runReplanned(
    db: Database,
    event: Extract<AnyEvent, { type: 'workflow.run.replanned' }>,
  ): void {
    const runId = requireRunId(event);
    db.prepare('UPDATE workflow_runs SET spec_id = ? WHERE id = ?').run(
      event.payload.specId,
      runId,
    );
  }

  private runReopened(
    db: Database,
    event: Extract<AnyEvent, { type: 'workflow.run.reopened' }>,
  ): void {
    const runId = requireRunId(event);
    db.prepare(
      `UPDATE workflow_runs SET status = 'running', finished_at = NULL WHERE id = ?`,
    ).run(runId);
  }

  private updateRunStatus(db: Database, event: AnyEvent, status: string, finish = false): void {
    const runId = requireRunId(event);
    db.prepare(
      `UPDATE workflow_runs SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
    ).run(status, finish ? event.ts : null, runId);
  }

  private runFinished(
    db: Database,
    event: Extract<AnyEvent, { type: 'workflow.run.finished' }>,
  ): void {
    const runId = requireRunId(event);
    db.prepare(
      `UPDATE workflow_runs SET status = ?, cost_usd = ?, finished_at = ? WHERE id = ?`,
    ).run(event.payload.status, event.payload.costUsd, event.ts, runId);
  }

  /* ---------------- node ---------------- */

  private nodeReady(db: Database, event: Extract<AnyEvent, { type: 'node.ready' }>): void {
    const nodeRunId = requireNodeRunId(event);
    const runId = requireRunId(event);
    db.prepare(
      `INSERT INTO node_runs (id, run_id, node_id, status, attempt, created_at)
       VALUES (?, ?, ?, 'ready', 1, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'ready'`,
    ).run(nodeRunId, runId, event.payload.nodeId, event.ts);
  }

  private nodeStarted(db: Database, event: Extract<AnyEvent, { type: 'node.started' }>): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(`UPDATE node_runs SET status = 'running', attempt = ? WHERE id = ?`).run(
      event.payload.attempt,
      nodeRunId,
    );
  }

  private nodeVerifying(
    db: Database,
    event: Extract<AnyEvent, { type: 'node.verifying' }>,
  ): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(
      `UPDATE node_runs
       SET status = 'verifying', attempt = ?, outputs = ?, transcript_ref = ?,
           session_key = ?, session_cumulative_usd = ?, cost_usd = cost_usd + ?
       WHERE id = ?`,
    ).run(
      event.payload.attempt,
      json(event.payload.outputs),
      event.payload.transcriptRef ?? null,
      event.payload.sessionKey ?? null,
      event.payload.sessionCumulativeUsd ?? 0,
      event.payload.usage?.usd ?? 0,
      nodeRunId,
    );
  }

  private updateNodeStatus(db: Database, event: AnyEvent, status: string, finish = false): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(
      `UPDATE node_runs SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`,
    ).run(status, finish ? event.ts : null, nodeRunId);
  }

  private nodeFinished(
    db: Database,
    event: Extract<AnyEvent, { type: 'node.finished' }>,
  ): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(
      `UPDATE node_runs
       SET status = 'succeeded', outputs = ?, cost_usd = cost_usd + ?, finished_at = ?
       WHERE id = ?`,
    ).run(json(event.payload.outputs), event.payload.usage?.usd ?? 0, event.ts, nodeRunId);
  }

  private nodeFailed(db: Database, event: Extract<AnyEvent, { type: 'node.failed' }>): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(
      `UPDATE node_runs SET status = 'failed', error = ?, attempt = ?, finished_at = ? WHERE id = ?`,
    ).run(json(event.payload.error), event.payload.attempt, event.ts, nodeRunId);
  }

  private nodeRetried(db: Database, event: Extract<AnyEvent, { type: 'node.retried' }>): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(
      `UPDATE node_runs SET status = 'ready', attempt = ?, finished_at = NULL WHERE id = ?`,
    ).run(event.payload.to, nodeRunId);
  }

  private nodeReset(db: Database, event: Extract<AnyEvent, { type: 'node.reset' }>): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(
      `UPDATE node_runs
       SET status = 'ready', attempt = ?, outputs = NULL, error = NULL, finished_at = NULL
       WHERE id = ?`,
    ).run(event.payload.attempt, nodeRunId);
  }

  private nodeInterrupted(
    db: Database,
    event: Extract<AnyEvent, { type: 'node.interrupted' }>,
  ): void {
    const nodeRunId = requireNodeRunId(event);
    db.prepare(`UPDATE node_runs SET status = 'ready', error = ? WHERE id = ?`).run(
      json({ code: 'E_INTERRUPTED', message: event.payload.reason }),
      nodeRunId,
    );
  }

  /* ---------------- gate ---------------- */

  private gateRequested(
    db: Database,
    event: Extract<AnyEvent, { type: 'gate.requested' }>,
  ): void {
    db.prepare(
      `INSERT INTO gates
        (id, task_id, node_run_id, kind, ask, status, attempt, payload, requested_at, remind_at, escalate_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      event.payload.gateId,
      event.taskId ?? null,
      event.nodeRunId ?? null,
      event.payload.kind,
      event.payload.ask,
      event.payload.attempt,
      json(event.payload.payload),
      event.ts,
      event.payload.remindAt ?? null,
      event.payload.escalateAt ?? null,
    );
  }

  private gateDecided(
    db: Database,
    event: Extract<AnyEvent, { type: 'gate.passed' | 'gate.failed' }>,
    status: 'passed' | 'failed',
  ): void {
    db.prepare(
      `UPDATE gates SET status = ?, decision = ?, decided_by = ?, decided_at = ?, result = ?
       WHERE id = ?`,
    ).run(
      status,
      event.payload.decision,
      event.payload.by ?? null,
      event.ts,
      json({ comment: event.payload.comment ?? null }),
      event.payload.gateId,
    );
  }

  private updateGateStatus(db: Database, event: AnyEvent, status: string): void {
    const gateId = gateIdOf(event);
    db.prepare(
      `UPDATE gates SET status = ?, decided_at = COALESCE(?, decided_at) WHERE id = ?`,
    ).run(status, event.ts, gateId);
  }

  private gateOverridden(
    db: Database,
    event: Extract<AnyEvent, { type: 'gate.overridden' }>,
  ): void {
    db.prepare(
      `UPDATE gates SET status = 'passed', decision = 'approve', decided_by = ?, decided_at = ?, result = ?
       WHERE id = ?`,
    ).run(event.payload.by, event.ts, json({ reason: event.payload.reason }), event.payload.gateId);
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function requireTaskId(event: AnyEvent): string {
  if (!event.taskId) {
    throw new AppError('E_PROJECTION', `事件 ${event.type} 缺少 taskId`);
  }
  return event.taskId;
}

function requireRunId(event: AnyEvent): string {
  if (!event.runId) {
    throw new AppError('E_PROJECTION', `事件 ${event.type} 缺少 runId`);
  }
  return event.runId;
}

function requireNodeRunId(event: AnyEvent): string {
  if (!event.nodeRunId) {
    throw new AppError('E_PROJECTION', `事件 ${event.type} 缺少 nodeRunId`);
  }
  return event.nodeRunId;
}

function gateIdOf(event: AnyEvent): string {
  const payload = event.payload as { gateId?: string };
  if (!payload.gateId) {
    throw new AppError('E_PROJECTION', `事件 ${event.type} 缺少 gateId`);
  }
  return payload.gateId;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
