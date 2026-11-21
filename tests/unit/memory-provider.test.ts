import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, type MemoryNodeOutcome, type MemoryProvider } from '@spec-agent/core';
import {
  CompositeMemoryProvider,
  HyMemoryProvider,
  LocalMemoryProvider,
  MemoryOutboxWorker,
  TencentMemoryProvider,
} from '@spec-agent/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function localStore(): Store {
  const root = mkdtempSync(join(tmpdir(), 'spec-agent-memory-provider-'));
  roots.push(root);
  return new Store({ path: join(root, 'spec-agent.db') });
}

describe('MemoryProvider', () => {
  it('本地检索保留 project 与当前 agent 的作用域隔离', async () => {
    const store = localStore();
    store.createMemory({ scope: 'project', content: '组件统一使用 CSS Modules' });
    store.createMemory({ scope: 'agent', agentId: 'fe', content: '组件需要键盘可访问性' });
    store.createMemory({ scope: 'agent', agentId: 'be', content: '组件无关的后端约束' });
    const provider = new LocalMemoryProvider(store);
    const result = await provider.retrieve({
      projectId: 'p1', agentId: 'fe', query: '组件', limit: 6,
    });
    expect(result.memories).toEqual(expect.arrayContaining([
      '组件统一使用 CSS Modules',
      '组件需要键盘可访问性',
    ]));
    expect(result.memories).not.toContain('组件无关的后端约束');
    store.close();
  });

  it('Tencent provider 使用 v3 检索、身份隔离和会话写入', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown>; headers: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body, headers: init?.headers });
      const data = path === '/v3/core/read'
        ? { content: '长期核心记忆' }
        : path === '/v3/scenario/ls'
          ? { entries: [{ path: 'auth.md', summary: '认证场景摘要' }] }
          : path === '/v3/atomic/search'
            ? { items: [{ content: '登录使用 JWT' }] }
            : { accepted_ids: ['m1'] };
      return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = new TencentMemoryProvider({
      baseUrl: 'http://memory.local',
      serviceId: 'instance-1',
      userId: 'user-1',
      apiKey: 'secret',
      fetchImpl,
    });
    const result = await provider.retrieve({
      projectId: 'project-1', agentId: 'fe', taskId: 'task-1', query: '登录',
    });
    expect(result.memories).toEqual(['长期核心记忆', '场景 auth.md：认证场景摘要', '登录使用 JWT']);
    expect(calls.map((call) => call.path)).toEqual([
      '/v3/core/read', '/v3/scenario/ls', '/v3/atomic/search',
    ]);
    expect(calls[2]?.body).toMatchObject({
      team_id: 'project-1', agent_id: 'fe', task_id: 'task-1', user_id: 'user-1',
    });
    expect(calls[2]?.headers).toMatchObject({
      authorization: 'Bearer secret', 'x-tdai-service-id': 'instance-1',
    });

    await provider.ingestConversation({
      projectId: 'project-1', sessionId: 'session-1', agentId: 'project-copilot',
      messages: [
        { role: 'user', content: '项目约束是什么？' },
        { role: 'assistant', content: '登录使用 JWT' },
      ],
    });
    const write = calls.find((call) => call.path === '/v3/conversation/add');
    expect(write?.body).toMatchObject({
      session_id: 'session-1', team_id: 'project-1', agent_id: 'project-copilot',
    });
  });

  it('Hy-Memory provider 使用 search/add 和 metadata', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      const data =
        path === '/api/v1/search'
          ? { memories: { atomic: [{ content: 'Hy 记忆：使用 pnpm' }] } }
          : { accepted_ids: ['m1'] };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = new HyMemoryProvider({
      baseUrl: 'http://127.0.0.1:19527',
      userId: 'u1',
      workspaceId: 'spec-agent',
      branch: 'main',
      fetchImpl,
    });
    const result = await provider.retrieve({
      projectId: 'p1', agentId: 'fe', query: 'pnpm',
    });
    expect(result.memories).toEqual(['Hy 记忆：使用 pnpm']);
    await provider.ingestNodeOutcome({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', nodeId: 'a',
      agentId: 'fe', title: '实现 A', status: 'succeeded', summary: '完成 A',
    });
    expect(calls.map((call) => call.path)).toEqual(['/api/v1/search', '/api/v1/add']);
    expect(calls[0]?.body).toMatchObject({
      user_ids: ['u1'], agent_ids: ['fe'], limit: 6,
    });
    expect(calls[1]?.body).toMatchObject({
      user_id: 'u1',
      agent_id: 'fe',
      session_id: 'node-n1',
      metadata: {
        project_id: 'p1',
        task_id: 't1',
        node_id: 'a',
        workspace_id: 'spec-agent',
        branch: 'main',
      },
    });
  });

  it('memory outbox 成功发送并持久化状态', async () => {
    const store = localStore();
    const ingestNodeOutcome = vi.fn(async () => undefined);
    const provider: MemoryProvider = {
      kind: 'hy-memory',
      retrieve: vi.fn(async () => ({ memories: [] })),
      ingestConversation: vi.fn(async () => undefined),
      ingestTaskResult: vi.fn(async () => undefined),
      ingestNodeOutcome,
    };
    const outcome: MemoryNodeOutcome = {
      taskId: 't1', nodeRunId: 'n1', nodeId: 'a',
      title: '实现 A', status: 'succeeded', summary: '完成 A',
    };
    store.enqueueMemoryOutbox({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', kind: 'node_outcome',
      payload: JSON.stringify(outcome),
    });
    const worker = new MemoryOutboxWorker(store, provider, 'p1');
    await expect(worker.flushOnce()).resolves.toBe(1);
    expect(ingestNodeOutcome).toHaveBeenCalledWith({
      ...outcome, projectId: 'p1',
    });
    expect(store.memoryOutboxStats()).toEqual({ pending: 0, sent: 1, failed: 0 });
    store.close();
  });

  it('memory outbox 失败保留 pending 并退避', async () => {
    const store = localStore();
    const provider: MemoryProvider = {
      kind: 'hy-memory',
      retrieve: vi.fn(async () => ({ memories: [] })),
      ingestConversation: vi.fn(async () => undefined),
      ingestTaskResult: vi.fn(async () => undefined),
      ingestNodeOutcome: vi.fn(async () => { throw new Error('sidecar offline'); }),
    };
    const id = store.enqueueMemoryOutbox({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', kind: 'node_outcome',
      payload: JSON.stringify({
        taskId: 't1', nodeRunId: 'n1', nodeId: 'a', title: 'A',
        status: 'succeeded', summary: 'done',
      }),
    });
    const worker = new MemoryOutboxWorker(store, provider, 'p1');
    await expect(worker.flushOnce()).resolves.toBe(0);
    expect(store.listPendingMemoryOutbox()).toHaveLength(0);
    expect(store.memoryOutboxStats()).toEqual({ pending: 1, sent: 0, failed: 0 });
    const row = store.getMemoryOutbox(id);
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBeTruthy();
    store.close();
  });

  it('Hy-Memory 处理错误、多形状结果和可选字段', async () => {
    expect(
      () => new HyMemoryProvider({ baseUrl: 'ftp://invalid' }),
    ).toThrow(/http/);

    let call = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const path = new URL(String(input)).pathname;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              results: ['字符串记忆', { text: '文本记忆' }, { summary: '摘要记忆' }, null],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (call === 2) {
        return new Response(JSON.stringify({ code: 2, message: 'sidecar error' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (call === 3) {
        return new Response('down', { status: 503 });
      }
      if (path === '/api/v1/add') throw new Error('network down');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new HyMemoryProvider({
      baseUrl: 'http://127.0.0.1:19527/api/v1/',
      userId: 'u1',
      apiKey: 'secret',
      fetchImpl,
    });
    const result = await provider.retrieve({ projectId: 'p1', query: '记忆' });
    expect(result.memories).toEqual(['字符串记忆', '文本记忆', '摘要记忆']);
    await expect(provider.ingestNodeOutcome({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', nodeId: 'a',
      title: 'A', status: 'succeeded', summary: 'done',
    })).rejects.toMatchObject({ code: 'E_MEMORY_REMOTE' });
    await expect(provider.ingestNodeOutcome({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', nodeId: 'a',
      title: 'A', status: 'succeeded', summary: 'done',
    })).rejects.toMatchObject({ code: 'E_MEMORY_REMOTE' });
    await expect(provider.ingestConversation({
      projectId: 'p1', sessionId: 's1', messages: [{ role: 'user', content: 'x' }],
    })).rejects.toMatchObject({ code: 'E_MEMORY_REMOTE' });
    await expect(provider.ingestConversation({
      projectId: 'p1', sessionId: 's1', messages: [],
    })).resolves.toBeUndefined();
    await expect(provider.ingestTaskResult({
      projectId: 'p1', taskId: 't1', title: 'T', status: 'succeeded', summary: '',
    })).resolves.toBeUndefined();
  });

  it('没有 ingestNodeOutcome 的 provider 保留 outbox 并退避', async () => {
    const store = localStore();
    const provider: MemoryProvider = {
      kind: 'local',
      retrieve: vi.fn(async () => ({ memories: [] })),
      ingestConversation: vi.fn(async () => undefined),
      ingestTaskResult: vi.fn(async () => undefined),
    };
    const worker = new MemoryOutboxWorker(store, provider, 'p1', 60_000);
    worker.start();
    worker.start();
    worker.stop();
    worker.stop();
    const id = store.enqueueMemoryOutbox({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', kind: 'node_outcome',
      payload: '{}',
    });
    await expect(worker.flushOnce()).resolves.toBe(0);
    expect(store.getMemoryOutbox(id)?.attempts).toBe(1);
    store.close();
  });

  it('Composite 在没有 node outcome 能力时安全跳过', async () => {
    const store = localStore();
    const local = new LocalMemoryProvider(store);
    const remote: MemoryProvider = {
      kind: 'local',
      retrieve: vi.fn(async () => ({ memories: [] })),
      ingestConversation: vi.fn(async () => undefined),
      ingestTaskResult: vi.fn(async () => undefined),
    };
    const provider = new CompositeMemoryProvider(local, remote);
    await expect(provider.ingestNodeOutcome({
      projectId: 'p1', taskId: 't1', nodeRunId: 'n1', nodeId: 'a',
      title: 'A', status: 'succeeded', summary: 'done',
    })).resolves.toBeUndefined();
    store.close();
  });

  it('远程失败时回退本地，远程写入失败不阻断主流程', async () => {
    const store = localStore();
    store.createMemory({ scope: 'project', content: '本地项目记忆' });
    const local = new LocalMemoryProvider(store);
    const remote: MemoryProvider = {
      kind: 'tencent',
      retrieve: vi.fn(async () => { throw new Error('offline'); }),
      ingestConversation: vi.fn(async () => { throw new Error('offline'); }),
      ingestTaskResult: vi.fn(async () => { throw new Error('offline'); }),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = new CompositeMemoryProvider(local, remote);
    const result = await provider.retrieve({ projectId: 'p1', query: '本地' });
    expect(result.memories).toEqual(['本地项目记忆']);
    await expect(provider.ingestConversation({
      projectId: 'p1', sessionId: 's1', messages: [],
    })).resolves.toBeUndefined();
    await expect(provider.ingestTaskResult({
      projectId: 'p1', taskId: 't1', title: '任务', status: 'succeeded', summary: '完成',
    })).resolves.toBeUndefined();
    store.close();
  });
});
