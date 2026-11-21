import type {
  WorkAssignmentRow,
  WorkEventRow,
  WorkGroupRow,
  WorkItemCommentRow,
  WorkItemRow,
  WorkOutboxRow,
  WorkReportRow,
  PrivateMessageRow,
  PrivateThreadRow,
  WorkSourceRuleRow,
  WorkActorType,
  WorkEventType,
  WorkItemState,
  AssignmentState,
} from './types.js';

export function toGroup(row: Record<string, unknown>): WorkGroupRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    topic: row.topic == null ? null : String(row.topic),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toEvent(row: Record<string, unknown>): WorkEventRow {
  return {
    id: String(row.id),
    projectId: row.project_id == null ? null : String(row.project_id),
    groupId: row.group_id == null ? null : String(row.group_id),
    type: String(row.type) as WorkEventType,
    actorType: String(row.actor_type) as WorkActorType,
    actorId: String(row.actor_id),
    payload: parseJson(row.payload),
    correlationId: String(row.correlation_id),
    causationId: row.causation_id == null ? null : String(row.causation_id),
    dedupeKey: String(row.dedupe_key),
    depth: Number(row.depth ?? 0),
    createdAt: String(row.created_at),
  };
}

export function toWorkItem(row: Record<string, unknown>): WorkItemRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    groupId: row.group_id == null ? null : String(row.group_id),
    originEventId:
      row.origin_event_id == null ? null : String(row.origin_event_id),
    requestedByType: String(row.requested_by_type) as WorkActorType,
    requestedById: String(row.requested_by_id),
    title: String(row.title),
    intent: row.intent == null ? null : String(row.intent),
    state: String(row.state) as WorkItemState,
    priority: Number(row.priority ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toAssignment(row: Record<string, unknown>): WorkAssignmentRow {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    agentId: String(row.agent_id),
    groupId: row.group_id == null ? null : String(row.group_id),
    role: String(row.role) as WorkAssignmentRow['role'],
    state: String(row.state) as AssignmentState,
    requestedByEventId:
      row.requested_by_event_id == null
        ? null
        : String(row.requested_by_event_id),
    runId: row.run_id == null ? null : String(row.run_id),
    dependsOn: [],
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toReport(row: Record<string, unknown>): WorkReportRow {
  return {
    id: String(row.id),
    assignmentId: String(row.assignment_id),
    kind: String(row.kind) as WorkReportRow['kind'],
    summary: String(row.summary),
    artifacts: parseJsonArray(row.artifacts),
    createdAt: String(row.created_at),
  };
}

export function toPrivateThread(row: Record<string, unknown>): PrivateThreadRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    agentId: String(row.agent_id),
    userId: String(row.user_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toPrivateMessage(row: Record<string, unknown>): PrivateMessageRow {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    actorType: String(row.actor_type) as WorkActorType,
    actorId: String(row.actor_id),
    content: String(row.content),
    metadata: parseJson(row.metadata),
    createdAt: String(row.created_at),
  };
}

export function toWorkItemComment(row: Record<string, unknown>): WorkItemCommentRow {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    authorType: String(row.author_type) as WorkActorType,
    authorId: String(row.author_id),
    content: String(row.content),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

export function toSourceRule(row: Record<string, unknown>): WorkSourceRuleRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    groupId: row.group_id == null ? null : String(row.group_id),
    source: String(row.source),
    actions: parseJsonArray(row.actions).filter(
      (action): action is string => typeof action === 'string',
    ),
    labels: parseJsonArray(row.labels).filter(
      (label): label is string => typeof label === 'string',
    ),
    authors: parseJsonArray(row.authors).filter(
      (author): author is string => typeof author === 'string',
    ),
    enabled: Number(row.enabled ?? 1) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toOutbox(row: Record<string, unknown>): WorkOutboxRow {  return {
    id: String(row.id),
    projectId: String(row.project_id),
    groupId: row.group_id == null ? null : String(row.group_id),
    workItemId: row.work_item_id == null ? null : String(row.work_item_id),
    source: String(row.source),
    externalId: row.external_id == null ? null : String(row.external_id),
    kind: String(row.kind),
    payload: parseJson(row.payload),
    status: String(row.status) as WorkOutboxRow['status'],
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lastError: row.last_error == null ? null : String(row.last_error),
    nextAttemptAt:
      row.next_attempt_at == null ? null : String(row.next_attempt_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
