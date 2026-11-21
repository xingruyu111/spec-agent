/**
 * v2 群聊事件路由与 Work Item 生命周期。
 *
 * 规则：
 * - 群聊消息先落成 domain event；
 * - 没有 @ 时收件人是助理 Agent；
 * - @ 谁就路由给谁；
 * - Assignment 完成后产生 report 事件，并 @ 发起人；
 * - @ 是事件，不是文本特判。
 */

import { AssignmentService } from './assignment-service.js';
import { OutboxService } from './outbox-service.js';
import { CommentService } from './comment-service.js';
import { SourceRuleService } from './source-rule-service.js';
import { PrivateMessageService } from './private-message-service.js';
import { GroupIntakeService } from './group-intake-service.js';
import type {
  WorkActorType,
  WorkAssignmentRow,
  WorkEventRow,
  WorkItemRow,
  WorkItemState,
  WorkOutboxRow,
  WorkReportRow,
  WorkStore,
} from './work-store.js';

export type WorkActor = {
  type: WorkActorType;
  id: string;
};

export type GroupIntake = {
  event: WorkEventRow;
  mentionEvent: WorkEventRow;
  recipients: string[];
  requiresAssistant: boolean;
};

export class WorkService {
  private readonly assistantAgentId: string;
  private readonly assignments: AssignmentService;
  private readonly outboxService: OutboxService;
  private readonly comments: CommentService;
  private readonly sourceRuleService: SourceRuleService;
  private readonly privateMessagesService: PrivateMessageService;
  private readonly groupIntake: GroupIntakeService;

  constructor(
    private readonly store: WorkStore,
    options: { assistantAgentId?: string } = {},
  ) {
    this.assistantAgentId = options.assistantAgentId ?? 'assistant';
    this.assignments = new AssignmentService(store);
    this.outboxService = new OutboxService(store);
    this.comments = new CommentService(store);
    this.sourceRuleService = new SourceRuleService(store);
    this.privateMessagesService = new PrivateMessageService(store, this.assistantAgentId);
    this.groupIntake = new GroupIntakeService(store, this.assistantAgentId, (input) => this.openWorkItem(input));
  }

  listGroups(projectId: string) {
    return this.store.listGroups(projectId);
  }

  ensureDefaultGroup(projectId: string) {
    const existing = this.store
      .listGroups(projectId)
      .find((group) => group.name === '#GitHub');
    return existing ?? this.createGroup({ projectId, name: '#GitHub' });
  }

  createGroup(input: {
    projectId: string;
    name: string;    topic?: string | null;
    members?: Array<{ type: 'user' | 'agent' | 'system'; id: string; role?: string }>;
  }) {
    return this.store.createGroup(input);
  }

  getGroup(id: string) {
    return this.store.getGroup(id);
  }

  listGroupMembers(groupId: string) {
    return this.store.listMembers(groupId);
  }

  addGroupMember(groupId: string, agentId: string) {
    this.store.addMember(groupId, 'agent', agentId);
    return this.store.listMembers(groupId);
  }

  listEvents(groupId: string, limit = 100) {
    return this.store.listEvents(groupId, limit);
  }

  listWorkItems(projectId: string, state?: WorkItemRow['state'], limit = 100) {
    return this.store.listWorkItems(projectId, state, limit);
  }

  getWorkItemDetail(id: string) {
    const item = this.store.getWorkItem(id);
    if (!item) return undefined;
    const assignments = this.store.listAssignments(id).map((assignment) => ({
      ...assignment,
      reports: this.store.listReports(assignment.id),
    }));
    return { item, assignments };
  }

  getAssignment(id: string) {
    return this.store.getAssignment(id);
  }

  listAssignments(workItemId: string) {
    return this.store.listAssignments(workItemId);
  }

  getEvent(id: string) {
    return this.store.getEvent(id);
  }

  privateThread(...args: Parameters<PrivateMessageService['privateThread']>) {
    return this.privateMessagesService.privateThread(...args);
  }

  privateMessages(...args: Parameters<PrivateMessageService['privateMessages']>) {
    return this.privateMessagesService.privateMessages(...args);
  }

  privateMessagesByThread(...args: Parameters<PrivateMessageService['privateMessagesByThread']>) {
    return this.privateMessagesService.privateMessagesByThread(...args);
  }

  appendPrivateUserMessage(...args: Parameters<PrivateMessageService['appendPrivateUserMessage']>) {
    return this.privateMessagesService.appendPrivateUserMessage(...args);
  }

