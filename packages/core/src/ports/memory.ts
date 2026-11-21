/** Unified memory boundary for chat Copilot and organization agents. */

export type MemoryQuery = {
  projectId: string;
  agentId?: string | null;
  taskId?: string;
  userId?: string;
  query: string;
  limit?: number;
};

export type MemoryResult = {
  memories: string[];
  /** 可选来源标识，便于诊断；不直接注入 prompt */
  sources?: string[];
};

export type MemoryConversationInput = {
  projectId: string;
  sessionId: string;
  agentId?: string | null;
  taskId?: string;
  userId?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
  }>;
};

export type MemoryTaskInput = {
  projectId: string;
  taskId: string;
  agentId?: string | null;
  userId?: string;
  title: string;
  status: string;
  summary: string;
};

export type MemoryNodeOutcome = {
  taskId: string;
  nodeRunId: string;
  nodeId: string;
  agentId?: string | null;
  title: string;
  status: string;
  summary: string;
  outputs?: Array<{ name: string; path?: string }>;
  usd?: number;
};

export interface MemoryProvider {
  readonly kind: 'local' | 'tencent' | 'hy-memory' | 'composite';
  retrieve(input: MemoryQuery): Promise<MemoryResult>;
  ingestConversation(input: MemoryConversationInput): Promise<void>;
  ingestTaskResult(input: MemoryTaskInput): Promise<void>;
  ingestNodeOutcome?(input: MemoryNodeOutcome & { projectId: string }): Promise<void>;
}
