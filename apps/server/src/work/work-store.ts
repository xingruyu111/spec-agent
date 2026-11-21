/**
 * v2 群聊 / 事件 / Work Item 持久层。
 *
 * 这些表与旧 chat/task 表共用一个 SQLite，但领域边界独立：
 * 消息先成为事件，事件再派生 Work Item 和执行分派。
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';

export type * from './types.js';
import { WorkOutboxRepository } from './outbox-repository.js';
import { WorkGroupRepository } from './group-repository.js';
import { WorkItemRepository } from './work-item-repository.js';
import { PrivateThreadRepository } from './private-thread-repository.js';
import { AssignmentRepository } from './assignment-repository.js';
import { SourceRuleRepository } from './source-rule-repository.js';
import { WorkItemAuxRepository } from './work-item-aux-repository.js';
import { toAssignment, toEvent, toGroup, toOutbox, toPrivateMessage, toPrivateThread, toReport, toSourceRule, toWorkItem, toWorkItemComment } from './rows.js';
import type {
  AssignmentState,
  PrivateMessageRow,
  PrivateThreadRow,
  WorkActorType,
  WorkAssignmentRow,
  WorkEventRow,
  WorkEventType,
  WorkGroupMemberRow,
  WorkGroupRow,
  WorkItemCommentRow,
  WorkItemRow,
  WorkItemState,
  WorkOutboxAttemptRow,
  WorkOutboxRow,
  WorkReportRow,
  WorkSourceRuleRow,
} from './types.js';

export class WorkStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly outbox = new WorkOutboxRepository(db, clock),
    private readonly sourceRules = new SourceRuleRepository(db, clock),
    private readonly aux = new WorkItemAuxRepository(db, clock),
    private readonly groups = new WorkGroupRepository(db, clock),
    private readonly items = new WorkItemRepository(db, clock),
    private readonly assignments = new AssignmentRepository(db, clock),
    private readonly privateThreads = new PrivateThreadRepository(db, clock),
  ) {}

  createGroup(...args: Parameters<WorkGroupRepository['createGroup']>) {
    return this.groups.createGroup(...args);
  }

  getGroup(...args: Parameters<WorkGroupRepository['getGroup']>) {
    return this.groups.getGroup(...args);
  }

  listGroups(...args: Parameters<WorkGroupRepository['listGroups']>) {
    return this.groups.listGroups(...args);
  }

  addMember(...args: Parameters<WorkGroupRepository['addMember']>) {
    return this.groups.addMember(...args);
  }

  listMembers(...args: Parameters<WorkGroupRepository['listMembers']>) {
    return this.groups.listMembers(...args);
  }

  findEventByDedupeKey(...args: Parameters<WorkGroupRepository['findEventByDedupeKey']>) {
    return this.groups.findEventByDedupeKey(...args);
  }

  appendEvent(...args: Parameters<WorkGroupRepository['appendEvent']>) {
    return this.groups.appendEvent(...args);
  }

  listEvents(...args: Parameters<WorkGroupRepository['listEvents']>) {
    return this.groups.listEvents(...args);
  }

  getEvent(...args: Parameters<WorkGroupRepository['getEvent']>) {
    return this.groups.getEvent(...args);
  }

  createWorkItem(...args: Parameters<WorkItemRepository['createWorkItem']>) {
    return this.items.createWorkItem(...args);
  }

  getWorkItem(...args: Parameters<WorkItemRepository['getWorkItem']>) {
    return this.items.getWorkItem(...args);
  }

  listWorkItems(...args: Parameters<WorkItemRepository['listWorkItems']>) {
    return this.items.listWorkItems(...args);
  }

  updateWorkItem(...args: Parameters<WorkItemRepository['updateWorkItem']>) {
    return this.items.updateWorkItem(...args);
  }

  createAssignment(...args: Parameters<AssignmentRepository['createAssignment']>) {
    return this.assignments.createAssignment(...args);
  }

  updateAssignment(...args: Parameters<AssignmentRepository['updateAssignment']>) {
    return this.assignments.updateAssignment(...args);
  }

  listAssignments(...args: Parameters<AssignmentRepository['listAssignments']>) {
    return this.assignments.listAssignments(...args);
  }

  getAssignment(...args: Parameters<AssignmentRepository['getAssignment']>) {
    return this.assignments.getAssignment(...args);
  }

  incrementAttempts(...args: Parameters<AssignmentRepository['incrementAttempts']>) {
    return this.assignments.incrementAttempts(...args);
  }

  resetAssignment(...args: Parameters<AssignmentRepository['resetAssignment']>) {
    return this.assignments.resetAssignment(...args);
  }

  enqueueOutbox(...args: Parameters<WorkOutboxRepository['enqueueOutbox']>) {
    return this.outbox.enqueueOutbox(...args);
  }

  listProjectOutboxAttempts(...args: Parameters<WorkOutboxRepository['listProjectOutboxAttempts']>) {
    return this.outbox.listProjectOutboxAttempts(...args);
  }

  cleanupOutboxAttempts(...args: Parameters<WorkOutboxRepository['cleanupOutboxAttempts']>) {
    return this.outbox.cleanupOutboxAttempts(...args);
  }

  listOutboxAttempts(...args: Parameters<WorkOutboxRepository['listOutboxAttempts']>) {
    return this.outbox.listOutboxAttempts(...args);
  }

  getOutbox(...args: Parameters<WorkOutboxRepository['getOutbox']>) {
    return this.outbox.getOutbox(...args);
  }

  listOutbox(...args: Parameters<WorkOutboxRepository['listOutbox']>) {
    return this.outbox.listOutbox(...args);
  }

  markOutbox(...args: Parameters<WorkOutboxRepository['markOutbox']>) {
    return this.outbox.markOutbox(...args);
  }

  listPendingOutbox(...args: Parameters<WorkOutboxRepository['listPendingOutbox']>) {
    return this.outbox.listPendingOutbox(...args);
  }

  listPendingOutboxAll(...args: Parameters<WorkOutboxRepository['listPendingOutboxAll']>) {
    return this.outbox.listPendingOutboxAll(...args);
  }

  retryOutbox(...args: Parameters<WorkOutboxRepository['retryOutbox']>) {
    return this.outbox.retryOutbox(...args);
  }

  recordOutboxAttempt(...args: Parameters<WorkOutboxRepository['recordOutboxAttempt']>) {
    return this.outbox.recordOutboxAttempt(...args);
  }

  listRunningAssignments() {
    const rows = this.db
      .prepare(
        `SELECT a.*, i.title AS item_title, i.state AS item_state
         FROM work_assignments a
         JOIN work_items i ON i.id = a.work_item_id
         WHERE a.state = 'running'
         ORDER BY a.updated_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.withDeps(toAssignment(row)),
      itemTitle: String(row.item_title),
      itemState: String(row.item_state) as WorkItemState,
    }));
  }

  listSourceRules(...args: Parameters<SourceRuleRepository['listSourceRules']>) {
    return this.sourceRules.listSourceRules(...args);
  }

  getSourceRule(...args: Parameters<SourceRuleRepository['getSourceRule']>) {
    return this.sourceRules.getSourceRule(...args);
  }

  upsertSourceRule(...args: Parameters<SourceRuleRepository['upsertSourceRule']>) {
    return this.sourceRules.upsertSourceRule(...args);
  }

  deleteSourceRule(...args: Parameters<SourceRuleRepository['deleteSourceRule']>) {
    return this.sourceRules.deleteSourceRule(...args);
  }

  listWorkItemComments(...args: Parameters<WorkItemAuxRepository['listWorkItemComments']>) {
    return this.aux.listWorkItemComments(...args);
  }

  addWorkItemComment(...args: Parameters<WorkItemAuxRepository['addWorkItemComment']>) {
    return this.aux.addWorkItemComment(...args);
  }

  updateWorkItemComment(...args: Parameters<WorkItemAuxRepository['updateWorkItemComment']>) {
    return this.aux.updateWorkItemComment(...args);
  }

  deleteWorkItemComment(...args: Parameters<WorkItemAuxRepository['deleteWorkItemComment']>) {
    return this.aux.deleteWorkItemComment(...args);
  }

  getPrivateThread(...args: Parameters<PrivateThreadRepository['getPrivateThread']>) {
    return this.privateThreads.getPrivateThread(...args);
  }

  getOrCreatePrivateThread(...args: Parameters<PrivateThreadRepository['getOrCreatePrivateThread']>) {
    return this.privateThreads.getOrCreatePrivateThread(...args);
  }

  addPrivateMessage(...args: Parameters<PrivateThreadRepository['addPrivateMessage']>) {
    return this.privateThreads.addPrivateMessage(...args);
  }

  listPrivateMessages(...args: Parameters<PrivateThreadRepository['listPrivateMessages']>) {
    return this.privateThreads.listPrivateMessages(...args);
  }

  /**
   * Agent 在项目里的执行历史，用于私聊“你做了什么”。
   */
  listQueuedAssignments(...args: Parameters<WorkItemAuxRepository['listQueuedAssignments']>) {
    return this.aux.listQueuedAssignments(...args);
  }

  listDeadLetters(...args: Parameters<WorkItemAuxRepository['listDeadLetters']>) {
    return this.aux.listDeadLetters(...args);
  }

  addReport(...args: Parameters<WorkItemAuxRepository['addReport']>) {
    return this.aux.addReport(...args);
  }

  listReports(...args: Parameters<WorkItemAuxRepository['listReports']>) {
    return this.aux.listReports(...args);
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

  listAssignmentsByAgent(...args: Parameters<AssignmentRepository['listAssignmentsByAgent']>) {
    return this.assignments.listAssignmentsByAgent(...args);
  }
}