  appendPrivateAgentMessage(...args: Parameters<PrivateMessageService['appendPrivateAgentMessage']>) {
    return this.privateMessagesService.appendPrivateAgentMessage(...args);
  }

  agentHistory(...args: Parameters<PrivateMessageService['agentHistory']>) {
    return this.privateMessagesService.agentHistory(...args);
  }

  sendPrivateMessage(...args: Parameters<PrivateMessageService['sendPrivateMessage']>) {
    return this.privateMessagesService.sendPrivateMessage(...args);
  }

  getWorkItem(id: string) {
    return this.store.getWorkItem(id);
  }

  /**
   * 群聊消息入口。一次消息产生 message.created + message.mention 两个事件。
   * 没有 @ 时显式路由给助理，而不是让所有 Agent 都收到。
   */
  intakeGroupMessage(...args: Parameters<GroupIntakeService['intakeGroupMessage']>) {
    return this.groupIntake.intakeGroupMessage(...args);
  }

  postAssistantMessage(...args: Parameters<GroupIntakeService['postAssistantMessage']>) {
    return this.groupIntake.postAssistantMessage(...args);
  }

  ingestSourceEvent(...args: Parameters<GroupIntakeService['ingestSourceEvent']>) {
    return this.groupIntake.ingestSourceEvent(...args);
  }

  triageMessage(...args: Parameters<GroupIntakeService['triageMessage']>) {
    return this.groupIntake.triageMessage(...args);
  }

  assignWorkItem(...args: Parameters<AssignmentService['assignWorkItem']>) {
    return this.assignments.assignWorkItem(...args);
  }

  dependenciesSatisfied(...args: Parameters<AssignmentService['dependenciesSatisfied']>) {
    return this.assignments.dependenciesSatisfied(...args);
  }

  cancelAssignment(...args: Parameters<AssignmentService['cancelAssignment']>) {
    return this.assignments.cancelAssignment(...args);
  }

  retryAssignment(...args: Parameters<AssignmentService['retryAssignment']>) {
    return this.assignments.retryAssignment(...args);
  }

  incrementAttempts(...args: Parameters<AssignmentService['incrementAttempts']>) {
    return this.assignments.incrementAttempts(...args);
  }

  deadLetters(...args: Parameters<AssignmentService['deadLetters']>) {
    return this.assignments.deadLetters(...args);
  }

  queuedAssignments(...args: Parameters<AssignmentService['queuedAssignments']>) {
    return this.assignments.queuedAssignments(...args);
  }

  listWorkItemComments(...args: Parameters<CommentService['listWorkItemComments']>) {
    return this.comments.listWorkItemComments(...args);
  }

  addWorkItemComment(...args: Parameters<CommentService['addWorkItemComment']>) {
    return this.comments.addWorkItemComment(...args);
  }

  editWorkItemComment(...args: Parameters<CommentService['editWorkItemComment']>) {
    return this.comments.editWorkItemComment(...args);
  }

  deleteWorkItemComment(...args: Parameters<CommentService['deleteWorkItemComment']>) {
    return this.comments.deleteWorkItemComment(...args);
  }

  commentAndAssign(input: {
    workItemId: string;
    authorType: 'user' | 'agent' | 'system';
    authorId: string;
    content: string;
    agentId: string;
  }) {
    const comment = this.addWorkItemComment(input);
    const assigned = this.assignWorkItem(input.workItemId, input.agentId);
    return { comment, assignment: assigned.assignment };
  }

  sourceRules(...args: Parameters<SourceRuleService['sourceRules']>) {
    return this.sourceRuleService.sourceRules(...args);
  }

  sourceRule(...args: Parameters<SourceRuleService['sourceRule']>) {
    return this.sourceRuleService.sourceRule(...args);
  }

  upsertSourceRule(...args: Parameters<SourceRuleService['upsertSourceRule']>) {
    return this.sourceRuleService.upsertSourceRule(...args);
  }

  deleteSourceRule(...args: Parameters<SourceRuleService['deleteSourceRule']>) {
    return this.sourceRuleService.deleteSourceRule(...args);
  }

  recoverRunning(...args: Parameters<AssignmentService['recoverRunning']>) {
    return this.assignments.recoverRunning(...args);
  }

  outbox(...args: Parameters<OutboxService['outbox']>) {
    return this.outboxService.outbox(...args);
  }

  outboxItem(...args: Parameters<OutboxService['outboxItem']>) {
    return this.outboxService.outboxItem(...args);
  }

