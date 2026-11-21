import type { AgentConfig, WorkflowSpec } from '@spec-agent/schema';
import type {
  AgentRuntime,
  ProviderConfig,
  Store,
  MemoryProvider,
} from '@spec-agent/core';
import type { ProjectPlanDraftItem } from '@spec-agent/runtime';
import type {
  ChangeSetRow,
  ChatMessageRow,
  ChatParticipantRow,
  ChatRepository,
  ChatSessionRow,
  ChatProjectRow,
  ProjectPlanDraftRow,
  WorkflowDraftRow,
} from './chat-store.js';
import type { ChatEngine } from '../dsh/dsh-chat.js';

export type ChatTaskCreator = (
  goal: string,
  assignee?: string,
  repoPath?: string,
) => Promise<{ taskId: string; title: string }>;

export type PlannedTask = {
  goal: string;
  title: string;
  assignee: string;
  spec: WorkflowSpec;
  planUsage?: unknown;
  repoPath?: string;
};

export type AgentRelayContext = { from: string; content: string };

export type AgentTurnItem = {
  agent: AgentConfig;
  relay: AgentRelayContext | null;
};

export type ChatServiceOptions = {
  root: string;
  /** 项目显示名，仅用于 Copilot 上下文 */
  projectName?: string;
  /** MemoryProvider 的 team 隔离 ID */
  projectId?: string;
  memory?: MemoryProvider;
  store: Store;
  repo: ChatRepository;
  engine: ChatEngine;
  /** 用于 @agent 的直接回复；未提供时只支持助理回复 */
  agentRuntime?: AgentRuntime;
  provider?: ProviderConfig;
  agents: () => AgentConfig[];
  createTask: ChatTaskCreator;
  /** 任务模式：只生成计划，不执行；与 confirmTask 同时提供时启用草案流程。 */
  planTask?: (
    goal: string,
    assignee?: string,
    repoPath?: string,
  ) => Promise<PlannedTask>;
  confirmTask?: (plan: PlannedTask) => Promise<{ taskId: string; title: string }>;
  reloadAgents: (agents: AgentConfig[]) => void;
  autoMemory?: boolean;
  model?: () => string;
  providers?: () => ProviderConfig[];
  defaultRoute?: () => { providerId: string; model: string };
  maxWorkstreams?: number;
  createProjectPlan?: (draft: {
    title: string;
    goal: string;
    verifyCommand: string | null;
    workstreams: ProjectPlanDraftItem[];
  }, context?: {
    projectId?: string;
    repoPath?: string;
  }) => Promise<{ id: string }>;
};

export type ChatSessionDetail = {
  session: ChatSessionRow;
  participants: ChatParticipantRow[];
  messages: Array<
    ChatMessageRow & {
      changeSet?: ChangeSetDTO | null;
      projectPlanDraft?: ProjectPlanDraftRow | null;
      workflowDraft?: WorkflowDraftRow | null;
    }
  >;
};

export type ChangeSetDTO = {
  id: string;
  sessionId: string;
  summary: string;
  operations: unknown[];
  status: string;
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
};

export type MemoryDTO = {
  id: string;
  scope: string;
  agentId: string | null;
  content: string;
  source: string | null;
  tags: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};


