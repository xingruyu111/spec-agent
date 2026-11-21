type AgentNode = {
  id?: string;
  name?: string;
  [key: string]: unknown;
};

export type Project = {
  id: string;
  name: string;
  root?: string;
};

export type Agent = {
  id: string;
  name: string;
  parent: string | null;
  role: string;
  model?: { provider: string; model: string };
  tools: string[];
  writeScope: string[];
  canDelegateTo: string[];
  nodes?: AgentNode[];
};

export type AgentConfig = {
  id: string;
  name: string;
  parent: string | null;
  role: string;
  systemPrompt?: string;
  model: { provider: string; model: string };
  skills: string[];
  nodes?: AgentNode[];
  tools: { allow: string[]; deny?: string[]; shell?: string };
  canDelegateTo?: string[];
  workspace?: { writeScope: string[]; branchPrefix?: string };
  budget?: Record<string, unknown>;
  memory?: string;
};

export type ChatProject = {
  id: string;
  name: string;
  description: string | null;
  root: string | null;
  repoPath: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

export type WorkEvent = {
  id: string;
  projectId: string | null;
  groupId: string | null;
  type: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId: string | null;
  createdAt: string;
};

export type WorkGroup = {
  id: string;
  projectId: string;
  name: string;
  topic: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkItem = {
  id: string;
  projectId: string;
  groupId: string | null;
  title: string;
  intent: string | null;
  state: string;
  priority: number;
  requestedByType: string;
  requestedById: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkAssignment = {
  id: string;
  workItemId: string;
  agentId: string;
  groupId: string | null;
  role: string;
  state: string;
  dependsOn: string[];
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export type PrivateThread = {
  id: string;
  projectId: string;
  agentId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

export type PrivateMessage = {
  id: string;
  threadId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type WorkIntake = {
  event: WorkEvent;
  mentionEvent: WorkEvent;
  recipients: string[];
  requiresAssistant: boolean;
};

export type Stats = {
  ok: boolean;
  uptime: number;
  http: { requests: number; errors: number; durationMs: number };
  projects: ProjectStats[];
};

type ProviderModelView = {
  id: string;
  contextWindow?: number;
  autoCompact?: boolean;
};

type ProviderConfigView = {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  models: ProviderModelView[];
  hasToken: boolean;
  tokenHint: string;
  authToken?: string;
};

type ProjectStats = {
  id: string;
  workflowCount: number;
  pendingGates: number;
  failureRate: number;
  totalCostUsd: number;
};

export type ProviderSettings = {
  baseUrl: string;
  model: string;
  models: string[];
  hasToken: boolean;
  tokenHint: string;
  file: string;
  defaultProviderId: string;
  providers: ProviderConfigView[];
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

let token = readStored('spec_agent_token');
let project = readStored('spec_agent_project');

export function setToken(value: string): void {
  token = value;
  try {
    window.localStorage.setItem('spec_agent_token', value);
  } catch {
    // 隐私模式下 localStorage 可能不可用
  }
}

export function getToken(): string {
  return token;
}

export function setProject(value: string): void {
  project = value;
  try {
    window.localStorage.setItem('spec_agent_project', value);
  } catch {
    // ignore
  }
}

export function getProject(): string {
  return project;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = { ...extra };
  if (token) result.authorization = `Bearer ${token}`;
  if (project) result['x-spec-agent-project'] = project;
  return result;
}

async function toError(response: Response): Promise<ApiError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string; code?: string } }
    | null;
  return new ApiError(
    response.status,
    body?.error?.message ?? `${response.status} ${response.statusText}`,
  );
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: authHeaders() });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

export const api = {
  async createProject(name: string, root?: string): Promise<Project> {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, ...(root ? { root } : {}) })});
    if (!response.ok) throw await toError(response);
    return ((await response.json()) as { project: Project }).project;
  },
  async pickFolder(): Promise<string | null> {
    const response = await fetch('/api/system/pick-folder', {
      method: 'POST',
      headers: authHeaders()});
    if (!response.ok) throw await toError(response);
    return ((await response.json()) as { path: string | null }).path;
  },
  async importProject(
    name: string,
    files: Array<{ path: string; file: File }>,
  ): Promise<Project> {
    const form = new FormData();
    form.set('name', name);
    for (const entry of files) {
      form.append('file', entry.file, entry.path);
    }
    const response = await fetch('/api/projects/import', {
      method: 'POST',
      headers: authHeaders(),
      body: form});
    if (!response.ok) throw await toError(response);
    return ((await response.json()) as { project: Project }).project;
  },
  async archiveProject(id: string): Promise<void> {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders()});
    if (!response.ok) throw await toError(response);
  },
  async saveProvider(input: {
    baseUrl?: string;
    authToken?: string;
    model: string;
    models?: string[];
    clearToken?: boolean;
    defaultProviderId?: string;
    providers?: Array<{
      id: string;
      name: string;
      protocol: 'anthropic' | 'openai';
      baseUrl: string;
      models: Array<{
        id: string;
        contextWindow?: number;
        autoCompact?: boolean;
      }>;
      authToken?: string;
      clearToken?: boolean;
    }>;
  }): Promise<ProviderSettings> {
    const response = await fetch('/api/provider', {
      method: 'PUT',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input)});
    if (!response.ok) throw await toError(response);
    return (await response.json()) as ProviderSettings;
  },
  async saveAgentConfig(agents: AgentConfig[]): Promise<AgentConfig[]> {
    const response = await fetch('/api/agents/config', {
      method: 'PUT',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ agents })});
    if (!response.ok) throw await toError(response);
    return ((await response.json()) as { agents: AgentConfig[] }).agents;
  },
  async createChatProject(
    name: string,
    root?: string,
  ): Promise<ChatProject> {
    const response = await fetch('/api/chat/projects', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name, ...(root ? { root } : {}) })});
    if (!response.ok) throw await toError(response);
    return ((await response.json()) as { project: ChatProject }).project;
  },
  async createWorkGroup(
    projectId: string,
    name: string,
  ): Promise<WorkGroup> {
    const response = await fetch('/api/work/groups', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ projectId, name })});
    if (!response.ok) throw await toError(response);
    return ((await response.json()) as { group: WorkGroup }).group;
  },
  async sendWorkMessage(
    groupId: string,
    content: string,
    mentions: string[] = [],
  ): Promise<WorkIntake> {
    const response = await fetch(
      `/api/work/groups/${encodeURIComponent(groupId)}/messages`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ content, mentions, authorId: 'local-user' })},
    );
    if (!response.ok) throw await toError(response);
    return (await response.json()) as WorkIntake;
  },
  async sendPrivateMessage(input: {
    projectId: string;
    agentId: string;
    content: string;
    targetGroupId?: string;
  }): Promise<{
    thread: PrivateThread;
    messages: PrivateMessage[];
    groupEvent?: WorkEvent;
  }> {
    const response = await fetch(
      `/api/work/private/${encodeURIComponent(input.agentId)}/messages`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(input)},
    );
    if (!response.ok) throw await toError(response);
    return (await response.json()) as {
      thread: PrivateThread;
      messages: PrivateMessage[];
      groupEvent?: WorkEvent;
    };
  },
  async streamPrivateMessage(
    input: {
      projectId: string;
      agentId: string;
      content: string;
    },
    hooks: {
      onDelta?: (text: string) => void;
      onStatus?: (status: string) => void;
      onReasoning?: (text: string) => void;
    } = {},
  ): Promise<{
    thread: PrivateThread;
    messages: PrivateMessage[];
  }> {
    const response = await fetch(
      `/api/work/private/${encodeURIComponent(input.agentId)}/stream`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(input)},
    );
    if (!response.ok) throw await toError(response);
    if (!response.body) throw new Error('浏览器不支持流式响应');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: { thread: PrivateThread; messages: PrivateMessage[] } | null =
      null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        if (dataLines.length > 0) {
          const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
          if (event === 'delta' && typeof data.text === 'string') {
            hooks.onDelta?.(data.text);
          } else if (event === 'status' && typeof data.status === 'string') {
            hooks.onStatus?.(data.status);
          } else if (event === 'reasoning' && typeof data.text === 'string') {
            hooks.onReasoning?.(data.text);
          } else if (event === 'done') {
            result = data as {
              thread: PrivateThread;
              messages: PrivateMessage[];
            };
          } else if (event === 'error') {
            throw new Error(String(data.message ?? '流式请求失败'));
          }
        }
        separator = buffer.indexOf('\n\n');
      }
    }
    if (!result) throw new Error('流式响应没有完成');
    return result;
  },
  async triageWorkMessage(
    groupId: string,
    eventId: string,
    options: { assignee?: string; start?: boolean } = {},
  ): Promise<{ item: WorkItem; assignment: WorkAssignment | null }> {
    const response = await fetch(
      `/api/work/groups/${encodeURIComponent(groupId)}/triage`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          eventId,
          ...(options.assignee ? { assignee: options.assignee } : {}),
          ...(options.start ? { start: true } : {})})},
    );
    if (!response.ok) throw await toError(response);
    return (await response.json()) as {
      item: WorkItem;
      assignment: WorkAssignment | null;
    };
  },
  async assistantTriage(
    groupId: string,
    eventId: string,
  ): Promise<{
    decision: {
      action: string;
      title?: string;
      intent?: string;
      assignee?: string;
      reply: string;
    };
    item: WorkItem | null;
    replyEventId: string;
  }> {
    const response = await fetch(
      `/api/work/groups/${encodeURIComponent(groupId)}/assistant-triage`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ eventId })},
    );
    if (!response.ok) throw await toError(response);
    return (await response.json()) as {
      decision: {
        action: string;
        title?: string;
        intent?: string;
        assignee?: string;
        reply: string;
      };
      item: WorkItem | null;
      replyEventId: string;
    };
  },
  projects: () =>
    get<{ projects: Project[]; defaultProject: string; manageable: boolean }>(
      '/api/projects',
    ),
  agentConfig: () =>
    get<{ agents: AgentConfig[]; path: string; exists: boolean }>(
      '/api/agents/config',
    ),
  chatProjects: () =>
    get<{ projects: ChatProject[] }>('/api/chat/projects'),
  stats: () => get<Stats>('/api/stats'),
  provider: (includeSecrets = false) =>
    get<ProviderSettings>(`/api/provider${includeSecrets ? '?secrets=1' : ''}`),
  agents: () => get<{ agents: Agent[] }>('/api/agents'),
  workGroups: (projectId: string) =>
    get<{ groups: WorkGroup[] }>(
      `/api/work/groups?projectId=${encodeURIComponent(projectId)}`,
    ),
  workEvents: (groupId: string) =>
    get<{ events: WorkEvent[] }>(
      `/api/work/groups/${encodeURIComponent(groupId)}/events`,
    ),
  privateMessages: (projectId: string, agentId: string) =>
    get<{ thread: PrivateThread; messages: PrivateMessage[] }>(
      `/api/work/private/${encodeURIComponent(agentId)}?projectId=${encodeURIComponent(projectId)}`,
    ),
};
