import type { WorkflowSpec } from '@spec-agent/schema';
import type { ProjectPlanDraftItem } from '@spec-agent/runtime';

export type ChatMode = 'qa' | 'task';
export type ChatSessionKind = 'assistant' | 'direct' | 'group';
export type ChatPermissionMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';
export type ChatParticipantRole = 'assistant' | 'member';

export type ChatSessionRow = {
  id: string;
  title: string;
  mode: ChatMode;
  kind: ChatSessionKind;
  assistantAgentId: string;
  primaryAgentId: string | null;
  projectId: string | null;
  dshSessionId: string | null;
  providerId: string | null;
  model: string | null;
  permissionMode: ChatPermissionMode;
  createdAt: string;
  updatedAt: string;
};

export type ChatProjectRow = {
  id: string;
  name: string;
  description: string | null;
  root: string | null;
  repoPath: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

export type ChatParticipantRow = {
  sessionId: string;
  agentId: string;
  role: ChatParticipantRole;
  agentSessionId: string | null;
  joinedAt: string;
};

export type ChatMessageRow = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  senderType: 'user' | 'assistant' | 'agent' | 'system';
  senderAgentId: string | null;
  content: string;
  reasoning: string | null;
  mode: ChatMode;
  status: 'complete' | 'error';
  taskId: string | null;
  changeSetId: string | null;
  projectPlanDraftId: string | null;
  workflowDraftId: string | null;
  mentions: string[];
  createdAt: string;
};

export type ChangeSetStatus = 'pending' | 'applied' | 'rejected';

export type ChangeSetRow = {
  id: string;
  sessionId: string;
  summary: string;
  operations: unknown[];
  status: ChangeSetStatus;
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
};

export type CreateChangeSetInput = {
  sessionId: string;
  summary: string;
  operations: unknown[];
};

export type ProjectPlanDraftStatus = 'pending' | 'applied' | 'rejected';

export type WorkflowDraftStatus = 'pending' | 'applied' | 'rejected';

export type WorkflowDraftRow = {
  id: string;
  sessionId: string;
  goal: string;
  title: string;
  assignee: string;
  spec: WorkflowSpec;
  planUsage: unknown;
  repoPath: string | null;
  status: WorkflowDraftStatus;
  taskId: string | null;
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
};

export type ProjectPlanDraftRow = {
  id: string;
  sessionId: string;
  title: string;
  goal: string;
  verifyCommand: string | null;
  workstreams: ProjectPlanDraftItem[];
  status: ProjectPlanDraftStatus;
  error: string | null;
  planId: string | null;
  createdAt: string;
  appliedAt: string | null;
};


