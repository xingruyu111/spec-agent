import type { WorkAssignmentRow, WorkEventRow, WorkItemRow, WorkReportRow, WorkStore } from './work-store.js';

export class AssignmentService {
  constructor(private readonly store: WorkStore) {}

  assignWorkItem(
    workItemId: string,
    agentId: string,
    dependsOn: string[] = [],
  ): { item: WorkItemRow; assignment: WorkAssignmentRow } {
    const item = this.store.getWorkItem(workItemId);
    if (!item) throw new Error(`work item 不存在：${workItemId}`);
    const assignment = this.store.createAssignment({
      workItemId: item.id,
      agentId,
      groupId: item.groupId,
      requestedByEventId: item.originEventId,
      dependsOn,
    });
    const next = this.store.updateWorkItem(item.id, { state: 'ready' });
    return { item: next, assignment };
  }

  dependenciesSatisfied(assignmentId: string): {
    ready: boolean;
    pending: string[];
  } {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) return { ready: false, pending: [] };
    const all = this.store.listAssignments(assignment.workItemId);
    const pending = assignment.dependsOn.filter((dependencyId) => {
      const dependency = all.find((candidate) => candidate.id === dependencyId);
      return !dependency || dependency.state !== 'done';
    });
    return { ready: pending.length === 0, pending };
  }

  cancelAssignment(assignmentId: string): WorkAssignmentRow {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) throw new Error(`assignment 不存在：${assignmentId}`);
    if (assignment.state === 'done') {
      throw new Error('已完成的 Assignment 不能取消');
    }
    const cancelled = this.store.updateAssignment(assignmentId, {
      state: 'cancelled',
    });
    const all = this.store.listAssignments(assignment.workItemId);
    if (
      all.length > 0 &&
      all.every(
        (candidate) =>
          candidate.state === 'cancelled' ||
          candidate.state === 'failed',
      )
    ) {
      this.store.updateWorkItem(assignment.workItemId, { state: 'cancelled' });
    }
    return cancelled;
  }

  retryAssignment(assignmentId: string): WorkAssignmentRow {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) throw new Error(`assignment 不存在：${assignmentId}`);
    if (assignment.attempts >= assignment.maxAttempts) {
      throw new Error(
        `已超过最大重试次数（${assignment.attempts}/${assignment.maxAttempts}），进入死信`,
      );
    }
    if (
      assignment.state !== 'failed' &&
      assignment.state !== 'cancelled' &&
      assignment.state !== 'blocked'
    ) {
      throw new Error(`当前状态不能重试：${assignment.state}`);
    }
    const retried = this.store.updateAssignment(assignmentId, {
      state: 'queued',
      runId: null,
    });
    const item = this.store.getWorkItem(assignment.workItemId);
    if (item?.state === 'cancelled' || item?.state === 'failed') {
      this.store.updateWorkItem(item.id, { state: 'ready' });
    }
    return retried;
  }

  incrementAttempts(assignmentId: string): WorkAssignmentRow {
    return this.store.incrementAttempts(assignmentId);
  }

  deadLetters(projectId: string) {
    return this.store.listDeadLetters(projectId);
  }

  queuedAssignments(projectId: string) {
    return this.store.listQueuedAssignments(projectId);
  }

  recoverRunning(): { count: number; workItemIds: string[] } {
    const rows = this.store.listRunningAssignments();
    const workItemIds = new Set<string>();
    for (const assignment of rows) {
      this.store.updateAssignment(assignment.id, {
        state: 'queued',
        runId: null,
      });
      this.store.updateWorkItem(assignment.workItemId, { state: 'ready' });
      workItemIds.add(assignment.workItemId);
    }
    return { count: rows.length, workItemIds: [...workItemIds] };
  }

  startAssignment(assignmentId: string, runId?: string): WorkAssignmentRow {
    const assignment = this.store.updateAssignment(assignmentId, {
      state: 'running',
      ...(runId ? { runId } : {}),
    });
    const item = this.store.updateWorkItem(assignment.workItemId, {
      state: 'running',
    });
    this.store.appendEvent({
      projectId: item.projectId,
      groupId: assignment.groupId ?? item.groupId,
      type: 'assignment.started',
      actor: { type: 'agent', id: assignment.agentId },
      payload: {
        assignmentId: assignment.id,
        workItemId: item.id,
        agentId: assignment.agentId,
        runId: assignment.runId,
      },
      correlationId: `assignment:${assignment.id}`,
    });
    return assignment;
  }

  /**
   * 工具事件流水。只记录可展示的预览；完整输出留在 Run/Artifact。
   */
  recordProgress(
    assignmentId: string,
    event: {
      phase: 'call' | 'result';
      toolUseId: string;
      tool: string;
      inputPreview?: string;
      outputPreview?: string;
    },
  ): void {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) return;
    const item = this.store.getWorkItem(assignment.workItemId);
    if (!item) return;
    this.store.appendEvent({
      projectId: item.projectId,
      groupId: assignment.groupId ?? item.groupId,
      type: 'assignment.progress',
      actor: { type: 'agent', id: assignment.agentId },
      payload: {
        assignmentId: assignment.id,
        workItemId: item.id,
        ...event,
      },
      correlationId: `assignment:${assignment.id}`,
    });
  }

  /**
   * Assignment 终态报告。完成/阻塞都会回到群聊，并 @ 发起事件的人。
   */
  reportAssignment(input: {
    assignmentId: string;
    kind: WorkReportRow['kind'];
    summary: string;
    artifacts?: unknown[];
  }): {
    report: WorkReportRow;
    assignment: WorkAssignmentRow;
    workItem: WorkItemRow;
    event: WorkEventRow;
  } {
    const assignment = this.store.getAssignment(input.assignmentId);
    if (!assignment) throw new Error(`assignment 不存在：${input.assignmentId}`);
    const state =
      input.kind === 'blocked' || input.kind === 'question'
        ? 'blocked'
        : input.kind === 'done' || input.kind === 'review'
          ? 'done'
          : 'running';
    const updated = this.store.updateAssignment(assignment.id, { state });
    const item = this.store.getWorkItem(assignment.workItemId);
    if (!item) throw new Error(`work item 不存在：${assignment.workItemId}`);
    const all = this.store.listAssignments(item.id);
    const workState =
      input.kind === 'blocked' || input.kind === 'question'
        ? 'blocked'
        : all.every((candidate) => candidate.state === 'done')
          ? 'done'
          : 'running';
    const nextItem = this.store.updateWorkItem(item.id, { state: workState });
    const report = this.store.addReport({
      assignmentId: assignment.id,
      kind: input.kind,
      summary: input.summary,
      artifacts: input.artifacts,
    });
    const origin = assignment.requestedByEventId
      ? this.store.getEvent(assignment.requestedByEventId)
      : undefined;
    const requester = origin?.actorId ?? item.requestedById;
    const { event } = this.store.appendEvent({
      projectId: item.projectId,
      groupId: assignment.groupId ?? item.groupId,
      type: 'assignment.reported',
      actor: { type: 'agent', id: assignment.agentId },
      payload: {
        assignmentId: assignment.id,
        workItemId: item.id,
        reportId: report.id,
        kind: input.kind,
        summary: input.summary,
        mention: requester,
      },
      correlationId: `assignment:${assignment.id}`,
      causationId: assignment.requestedByEventId,
      depth: (origin?.depth ?? 0) + 1,
    });
    if (workState === 'done' && item.originEventId) {
      const originMessage = this.store.getEvent(item.originEventId);
      const source = originMessage?.payload.source;
      const externalId = originMessage?.payload.externalId;
      if (
        typeof source === 'string' &&
        typeof externalId === 'string' &&
        source === 'github'
      ) {
        const outbox = this.store.enqueueOutbox({
          projectId: item.projectId,
          groupId: assignment.groupId ?? item.groupId,
          workItemId: item.id,
          source,
          externalId,
          kind: 'comment',
          payload: {
            body: `Work Item「${item.title}」已完成。\n\n${input.summary}`,
            workItemId: item.id,
            reportId: report.id,
            ...(typeof originMessage?.payload.url === 'string'
              ? { url: originMessage.payload.url }
              : {}),
          },
        });
        this.store.appendEvent({
          projectId: item.projectId,
          groupId: assignment.groupId ?? item.groupId,
          type: 'outbox.pending',
          actor: { type: 'system', id: 'outbox' },
          payload: {
            outboxId: outbox.id,
            source,
            externalId,
          },
          correlationId: `outbox:${outbox.id}`,
        });
      }
    }
    return { report, assignment: updated, workItem: nextItem, event };
  }
}

