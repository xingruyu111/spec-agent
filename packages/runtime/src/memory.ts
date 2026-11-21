/** Local SQLite + optional TencentDB Agent Memory / Hy-Memory provider. */

import { AppError } from '@spec-agent/kernel';
import type {
  MemoryConversationInput,
  MemoryNodeOutcome,
  MemoryProvider,
  MemoryQuery,
  MemoryResult,
  MemoryTaskInput,
} from '@spec-agent/core';
import type { Store } from '@spec-agent/core';

export class LocalMemoryProvider implements MemoryProvider {
  readonly kind = 'local' as const;
  constructor(private readonly store: Store) {}

  async retrieve(input: MemoryQuery): Promise<MemoryResult> {
    return {
      memories: this.store.memoryDigest(
        input.agentId ?? null,
        input.query,
        input.limit ?? 6,
      ),
      sources: ['local'],
    };
  }

  // Hive/Spec Agent 本地库已由 ChatService 与任务事件持久化，无需重复写入。
  async ingestConversation(): Promise<void> {}
  async ingestTaskResult(): Promise<void> {}
  async ingestNodeOutcome(): Promise<void> {}
}

export type TencentMemoryOptions = {
  baseUrl: string;
  serviceId: string;
  userId: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class TencentMemoryProvider implements MemoryProvider {
  readonly kind = 'tencent' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TencentMemoryOptions) {
    const parsed = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AppError('E_MEMORY_CONFIG', 'Tencent Memory baseUrl 必须是 http(s)');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async retrieve(input: MemoryQuery): Promise<MemoryResult> {
    const identity = this.identity(input);
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);
    const [core, scenarios, atomic] = await Promise.all([
      this.rpc<{ content?: string | null }>('/v3/core/read', identity),
      this.rpc<{ entries?: Array<{ path?: string; summary?: string }> }>(
        '/v3/scenario/ls',
        identity,
      ),
      input.query.trim()
        ? this.rpc<{ items?: Array<{ content?: string }> }>('/v3/atomic/search', {
            ...identity,
            query: input.query.slice(0, 2048),
            limit,
          })
        : this.rpc<{ items?: Array<{ content?: string }> }>('/v3/atomic/query', {
            ...identity,
            limit,
            offset: 0,
          }),
    ]);
    const memories = [
      ...(core.content?.trim() ? [core.content.trim()] : []),
      ...(scenarios.entries ?? [])
        .filter((entry) => entry.summary?.trim())
        .slice(0, 2)
        .map((entry) => `场景 ${entry.path ?? 'summary'}：${entry.summary!.trim()}`),
      ...(atomic.items ?? [])
        .map((item) => item.content?.trim())
        .filter((content): content is string => Boolean(content)),
    ];
    return {
      memories: unique(memories).slice(0, limit),
      sources: ['tencent:core', 'tencent:scenario', 'tencent:atomic'],
    };
  }

  async ingestConversation(input: MemoryConversationInput): Promise<void> {
    const messages = input.messages
      .filter((message) => message.content.trim())
      .slice(-100)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 8192),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      }));
    if (messages.length === 0) return;
    await this.rpc('/v3/conversation/add', {
      session_id: input.sessionId,
      messages,
      source: 'spec-agent',
      ...this.identity(input),
    });
  }

  async ingestTaskResult(input: MemoryTaskInput): Promise<void> {
    if (!input.summary.trim()) return;
    await this.ingestConversation({
      projectId: input.projectId,
      sessionId: `task-${input.taskId}`,
      agentId: input.agentId,
      taskId: input.taskId,
      userId: input.userId,
      messages: [
        { role: 'user', content: `任务：${input.title}` },
        {
          role: 'assistant',
          content: `任务状态：${input.status}\n${input.summary}`.slice(0, 8192),
        },
      ],
    });
  }

  async ingestNodeOutcome(
    input: MemoryNodeOutcome & { projectId: string },
  ): Promise<void> {
    await this.ingestConversation({
      projectId: input.projectId,
      sessionId: `node-${input.nodeRunId}`,
      agentId: input.agentId,
      taskId: input.taskId,
      messages: [
        { role: 'user', content: `节点：${input.title}` },
        {
          role: 'assistant',
          content: `节点 ${input.nodeId} 状态：${input.status}\n${input.summary}`.slice(
            0,
            8192,
          ),
        },
      ],
    });
  }

  private identity(input: {
    projectId: string;
    agentId?: string | null;
    taskId?: string;
    userId?: string;
  }): Record<string, string> {
    return {
      team_id: input.projectId,
      agent_id: input.agentId || 'project-copilot',
      user_id: input.userId || this.options.userId,
      ...(input.taskId ? { task_id: input.taskId } : {}),
    };
  }

  private async rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tdai-service-id': this.options.serviceId,
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new AppError('E_MEMORY_REMOTE', `Tencent Memory 请求失败：${path}`, {
        cause: error,
      });
    }
    const envelope = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: T;
    } | null;
    if (!response.ok || !envelope || envelope.code !== 0) {
      throw new AppError(
        'E_MEMORY_REMOTE',
        `Tencent Memory ${path}：${envelope?.message ?? `HTTP ${response.status}`}`,
      );
    }
    return envelope.data as T;
  }
}

