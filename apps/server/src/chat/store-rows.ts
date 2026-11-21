import type { WorkflowSpec } from '@spec-agent/schema';
import type { ProjectPlanDraftItem } from '@spec-agent/runtime';
import type {
  ChatSessionRow,
  ChatProjectRow,
  ChatParticipantRow,
  ChatMessageRow,
  ChangeSetRow,
  ChangeSetStatus,
  ProjectPlanDraftRow,
  ProjectPlanDraftStatus,
  WorkflowDraftRow,
  WorkflowDraftStatus,
} from './store-types.js';

export function toSession(row: Record<string, unknown>): ChatSessionRow {
  return {
    id: String(row.id),
    title: String(row.title),
    mode: String(row.mode) === 'task' ? 'task' : 'qa',
    kind:
      row.kind === 'direct' || row.kind === 'group'
        ? row.kind
        : 'assistant',
    assistantAgentId:
      row.assistant_agent_id == null ? 'assistant' : String(row.assistant_agent_id),
    primaryAgentId:
      row.primary_agent_id == null ? null : String(row.primary_agent_id),
    projectId:
      row.project_id == null ? null : String(row.project_id),
    dshSessionId: row.dsh_session_id === null ? null : String(row.dsh_session_id),
    providerId: row.provider_id == null ? null : String(row.provider_id),
    model: row.model == null ? null : String(row.model),
    permissionMode:
      row.permission_mode === 'workspace-write' ||
      row.permission_mode === 'danger-full-access'
        ? row.permission_mode
        : 'read-only',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toProject(row: Record<string, unknown>): ChatProjectRow {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    root: row.root == null ? null : String(row.root),
    repoPath: row.repo_path == null ? null : String(row.repo_path),
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function toParticipant(row: Record<string, unknown>): ChatParticipantRow {
  return {
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    role: String(row.role) === 'assistant' ? 'assistant' : 'member',
    agentSessionId:
      row.agent_session_id === null || row.agent_session_id === undefined
        ? null
        : String(row.agent_session_id),
    joinedAt: String(row.joined_at),
  };
}

export function toMessage(row: Record<string, unknown>): ChatMessageRow {
  const role = String(row.role) as ChatMessageRow['role'];
  const senderType =
    row.sender_type === 'assistant' ||
    row.sender_type === 'agent' ||
    row.sender_type === 'system'
      ? row.sender_type
      : 'user';
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role,
    senderType,
    senderAgentId:
      row.sender_agent_id === null || row.sender_agent_id === undefined
        ? null
        : String(row.sender_agent_id),
    content: String(row.content),
    reasoning: row.reasoning === null ? null : String(row.reasoning),
    mode: String(row.mode) === 'task' ? 'task' : 'qa',
    status: String(row.status) === 'error' ? 'error' : 'complete',
    taskId: row.task_id === null ? null : String(row.task_id),
    changeSetId: row.change_set_id === null ? null : String(row.change_set_id),
    projectPlanDraftId:
      row.project_plan_draft_id === null || row.project_plan_draft_id === undefined
        ? null
        : String(row.project_plan_draft_id),
    workflowDraftId:
      row.workflow_draft_id === null || row.workflow_draft_id === undefined
        ? null
        : String(row.workflow_draft_id),
    mentions: parseStringArray(row.mentions_json),
    createdAt: String(row.created_at),
  };
}

export function toChangeSet(row: Record<string, unknown>): ChangeSetRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    summary: String(row.summary),
    operations: parseJson(row.operations),
    status: String(row.status) as ChangeSetStatus,
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    appliedAt: row.applied_at === null ? null : String(row.applied_at),
  };
}

export function toWorkflowDraft(row: Record<string, unknown>): WorkflowDraftRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    goal: String(row.goal),
    title: String(row.title),
    assignee: String(row.assignee),
    spec: parseJsonObject(row.spec_json) as unknown as WorkflowSpec,
    planUsage: parseJsonValue(row.plan_usage_json),
    repoPath: row.repo_path == null ? null : String(row.repo_path),
    status: String(row.status) as WorkflowDraftStatus,
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at),
    appliedAt:
      row.applied_at === null || row.applied_at === undefined
        ? null
        : String(row.applied_at),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function toProjectPlanDraft(row: Record<string, unknown>): ProjectPlanDraftRow {  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    title: String(row.title),
    goal: String(row.goal),
    verifyCommand: row.verify_command === null ? null : String(row.verify_command),
    workstreams: parseJson(row.workstreams) as ProjectPlanDraftItem[],
    status: String(row.status) as ProjectPlanDraftStatus,
    error: row.error === null ? null : String(row.error),
    planId: row.plan_id === null ? null : String(row.plan_id),
    createdAt: String(row.created_at),
    appliedAt: row.applied_at === null ? null : String(row.applied_at),
  };
}

function parseJson(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}


