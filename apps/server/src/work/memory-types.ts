export type WorkMemoryScope =
  | 'org'
  | 'project'
  | 'group'
  | 'agent'
  | 'private'
  | 'execution';

export type WorkMemoryRow = {
  id: string;
  projectId: string;
  scopeType: WorkMemoryScope;
  scopeId: string;
  agentId: string | null;
  kind: string;
  content: string;
  source: string | null;
  confidence: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkMemorySearchHit = WorkMemoryRow & {
  score: number;
  lexicalScore: number;
  vectorScore: number;
};

export type WorkMemoryConflict = {
  memory: WorkMemoryRow;
  score: number;
};

export type WorkMemoryVersionRow = {
  id: string;
  memoryId: string;
  content: string;
  source: string | null;
  createdAt: string;
};

