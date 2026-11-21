export type WorkActorType = 'user' | 'agent' | 'system';
export type WorkEventType =
  | 'message.created'
  | 'message.mention'
  | 'change.requested'
  | 'workitem.created'
  | 'workitem.updated'
  | 'workitem.commented'
  | 'workitem.comment_updated'
  | 'workitem.comment_deleted'
  | 'assignment.started'
  | 'assignment.progress'
  | 'assignment.reported'
  | 'outbox.sent'
  | 'outbox.failed'
  | 'outbox.pending'
  | 'source.event';
export type WorkItemState =
  | 'inbox'
  | 'triaged'
  | 'ready'
  | 'running'
  | 'waiting_human'
  | 'blocked'
  | 'reviewing'
  | 'done'
  | 'failed'
  | 'cancelled';
export type AssignmentState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type WorkGroupRow = {
  id: string;
  projectId: string;
  name: string;
  topic: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkGroupMemberRow = {
  groupId: string;
  memberType: WorkActorType;
  memberId: string;
  role: string;
  createdAt: string;
};

export type WorkEventRow = {
  id: string;
  projectId: string | null;
  groupId: string | null;
  type: WorkEventType;
  actorType: WorkActorType;
  actorId: string;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  dedupeKey: string;
  depth: number;
  createdAt: string;
};

export type WorkItemRow = {
  id: string;
  projectId: string;
  groupId: string | null;
  originEventId: string | null;
  requestedByType: WorkActorType;
  requestedById: string;
  title: string;
  intent: string | null;
  state: WorkItemState;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkAssignmentRow = {
  id: string;
  workItemId: string;
  agentId: string;
  groupId: string | null;
  role: 'owner' | 'reviewer' | 'investigator' | 'reporter';
  state: AssignmentState;
  requestedByEventId: string | null;
  runId: string | null;
  dependsOn: string[];
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkReportRow = {
  id: string;
  assignmentId: string;
  kind: 'progress' | 'done' | 'blocked' | 'question' | 'review';
  summary: string;
  artifacts: unknown[];
  createdAt: string;
};

export type PrivateThreadRow = {
  id: string;
  projectId: string;
  agentId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

export type PrivateMessageRow = {
  id: string;
  threadId: string;
  actorType: WorkActorType;
  actorId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type WorkSourceRuleRow = {
  id: string;
  projectId: string;
  groupId: string | null;
  source: string;
  actions: string[];
  labels: string[];
  authors: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemCommentRow = {
  id: string;
  workItemId: string;
  authorType: WorkActorType;
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkOutboxAttemptRow = {
  id: string;
  outboxId: string;
  attempt: number;
  ok: boolean;
  error: string | null;
  createdAt: string;
};

export type WorkOutboxRow = {  id: string;
  projectId: string;
  groupId: string | null;
  workItemId: string | null;
  source: string;
  externalId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
};