  outboxAttempts(...args: Parameters<OutboxService['outboxAttempts']>) {
    return this.outboxService.outboxAttempts(...args);
  }

  cleanupOutboxAttempts(...args: Parameters<OutboxService['cleanupOutboxAttempts']>) {
    return this.outboxService.cleanupOutboxAttempts(...args);
  }

  outboxAudit(...args: Parameters<OutboxService['outboxAudit']>) {
    return this.outboxService.outboxAudit(...args);
  }

  noteOutboxResult(...args: Parameters<OutboxService['noteOutboxResult']>) {
    return this.outboxService.noteOutboxResult(...args);
  }

  markOutbox(...args: Parameters<OutboxService['markOutbox']>) {
    return this.outboxService.markOutbox(...args);
  }

  pendingOutbox(...args: Parameters<OutboxService['pendingOutbox']>) {
    return this.outboxService.pendingOutbox(...args);
  }

  pendingOutboxAll(...args: Parameters<OutboxService['pendingOutboxAll']>) {
    return this.outboxService.pendingOutboxAll(...args);
  }

  recordOutboxAttempt(...args: Parameters<OutboxService['recordOutboxAttempt']>) {
    return this.outboxService.recordOutboxAttempt(...args);
  }

  retryOutbox(...args: Parameters<OutboxService['retryOutbox']>) {
    return this.outboxService.retryOutbox(...args);
  }

  requeueDeadLetter(
    assignmentId: string,
    options: { maxAttempts?: number } = {},
  ): WorkAssignmentRow {
    const assignment = this.store.getAssignment(assignmentId);
    if (!assignment) throw new Error(`assignment 不存在：${assignmentId}`);
    if (
      (assignment.state !== 'blocked' && assignment.state !== 'failed') ||
      assignment.attempts < assignment.maxAttempts
    ) {
      throw new Error('不是死信，不能重置');
    }
    if (
      options.maxAttempts !== undefined &&
      (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
    ) {
      throw new Error('maxAttempts 必须是正整数');
    }
    const reset = this.store.resetAssignment(
      assignmentId,
      options.maxAttempts,
    );
    const item = this.store.getWorkItem(assignment.workItemId);
    if (item) this.store.updateWorkItem(item.id, { state: 'ready' });
    return reset;
  }

  setWorkItemState(id: string, state: WorkItemState): WorkItemRow {
    return this.store.updateWorkItem(id, { state });
  }

  setWorkItemPriority(id: string, priority: number): WorkItemRow {
    if (!Number.isInteger(priority)) throw new Error('priority 必须是整数');
    const item = this.store.getWorkItem(id);
    if (!item) throw new Error(`work item 不存在：${id}`);
    return this.store.updateWorkItem(id, { priority });
  }

  /**
   * 助理或规则接受一条需求，创建 Work Item。
   */
  openWorkItem(input: {
    groupId: string;
    eventId: string;
    requestedBy: WorkActor;
    title: string;
    intent?: string | null;
    priority?: number;
    assignee?: string;
  }): { item: WorkItemRow; assignment: WorkAssignmentRow | null } {
    const group = this.store.getGroup(input.groupId);
    if (!group) throw new Error(`group 不存在：${input.groupId}`);
    const item = this.store.createWorkItem({
      projectId: group.projectId,
      groupId: group.id,
      originEventId: input.eventId,
      requestedBy: input.requestedBy,
      title: input.title.trim().slice(0, 200) || '未命名工作项',
      intent: input.intent ?? null,
      priority: input.priority ?? 0,
      state: input.assignee ? 'ready' : 'inbox',
    });
    const assignment = input.assignee
      ? this.store.createAssignment({
          workItemId: item.id,
          agentId: input.assignee,
          groupId: group.id,
          requestedByEventId: input.eventId,
        })
      : null;
    this.store.appendEvent({
      projectId: group.projectId,
      groupId: group.id,
      type: 'workitem.created',
      actor: input.requestedBy,
      payload: {
        workItemId: item.id,
        title: item.title,
        assignee: input.assignee ?? null,
      },
      correlationId: `workitem:${item.id}`,
      causationId: input.eventId,
    });
    return { item, assignment };
  }

  startAssignment(...args: Parameters<AssignmentService['startAssignment']>) {
    return this.assignments.startAssignment(...args);
  }

  recordProgress(...args: Parameters<AssignmentService['recordProgress']>) {
    return this.assignments.recordProgress(...args);
  }

  reportAssignment(...args: Parameters<AssignmentService['reportAssignment']>) {
    return this.assignments.reportAssignment(...args);
  }
}