/** TencentDB Agent Memory 的 HTTP provider（保留原有 /v3 API）。 */
export type HyMemoryOptions = {
  baseUrl: string;
  userId?: string;
  workspaceId?: string;
  branch?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/** Hy-Memory 2.x local HTTP sidecar。scene=working/coding 需要工具轨迹，默认 chat。 */
export class HyMemoryProvider implements MemoryProvider {
  readonly kind = 'hy-memory' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HyMemoryOptions) {
    const parsed = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AppError('E_MEMORY_CONFIG', 'Hy-Memory baseUrl 必须是 http(s)');
    }
    this.baseUrl = options.baseUrl
      .replace(/\/+$/, '')
      .replace(/\/api\/v1$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async retrieve(input: MemoryQuery): Promise<MemoryResult> {
    const userId = input.userId || this.options.userId || 'local-user';
    const data = await this.rpc<Record<string, unknown>>('/api/v1/search', {
      query: input.query.slice(0, 2048),
      user_ids: [userId],
      limit: Math.min(Math.max(input.limit ?? 6, 1), 20),
      ...(input.agentId ? { agent_ids: [input.agentId] } : {}),
    });
    return {
      memories: unique(flattenHyMemories(data)).slice(0, input.limit ?? 6),
      sources: ['hy-memory'],
    };
  }

  async ingestConversation(input: MemoryConversationInput): Promise<void> {
    const messages = input.messages
      .filter((message) => message.content.trim())
      .slice(-100)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 8192),
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      }));
    if (messages.length === 0) return;
    await this.add({
      messages,
      user_id: input.userId || this.options.userId || 'local-user',
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      metadata: {
        project_id: input.projectId,
        ...(input.taskId ? { task_id: input.taskId } : {}),
      },
    });
  }

  async ingestTaskResult(input: MemoryTaskInput): Promise<void> {
    if (!input.summary.trim()) return;
    await this.ingestConversation({
      projectId: input.projectId,
      sessionId: `task-${input.taskId}`,
      agentId: input.agentId,
      taskId: input.taskId,
      userId: input.userId,
      messages: [
        { role: 'user', content: `任务：${input.title}` },
        {
          role: 'assistant',
          content: `任务状态：${input.status}\n${input.summary}`.slice(0, 8192),
        },
      ],
    });
  }

  async ingestNodeOutcome(
    input: MemoryNodeOutcome & { projectId: string },
  ): Promise<void> {
    await this.add({
      messages: [
        { role: 'user', content: `节点：${input.title}` },
        {
          role: 'assistant',
          content: `节点 ${input.nodeId} 状态：${input.status}\n${input.summary}`.slice(
            0,
            8192,
          ),
        },
      ],
      user_id: this.options.userId || 'local-user',
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      session_id: `node-${input.nodeRunId}`,
      metadata: {
        project_id: input.projectId,
        task_id: input.taskId,
        node_id: input.nodeId,
      },
    });
  }

  private async add(body: Record<string, unknown>): Promise<void> {
    const metadata = {
      ...((body.metadata as Record<string, unknown> | undefined) ?? {}),
      ...(this.options.workspaceId ? { workspace_id: this.options.workspaceId } : {}),
      ...(this.options.branch ? { branch: this.options.branch } : {}),
    };
    await this.rpc('/api/v1/add', {
      ...body,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  private async rpc<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey
            ? { authorization: `Bearer ${this.options.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new AppError('E_MEMORY_REMOTE', `Hy-Memory 请求失败：${path}`, {
        cause: error,
      });
    }
    const payload = (await response.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: T;
    } | null;
    if (!response.ok || !payload) {
      throw new AppError(
        'E_MEMORY_REMOTE',
        `Hy-Memory ${path}：HTTP ${response.status}`,
      );
    }
    if (typeof payload.code === 'number' && payload.code !== 0) {
      throw new AppError(
        'E_MEMORY_REMOTE',
        `Hy-Memory ${path}：${payload.message ?? `code ${payload.code}`}`,
      );
    }
    return (payload.data ?? payload) as T;
  }
}

function flattenHyMemories(data: Record<string, unknown>): string[] {
  const raw = data.memories ?? data.results ?? data.items ?? data;
  const values: unknown[] = [];
  if (Array.isArray(raw)) values.push(...raw);
  else if (raw && typeof raw === 'object') {
    for (const value of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) values.push(...value);
    }
  }
  return values
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as Record<string, unknown>;
      const content = record.content ?? record.text ?? record.memory ?? record.summary;
      return typeof content === 'string' ? content.trim() : '';
    })
    .filter(Boolean);
}

/** 本地与远程合并；远程失败只降级，不阻断主流程。 */
export class CompositeMemoryProvider implements MemoryProvider {
  readonly kind = 'composite' as const;
  constructor(
    private readonly local: MemoryProvider,
    private readonly remote: MemoryProvider,
  ) {}

  async retrieve(input: MemoryQuery): Promise<MemoryResult> {
    const local = await this.local.retrieve(input);
    try {
      const remote = await this.remote.retrieve(input);
      return {
        memories: unique([...local.memories, ...remote.memories]).slice(
          0,
          input.limit ?? 6,
        ),
        sources: [...(local.sources ?? []), ...(remote.sources ?? [])],
      };
    } catch (error) {
      warnRemote('retrieve', error);
      return local;
    }
  }

  async ingestConversation(input: MemoryConversationInput): Promise<void> {
    await this.local.ingestConversation(input);
    try {
      await this.remote.ingestConversation(input);
    } catch (error) {
      warnRemote('conversation', error);
    }
  }

  async ingestTaskResult(input: MemoryTaskInput): Promise<void> {
    await this.local.ingestTaskResult(input);
    try {
      await this.remote.ingestTaskResult(input);
    } catch (error) {
      warnRemote('task', error);
    }
  }

  async ingestNodeOutcome(
    input: MemoryNodeOutcome & { projectId: string },
  ): Promise<void> {
    await this.local.ingestNodeOutcome?.(input);
    if (!this.remote.ingestNodeOutcome) return;
    try {
      await this.remote.ingestNodeOutcome(input);
    } catch (error) {
      warnRemote('node-outcome', error);
    }
  }
}

export class MemoryOutboxWorker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: Store,
    private readonly provider: MemoryProvider,
    private readonly projectId: string,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.flushOnce();
    this.timer = setInterval(() => void this.flushOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async flushOnce(): Promise<number> {
    const rows = this.store.listPendingMemoryOutbox(20);
    let sent = 0;
    for (const row of rows) {
      try {
        if (!this.provider.ingestNodeOutcome) {
          throw new AppError('E_MEMORY_REMOTE', '当前 provider 不支持节点 outcome');
        }
        const payload = JSON.parse(row.payload) as MemoryNodeOutcome;
        await this.provider.ingestNodeOutcome({
          ...payload,
          projectId: row.projectId,
        });
        this.store.markMemoryOutboxSent(row.id);
        sent += 1;
      } catch (error) {
        const delay = Math.min(60_000 * 2 ** Math.min(row.attempts, 5), 3_600_000);
        const next = new Date(this.store.clock.now() + delay).toISOString();
        this.store.markMemoryOutboxFailed(
          row.id,
          error instanceof Error ? error.message : String(error),
          next,
        );
      }
    }
    return sent;
  }
}

export function createMemoryProvider(input: {
  store: Store;
  projectId: string;
  remote?: TencentMemoryOptions;
  hy?: HyMemoryOptions;
}): MemoryProvider {
  const local = new LocalMemoryProvider(input.store);
  if (input.hy) {
    return new CompositeMemoryProvider(local, new HyMemoryProvider(input.hy));
  }
  if (!input.remote) return local;
  return new CompositeMemoryProvider(
    local,
    new TencentMemoryProvider(input.remote),
  );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function warnRemote(operation: string, error: unknown): void {
  console.warn(
    `Tencent Memory ${operation} 降级为本地记忆：`,
    error instanceof Error ? error.message : error,
  );
}
