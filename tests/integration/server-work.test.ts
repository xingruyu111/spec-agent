import { mkdtempSync, rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import { startServer, type RunningServer } from '@spec-agent/server';
import type { ChatEngine } from '../../apps/server/src/dsh/dsh-chat.js';

let root = '';
let server: RunningServer;

const provider: ProviderConfig = {
  id: 'fake',
  protocol: 'anthropic',
  baseUrl: 'https://example.invalid',
  authToken: 'secret',
  models: { fake: {} },
};
const runtime: AgentRuntime = {
  id: 'fake',
  async run(input) {
    if (input.task.includes('慢任务')) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (input.task.includes('总是失败')) {
      throw new Error('故意失败');
    }
    input.onToolEvent?.({
      phase: 'call',
      toolUseId: 'tool-1',
      tool: 'Read',
      inputPreview: 'README.md',
    });
    if (input.systemPrompt.includes('拆成可执行的 Assignment DAG')) {
      return {
        outputs: [],
        text: JSON.stringify({
          assignments: [
            { agentId: 'assistant', dependsOn: [] },
            { agentId: 'assistant', dependsOn: [0] },
          ],
        }),
        transcriptRef: 'fake-planner',
        usage: { usd: 0 },
        stopReason: 'finished',
      };
    }
    if (input.systemPrompt.includes('正在和用户私聊')) {
      return {
        outputs: [],
        text: 'fake-private-answer：最近完成了 README 检查。',
        transcriptRef: 'fake-private',
        usage: { usd: 0 },
        stopReason: 'finished',
      };
    }
    if (input.systemPrompt.includes('项目群聊助理')) {
      return {
        outputs: [],
        text: '我会处理。',
        transcriptRef: 'fake-triage',
        usage: { usd: 0 },
        stopReason: 'finished',
      };
    }
    return {
      outputs: [],
      text: 'ok',
      transcriptRef: 'fake',
      usage: { usd: 0 },
      stopReason: 'finished',
    };
  },
};
const engine: ChatEngine = {
  async run() {
    return { sessionId: 'fake', text: 'ok' };
  },
  async close() {},
};

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'spec-agent-work-api-'));
  server = await startServer({
    root,
    port: 0,
    webDist: join(root, 'missing-web'),
    providerFile: join(root, 'provider.json'),
    provider,
    model: 'fake',
    agentRuntime: runtime,
    chatEngine: engine,
    autoMemory: false,
  });
});

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('work API', () => {
  it('群聊、@ 路由、Work Item、Assignment 报告闭环', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '工作项项目' }),
      },
    );
    const projectId = project.body.project.id;

    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        name: '#前端',
        members: [
          { type: 'user', id: 'local-user' },
          { type: 'agent', id: 'assistant' },
          { type: 'agent', id: 'fe' },
        ],
      }),
    });
    expect(group.status).toBe(201);
    const groupId = group.body.group.id;

    const message = await request<{
      event: { id: string };
      recipients: string[];
      requiresAssistant: boolean;
    }>(`/api/work/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '按钮改成蓝色',
        authorId: 'local-user',
        mentions: ['fe'],
      }),
    });
    expect(message.status).toBe(201);
    expect(message.body.recipients).toEqual(['fe']);
    expect(message.body.requiresAssistant).toBe(false);

    const opened = await request<{
      item: { id: string; title: string };
      assignment: { id: string; state: string };
    }>('/api/work/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId,
        eventId: message.body.event.id,
        title: '按钮改为蓝色',
        requestedById: 'local-user',
        assignee: 'fe',
      }),
    });
    expect(opened.status).toBe(201);
    expect(opened.body.assignment.state).toBe('queued');

    const started = await request<{ assignment: { state: string } }>(
      `/api/work/assignments/${opened.body.assignment.id}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1' }),
      },
    );
    expect(started.body.assignment.state).toBe('running');

    const reported = await request<{
      workItem: { state: string };
      event: { type: string; payload: { mention: string } };
    }>(`/api/work/assignments/${opened.body.assignment.id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'done',
        summary: '改好了',
        artifacts: [{ path: 'web/button.css' }],
      }),
    });
    expect(reported.body.workItem.state).toBe('done');
    expect(reported.body.event.type).toBe('assignment.reported');
    expect(reported.body.event.payload.mention).toBe('local-user');

    const detail = await request<{
      item: { state: string };
      assignments: Array<{ state: string; reports: unknown[] }>;
    }>(`/api/work/items/${opened.body.item.id}`);
    expect(detail.body.item.state).toBe('done');
    expect(detail.body.assignments[0]?.reports).toHaveLength(1);

    const events = await request<{ events: unknown[] }>(
      `/api/work/groups/${groupId}/events`,
    );
    expect(events.body.events.length).toBeGreaterThanOrEqual(4);
  });

  it('助理 triage、接受、分派、开始、完成', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Triage 项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#triage' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '检查登录流程' }),
      },
    );

    const triaged = await request<{
      item: { id: string; state: string; title: string };
    }>(`/api/work/groups/${groupId}/triage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: message.body.event.id }),
    });
    expect(triaged.status).toBe(201);
    expect(triaged.body.item.state).toBe('inbox');
    expect(triaged.body.item.title).toBe('检查登录流程');

    const accepted = await request<{ item: { state: string } }>(
      `/api/work/items/${triaged.body.item.id}/state`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'triaged' }),
      },
    );
    expect(accepted.body.item.state).toBe('triaged');

    const assigned = await request<{
      assignment: { id: string; state: string };
    }>(`/api/work/items/${triaged.body.item.id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'assistant' }),
    });
    expect(assigned.body.assignment.state).toBe('queued');

    await request(`/api/work/assignments/${assigned.body.assignment.id}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const reported = await request<{ workItem: { state: string } }>(
      `/api/work/assignments/${assigned.body.assignment.id}/report`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'done', summary: '检查完成' }),
      },
    );
    expect(reported.body.workItem.state).toBe('done');
  });

  it('execute 异步运行 AgentRuntime 并写回 done report', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '执行器项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#exec' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '执行一个任务' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const assigned = await request<{ assignment: { id: string } }>(
      `/api/work/items/${triaged.body.item.id}/assign`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'assistant' }),
      },
    );
    const executed = await request<{ assignment: { state: string } }>(
      `/api/work/assignments/${assigned.body.assignment.id}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(executed.status).toBe(202);
    expect(executed.body.assignment.state).toBe('running');

    let detail: {
      item: { state: string };
      assignments: Array<{ state: string; reports: Array<{ summary: string }> }>;
    } = { item: { state: '' }, assignments: [] };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request<typeof detail>(
        `/api/work/items/${triaged.body.item.id}`,
      );
      detail = response.body;
      if (detail.item.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(detail.item.state).toBe('done');
    expect(detail.assignments[0]?.reports[0]?.summary).toBe('ok');

    const events = await request<{
      events: Array<{ type: string; payload: { tool?: string } }>;
    }>(`/api/work/groups/${groupId}/events`);
    expect(
      events.body.events.some(
        (event) =>
          event.type === 'assignment.progress' && event.payload.tool === 'Read',
      ),
    ).toBe(true);
  });

  it('assistant-triage 无工具调用时回复文本', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'LLM Triage 项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#llm-triage' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '帮我把登录页改成邮箱登录' }),
      },
    );
    const triaged = await request<{
      decision: { action: string; reply: string };
      item: { id: string; title: string; state: string } | null;
      replyEventId: string;
    }>(`/api/work/groups/${groupId}/assistant-triage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: message.body.event.id }),
    });
    expect(triaged.status).toBe(200);
    expect(triaged.body.decision.action).toBe('reply');
    expect(triaged.body.decision.reply).toContain('我会处理');
    expect(triaged.body.item).toBeNull();

    const events = await request<{
      events: Array<{ type: string; actorId: string; payload: { assistant?: boolean } }>;
    }>(`/api/work/groups/${groupId}/events`);
    expect(
      events.body.events.some(
        (event) => event.actorId === 'assistant' && event.payload.assistant,
      ),
    ).toBe(true);
  });

  it('私聊查询执行记录并可把需求提到群聊', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '私聊项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#private' }),
    });
    const groupId = group.body.group.id;

    const asked = await request<{
      messages: Array<{ actorType: string; content: string }>;
    }>(
      `/api/work/private/assistant/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, content: '你做了什么？' }),
      },
    );
    expect(asked.status).toBe(201);
    expect(asked.body.messages).toHaveLength(2);
    expect(asked.body.messages[0]?.actorType).toBe('user');
    expect(asked.body.messages[1]?.content).toContain('fake-private-answer');

    const forwarded = await request<{
      messages: Array<{ content: string }>;
      groupEvent: { id: string };
    }>('/api/work/private/assistant/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        content: '把按钮改成蓝色',
        targetGroupId: groupId,
      }),
    });
    expect(forwarded.status).toBe(201);
    expect(forwarded.body.messages.at(-1)?.content).toContain('#private');
    expect(forwarded.body.groupEvent.id).toBeTruthy();

    let assistantReply = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const events = await request<{
        events: Array<{ actorId: string; payload: { assistant?: boolean } }>;
      }>(`/api/work/groups/${groupId}/events`);
      assistantReply = events.body.events.some(
        (event) => event.actorId === 'assistant' && event.payload.assistant,
      );
      if (assistantReply) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(assistantReply).toBe(true);
  });

  it('记忆 API：写入、查询、supersede 和删除', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '记忆项目' }),
      },
    );
    const projectId = project.body.project.id;
    const created = await request<{
      memory: { id: string; content: string };
    }>('/api/work/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        scopeType: 'org',
        scopeId: 'org',
        content: '组织统一使用 pnpm',
        source: 'manual-1',
      }),
    });
    expect(created.status).toBe(201);

    const edited = await request<{ memory: { content: string } }>(
      `/api/work/memories/${created.body.memory.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          content: '组织统一使用 pnpm 10',
        }),
      },
    );
    expect(edited.body.memory.content).toBe('组织统一使用 pnpm 10');

    const conflict = await request<{ error: { code: string } }>(
      `/api/work/memories/${created.body.memory.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          content: '冲突写入',
          expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
        }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('E_WORK_MEMORY_CONFLICT');

    const versions = await request<{
      versions: Array<{ id: string; content: string }>;
    }>(
      `/api/work/memories/${created.body.memory.id}/versions?projectId=${projectId}`,
    );
    expect(versions.body.versions[0]?.content).toBe('组织统一使用 pnpm');

    const diff = await request<{
      before: string;
      after: string;
      lines: Array<{ type: string }>;
    }>(
      `/api/work/memories/${created.body.memory.id}/versions/${versions.body
        .versions[0]!.id}/diff?projectId=${projectId}`,
    );
    expect(diff.body.before).toBe('组织统一使用 pnpm');
    expect(diff.body.after).toBe('组织统一使用 pnpm 10');
    expect(diff.body.lines.some((line) => line.type === 'add')).toBe(true);
    expect(diff.body.lines.some((line) => line.type === 'remove')).toBe(true);

    const restored = await request<{ memory: { content: string } }>(
      `/api/work/memories/${created.body.memory.id}/versions/${versions.body
        .versions[0]!.id}/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    );
    expect(restored.body.memory.content).toBe('组织统一使用 pnpm');

    const found = await request<{
      memories: Array<{ content: string }>;
    }>(
      `/api/work/memories?projectId=${projectId}&query=${encodeURIComponent(
        'pnpm',
      )}`,
    );
    expect(found.body.memories[0]?.content).toContain('pnpm');

    const replaced = await request<{ memory: { id: string } }>(
      '/api/work/memories',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          scopeType: 'org',
          scopeId: 'org',
          content: '组织统一使用 pnpm 和 Node 24',
          source: 'manual-2',
          supersedes: [created.body.memory.id],
        }),
      },
    );
    const after = await request<{
      memories: Array<{ content: string }>;
    }>(
      `/api/work/memories?projectId=${projectId}&query=${encodeURIComponent(
        'pnpm',
      )}`,
    );
    expect(after.body.memories[0]?.content).toContain('Node 24');

    const removed = await request<{ deleted: boolean }>(
      `/api/work/memories/${replaced.body.memory.id}?projectId=${projectId}`,
      { method: 'DELETE' },
    );
    expect(removed.body.deleted).toBe(true);

    await request('/api/work/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        scopeType: 'execution',
        scopeId: 'asg-expired',
        content: '过期记忆',
        source: 'expired',
        expiresAt: '2000-01-01T00:00:00.000Z',
      }),
    });
    const cleaned = await request<{ deleted: number }>(
      '/api/work/memories/cleanup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      },
    );
    expect(cleaned.body.deleted).toBeGreaterThanOrEqual(1);
  });

  it('Assignment 依赖未完成时拒绝执行，完成后可执行', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '依赖项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#deps' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '先设计再实现' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const first = await request<{ assignment: { id: string } }>(
      `/api/work/items/${triaged.body.item.id}/assign`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'assistant' }),
      },
    );
    const second = await request<{
      assignment: { id: string; dependsOn: string[] };
    }>(`/api/work/items/${triaged.body.item.id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'assistant',
        dependsOn: [first.body.assignment.id],
      }),
    });
    expect(second.body.assignment.dependsOn).toEqual([
      first.body.assignment.id,
    ]);

    const blocked = await request<{ error: { code: string } }>(
      `/api/work/assignments/${second.body.assignment.id}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('E_WORK_DEPENDENCY');

    await request(`/api/work/assignments/${first.body.assignment.id}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const detail = await request<{
        assignments: Array<{ id: string; state: string }>;
      }>(`/api/work/items/${triaged.body.item.id}`);
      const done = detail.body.assignments.find(
        (assignment) => assignment.id === first.body.assignment.id,
      );
      if (done?.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let autoState = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const detail = await request<{
        assignments: Array<{ id: string; state: string }>;
      }>(`/api/work/items/${triaged.body.item.id}`);
      const secondAssignment = detail.body.assignments.find(
        (assignment) => assignment.id === second.body.assignment.id,
      );
      autoState = secondAssignment?.state ?? '';
      if (autoState === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(autoState).toBe('done');
  });

  it('Assignment 可取消并重试', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '取消项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#cancel' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '会被取消的任务' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const assigned = await request<{ assignment: { id: string } }>(
      `/api/work/items/${triaged.body.item.id}/assign`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'assistant' }),
      },
    );
    const cancelled = await request<{ assignment: { state: string } }>(
      `/api/work/assignments/${assigned.body.assignment.id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(cancelled.body.assignment.state).toBe('cancelled');

    const retried = await request<{ assignment: { state: string } }>(
      `/api/work/assignments/${assigned.body.assignment.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(retried.body.assignment.state).toBe('queued');

    const executed = await request<{ assignment: { state: string } }>(
      `/api/work/assignments/${assigned.body.assignment.id}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(executed.status).toBe(202);
  });

  it('自动拆解 Work Item 为带依赖的 Assignment DAG', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '规划项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#plan' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '先调查再实现' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const preview = await request<{
      planned: Array<{ agentId: string; dependsOn: number[] }>;
      fallback: boolean;
    }>(`/api/work/items/${triaged.body.item.id}/plan/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(preview.status).toBe(200);
    expect(preview.body.fallback).toBe(false);
    expect(preview.body.planned).toHaveLength(2);

    const before = await request<{ assignments: unknown[] }>(
      `/api/work/items/${triaged.body.item.id}`,
    );
    expect(before.body.assignments).toHaveLength(0);

    const applied = await request<{
      assignments: Array<{ id: string; dependsOn: string[] }>;
      fallback: boolean;
      started: string[];
    }>(`/api/work/items/${triaged.body.item.id}/plan/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planned: preview.body.planned }),
    });
    expect(applied.status).toBe(201);
    expect(applied.body.assignments).toHaveLength(2);
    expect(applied.body.started).toHaveLength(1);
    expect(applied.body.assignments[1]?.dependsOn).toEqual([
      applied.body.assignments[0]?.id,
    ]);

    const detail = await request<{
      assignments: Array<{ dependsOn: string[] }>;
    }>(`/api/work/items/${triaged.body.item.id}`);
    expect(detail.body.assignments).toHaveLength(2);
    expect(detail.body.assignments[1]?.dependsOn).toHaveLength(1);
  });

  it('GitHub 事件入口幂等，并自动创建 Work Item', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '事件源项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#github' }),
    });
    const groupId = group.body.group.id;
    const created = await request<{
      duplicate: boolean;
      messageEvent: { id: string };
    }>('/api/work/sources/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        groupId,
        externalId: 'issue-1',
        title: '登录页报错',
        body: '点击登录后白屏',
        url: 'https://github.com/acme/app/issues/1',
      }),
    });
    expect(created.status).toBe(202);
    expect(created.body.duplicate).toBe(false);

    let itemFound = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listed = await request<{
        items: Array<{ groupId: string | null }>;
      }>(`/api/work/items?projectId=${projectId}`);
      itemFound = listed.body.items.some(
        (candidate) => candidate.groupId === groupId,
      );
      if (itemFound) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(itemFound).toBe(true);

    const items = await request<{
      items: Array<{ id: string; groupId: string | null }>;
    }>(`/api/work/items?projectId=${projectId}`);
    const item = items.body.items.find(
      (candidate) => candidate.groupId === groupId,
    );
    expect(item).toBeTruthy();
    const assigned = await request<{ assignment: { id: string } }>(
      `/api/work/items/${item!.id}/assign`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'assistant' }),
      },
    );
    await request(`/api/work/assignments/${assigned.body.assignment.id}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await request<{
        assignments: Array<{ state: string }>;
      }>(`/api/work/items/${item!.id}`);
      if (detail.body.assignments[0]?.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const outbox = await request<{
      outbox: Array<{
        id: string;
        source: string;
        externalId: string;
        status: string;
        payload: { body?: string; url?: string };
      }>;
    }>(`/api/work/outbox?projectId=${projectId}`);
    expect(outbox.body.outbox).toHaveLength(1);
    expect(outbox.body.outbox[0]?.source).toBe('github');
    expect(outbox.body.outbox[0]?.externalId).toBe('issue-1');
    expect(outbox.body.outbox[0]?.payload.body).toContain('已完成');
    expect(outbox.body.outbox[0]?.payload.url).toBe(
      'https://github.com/acme/app/issues/1',
    );

    const sent = await request<{ outbox: { status: string } }>(
      `/api/work/outbox/${outbox.body.outbox[0]!.id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'sent' }),
      },
    );
    expect(sent.body.outbox.status).toBe('sent');

    const audit = await fetch(
      `${server.url}/api/work/outbox/audit.csv?projectId=${projectId}`,
      { headers: { 'x-spec-agent-project': 'default' } },
    );
    expect(audit.status).toBe(200);
    expect(await audit.text()).toContain(
      '"createdAt","source","externalId"',
    );

    const duplicate = await request<{ duplicate: boolean }>(
      '/api/work/sources/github',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          groupId,
          externalId: 'issue-1',
          title: '登录页报错',
        }),
      },
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
  });

  it('配置 secret 后校验 GitHub Webhook 签名', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '签名项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#signed' }),
    });
    const groupId = group.body.group.id;
    const payload = JSON.stringify({
      projectId,
      groupId,
      externalId: 'signed-1',
      title: '签名事件',
    });
    const secret = 'integration-secret';
    process.env.SPEC_AGENT_GITHUB_WEBHOOK_SECRET = secret;
    try {
      const signature = `sha256=${createHmac('sha256', secret)
        .update(payload)
        .digest('hex')}`;
      const accepted = await request<{ duplicate: boolean }>(
        '/api/work/sources/github',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signature,
          },
          body: payload,
        },
      );
      expect(accepted.status).toBe(202);
      expect(accepted.body.duplicate).toBe(false);

      const rejected = await request<{ error: { code: string } }>(
        '/api/work/sources/github',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': 'sha256=bad',
          },
          body: payload,
        },
      );
      expect(rejected.status).toBe(401);
      expect(rejected.body.error.code).toBe('E_WORK_SOURCE_SIGNATURE');

      const pingBody = JSON.stringify({ zen: 'signed ping' });
      const pingSignature = `sha256=${createHmac('sha256', secret)
        .update(pingBody)
        .digest('hex')}`;
      const signedPing = await request<{ pong: boolean }>(
        '/api/github/webhook',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'ping',
            'x-hub-signature-256': pingSignature,
          },
          body: pingBody,
        },
      );
      expect(signedPing.status).toBe(200);
      expect(signedPing.body.pong).toBe(true);

      const unsignedPing = await request<{ error: { code: string } }>(
        '/api/github/webhook',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'ping',
          },
          body: pingBody,
        },
      );
      expect(unsignedPing.status).toBe(401);
      expect(unsignedPing.body.error.code).toBe('E_WORK_SOURCE_SIGNATURE');
    } finally {
      delete process.env.SPEC_AGENT_GITHUB_WEBHOOK_SECRET;
    }
  });

  it('超过最大重试次数进入死信', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '死信项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#dead' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '总是失败的任务' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const assigned = await request<{
      assignment: { id: string; maxAttempts: number };
    }>(`/api/work/items/${triaged.body.item.id}/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'assistant' }),
    });
    const assignmentId = assigned.body.assignment.id;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const executed = await request<{ assignment: { attempts: number } }>(
        `/api/work/assignments/${assignmentId}/execute`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(executed.status).toBe(202);
      for (let poll = 0; poll < 30; poll += 1) {
        const detail = await request<{
          assignments: Array<{ id: string; state: string; attempts: number }>;
        }>(`/api/work/items/${triaged.body.item.id}`);
        const current = detail.body.assignments.find(
          (item) => item.id === assignmentId,
        );
        if (current?.state === 'blocked') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const dead = await request<{ deadLetters: Array<{ id: string }> }>(
      `/api/work/dead-letters?projectId=${projectId}`,
    );
    expect(dead.body.deadLetters.some((item) => item.id === assignmentId)).toBe(
      true,
    );

    const overLimit = await request<{ error: { message: string } }>(
      `/api/work/assignments/${assignmentId}/execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(overLimit.status).toBe(400);
    expect(overLimit.body.error.message).toContain('死信');

    const retry = await request<{ error: { message: string } }>(
      `/api/work/assignments/${assignmentId}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(retry.status).toBe(400);

    const requeued = await request<{
      assignment: { state: string; attempts: number; maxAttempts: number };
    }>(`/api/work/assignments/${assignmentId}/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxAttempts: 5 }),
    });
    expect(requeued.status).toBe(200);
    expect(requeued.body.assignment.state).toBe('queued');
    expect(requeued.body.assignment.attempts).toBe(0);
    expect(requeued.body.assignment.maxAttempts).toBe(5);

    const afterRequeue = await request<{ deadLetters: Array<{ id: string }> }>(
      `/api/work/dead-letters?projectId=${projectId}`,
    );
    expect(
      afterRequeue.body.deadLetters.some((item) => item.id === assignmentId),
    ).toBe(false);
  });

  it('新增记忆前检测相似冲突并可替换', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '冲突检测项目' }),
      },
    );
    const projectId = project.body.project.id;
    const old = await request<{ memory: { id: string } }>(
      '/api/work/memories',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          scopeType: 'project',
          scopeId: projectId,
          content: '项目代号是 BLUE-42',
          source: 'old',
        }),
      },
    );
    const conflicts = await request<{
      conflicts: Array<{ memory: { id: string }; score: number }>;
    }>('/api/work/memories/conflicts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        scopeType: 'project',
        scopeId: projectId,
        content: '项目代号是 GREEN-7',
      }),
    });
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.conflicts[0]?.memory.id).toBe(old.body.memory.id);

    await request('/api/work/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        scopeType: 'project',
        scopeId: projectId,
        content: '项目代号是 GREEN-7',
        source: 'new',
        autoResolveConflicts: true,
      }),
    });
    const remaining = await request<{ conflicts: unknown[] }>(
      '/api/work/memories/conflicts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          scopeType: 'project',
          scopeId: projectId,
          content: '项目代号是 GREEN-7',
        }),
      },
    );
    expect(remaining.body.conflicts).toHaveLength(0);
    const found = await request<{
      memories: Array<{ content: string }>;
    }>(
      `/api/work/memories?projectId=${projectId}&query=${encodeURIComponent(
        '项目代号',
      )}`,
    );
    expect(found.body.memories[0]?.content).toContain('GREEN-7');
    expect(
      found.body.memories.some((memory) => memory.content.includes('BLUE-42')),
    ).toBe(false);
  });

  it('单 Agent 并发上限阻止第二个任务，完成后自动接续', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '并发项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#concurrency' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '慢任务并发测试' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const first = await request<{ assignment: { id: string } }>(
      `/api/work/items/${triaged.body.item.id}/assign`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'assistant' }),
      },
    );
    const second = await request<{ assignment: { id: string } }>(
      `/api/work/items/${triaged.body.item.id}/assign`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'assistant' }),
      },
    );
    process.env.SPEC_AGENT_MAX_AGENT_CONCURRENCY = '1';
    try {
      const firstRun = await request<{ assignment: { state: string } }>(
        `/api/work/assignments/${first.body.assignment.id}/execute`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(firstRun.status).toBe(202);

      const blocked = await request<{ error: { message: string } }>(
        `/api/work/assignments/${second.body.assignment.id}/execute`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.message).toContain('并发已满');
    } finally {
      delete process.env.SPEC_AGENT_MAX_AGENT_CONCURRENCY;
    }

    let states = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const detail = await request<{
        assignments: Array<{ id: string; state: string }>;
      }>(`/api/work/items/${triaged.body.item.id}`);
      states = detail.body.assignments.map((item) => item.state).join(',');
      if (states === 'done,done') break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect(states).toBe('done,done');
  });

  it('私聊 SSE 返回 done 事件', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '流式项目' }),
      },
    );
    const projectId = project.body.project.id;
    const response = await fetch(
      `${server.url}/api/work/private/assistant/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          content: '在吗',
          userId: 'local-user',
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: status');
    expect(text).toContain('event: done');
  });

  it('跨 Work Item 的排队任务在 Agent 释放后自动接续', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '跨项目队列' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#global-queue' }),
    });
    const groupId = group.body.group.id;
    const createAssignment = async (content: string) => {
      const message = await request<{ event: { id: string } }>(
        `/api/work/groups/${groupId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        },
      );
      const triaged = await request<{ item: { id: string } }>(
        `/api/work/groups/${groupId}/triage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: message.body.event.id }),
        },
      );
      const assigned = await request<{ assignment: { id: string } }>(
        `/api/work/items/${triaged.body.item.id}/assign`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: 'assistant' }),
        },
      );
      return {
        itemId: triaged.body.item.id,
        assignmentId: assigned.body.assignment.id,
      };
    };
    const first = await createAssignment('慢任务 A');
    const second = await createAssignment('慢任务 B');
    process.env.SPEC_AGENT_MAX_AGENT_CONCURRENCY = '1';
    try {
      const firstRun = await request<{ assignment: { state: string } }>(
        `/api/work/assignments/${first.assignmentId}/execute`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(firstRun.status).toBe(202);
      const secondBlocked = await request<{ error: { message: string } }>(
        `/api/work/assignments/${second.assignmentId}/execute`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      expect(secondBlocked.status).toBe(400);
    } finally {
      delete process.env.SPEC_AGENT_MAX_AGENT_CONCURRENCY;
    }

    let firstState = '';
    let secondState = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const firstDetail = await request<{
        assignments: Array<{ id: string; state: string }>;
      }>(`/api/work/items/${first.itemId}`);
      const secondDetail = await request<{
        assignments: Array<{ id: string; state: string }>;
      }>(`/api/work/items/${second.itemId}`);
      firstState = firstDetail.body.assignments[0]?.state ?? '';
      secondState = secondDetail.body.assignments[0]?.state ?? '';
      if (firstState === 'done' && secondState === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(firstState).toBe('done');
    expect(secondState).toBe('done');
  });

  it('原生 GitHub issue webhook 通过 query 映射项目/群聊', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '原生 Webhook' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#native' }),
    });
    const groupId = group.body.group.id;
    const payload = {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      issue: {
        id: 11,
        number: 42,
        title: '原生登录页报错',
        body: '点击登录后白屏',
        html_url: 'https://github.com/acme/app/issues/42',
        updated_at: '2026-11-18T10:00:00Z',
      },
    };
    const created = await request<{ duplicate: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    expect(created.status).toBe(202);
    expect(created.body.duplicate).toBe(false);

    const ignored = await request<{ ignored: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, action: 'closed' }),
      },
    );
    expect(ignored.status).toBe(202);
    expect(ignored.body.ignored).toBe(true);

    let message = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const events = await request<{
        events: Array<{ payload: { content?: string } }>;
      }>(`/api/work/groups/${groupId}/events`);
      message =
        events.body.events.find((event) =>
          String(event.payload.content ?? '').includes('原生登录页报错'),
        )?.payload.content ?? '';
      if (message) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(message).toContain('原生登录页报错');

    const duplicate = await request<{ duplicate: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
  });

  it('项目级 source 规则覆盖全局 action 白名单', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '规则项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#rules' }),
    });
    const groupId = group.body.group.id;
    const rule = await request<{ rule: { actions: string[] } }>(
      '/api/work/source-rules',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          groupId,
          source: 'github',
          actions: ['closed'],
        }),
      },
    );
    expect(rule.body.rule.actions).toEqual(['closed']);

    const payload = {
      repository: { full_name: 'acme/app' },
      issue: {
        id: 201,
        number: 9,
        title: '规则测试 issue',
        html_url: 'https://github.com/acme/app/issues/9',
        updated_at: '2026-11-18T14:00:00Z',
      },
    };
    const opened = await request<{ ignored: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, action: 'opened' }),
      },
    );
    expect(opened.body.ignored).toBe(true);

    const closed = await request<{ ignored?: boolean; duplicate: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, action: 'closed' }),
      },
    );
    expect(closed.body.ignored).not.toBe(true);
    expect(closed.body.duplicate).toBe(false);
  });

  it('source 规则按 label 和作者过滤', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '标签规则' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#labels' }),
    });
    const groupId = group.body.group.id;
    await request('/api/work/source-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        groupId,
        source: 'github',
        actions: ['opened'],
        labels: ['bug'],
        authors: ['octocat'],
      }),
    });
    const payload = {
      action: 'opened',
      repository: { full_name: 'acme/app' },
      issue: {
        id: 501,
        number: 21,
        title: '标签规则 issue',
        html_url: 'https://github.com/acme/app/issues/21',
        updated_at: '2026-11-18T16:00:00Z',
        labels: [{ name: 'feature' }],
        user: { login: 'octocat' },
      },
    };
    const noLabel = await request<{ ignored: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    expect(noLabel.body.ignored).toBe(true);

    const accepted = await request<{ ignored?: boolean; duplicate: boolean }>(
      `/api/work/sources/github?projectId=${projectId}&groupId=${groupId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          issue: { ...payload.issue, labels: [{ name: 'bug' }] },
        }),
      },
    );
    expect(accepted.body.ignored).not.toBe(true);
    expect(accepted.body.duplicate).toBe(false);
  });

  it('Work Item 评论写入并进入事件流', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '评论项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#comments' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '评论测试需求' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const itemId = triaged.body.item.id;
    const added = await request<{ content: string; authorId: string }>(
      `/api/work/items/${itemId}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '验收标准：桌面端和移动端都要正常' }),
      },
    );
    expect(added.status).toBe(201);
    expect(added.body.authorId).toBe('local-user');
    const listed = await request<{
      comments: Array<{ id: string; content: string }>;
    }>(`/api/work/items/${itemId}/comments`);
    expect(listed.body.comments).toHaveLength(1);
    expect(listed.body.comments[0]?.content).toContain('验收标准');

    const updated = await request<{ content: string }>(
      `/api/work/items/${itemId}/comments/${listed.body.comments[0]!.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '更新后的验收标准' }),
      },
    );
    expect(updated.body.content).toBe('更新后的验收标准');
    await request(
      `/api/work/items/${itemId}/comments/${listed.body.comments[0]!.id}`,
      { method: 'DELETE', headers: {} },
    );
    const afterDelete = await request<{ comments: unknown[] }>(
      `/api/work/items/${itemId}/comments`,
    );
    expect(afterDelete.body.comments).toHaveLength(0);

    const events = await request<{
      events: Array<{ type: string }>;
    }>(`/api/work/groups/${groupId}/events`);
    expect(events.body.events.some((event) => event.type === 'workitem.commented'))
      .toBe(true);
    expect(
      events.body.events.some(
        (event) => event.type === 'workitem.comment_updated',
      ),
    ).toBe(true);
    expect(
      events.body.events.some(
        (event) => event.type === 'workitem.comment_deleted',
      ),
    ).toBe(true);
  });

  it('评论可同时创建 Assignment 并自动执行', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '评论派单' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#comment-assign' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '评论派单测试' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const itemId = triaged.body.item.id;
    const added = await request<{
      comment: { content: string };
      assignment: { id: string; agentId: string };
    }>(`/api/work/items/${itemId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '请前端补充测试',
        agentId: 'fe',
      }),
    });
    expect(added.status).toBe(201);
    expect(added.body.assignment.id).toMatch(/^asg-/);
    expect(added.body.assignment.agentId).toBe('fe');

    const mentioned = await request<{
      assignment: { id: string; agentId: string };
    }>(`/api/work/items/${itemId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@fe 继续补充', agentId: '' }),
    });
    expect(mentioned.status).toBe(201);
    expect(mentioned.body.assignment.agentId).toBe('fe');

    let state = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const detail = await request<{
        assignments: Array<{ state: string }>;
      }>(`/api/work/items/${itemId}`);
      state = detail.body.assignments[0]?.state ?? '';
      if (state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(state).toBe('done');
  });

  it('记忆写入校验作用域归属', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '记忆作用域' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#scope' }),
    });
    const groupId = group.body.group.id;
    expect(groupId).toBeTruthy();

    const wrongProject = await request<{ error: { message: string } }>(
      '/api/work/memories',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          scopeType: 'project',
          scopeId: 'other-project',
          content: '错误作用域',
        }),
      },
    );
    expect(wrongProject.status).toBe(400);

    const wrongGroup = await request<{ error: { message: string } }>(
      '/api/work/memories',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          scopeType: 'group',
          scopeId: 'other-group',
          content: '错误群聊',
        }),
      },
    );
    expect(wrongGroup.status).toBe(400);

    const agentMemory = await request<{
      memory: { scopeId: string; agentId: string };
    }>('/api/work/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        scopeType: 'agent',
        scopeId: 'fe',
        content: '前端 Agent 记忆',
      }),
    });
    expect(agentMemory.status).toBe(201);
    expect(agentMemory.body.memory.agentId).toBe('fe');
  });

  it('Work Item 优先级可更新并返回', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '优先级项目' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#priority' }),
    });
    const groupId = group.body.group.id;
    const message = await request<{ event: { id: string } }>(
      `/api/work/groups/${groupId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '优先级测试' }),
      },
    );
    const triaged = await request<{ item: { id: string } }>(
      `/api/work/groups/${groupId}/triage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: message.body.event.id }),
      },
    );
    const updated = await request<{ priority: number }>(
      `/api/work/items/${triaged.body.item.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ priority: 3 }),
      },
    );
    expect(updated.body.priority).toBe(3);
    const detail = await request<{ item: { priority: number } }>(
      `/api/work/items/${triaged.body.item.id}`,
    );
    expect(detail.body.item.priority).toBe(3);
  });

  it('只接受 GitHub 来源事件', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '仅 GitHub' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#github-only' }),
    });
    const response = await request<{ error: { code: string } }>(
      '/api/work/sources/feishu',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId,
          groupId: group.body.group.id,
          externalId: 'x',
          title: 'x',
        }),
      },
    );
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe('E_WORK_SOURCE_UNSUPPORTED');
  });

  it('GitHub 事件自动分派 assistant 并执行', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'GitHub 自动执行' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#auto' }),
    });
    const groupId = group.body.group.id;
    await request('/api/work/sources/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        groupId,
        externalId: 'auto-issue-1',
        title: '自动执行登录页修复',
        body: '点击登录后白屏',
        url: 'https://github.com/acme/app/issues/77',
      }),
    });

    let assignmentState = '';
    let agentId = '';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const items = await request<{
        items: Array<{ id: string; groupId: string | null }>;
      }>(`/api/work/items?projectId=${projectId}`);
      const item = items.body.items.find(
        (candidate) => candidate.groupId === groupId,
      );
      if (item) {
        const detail = await request<{
          assignments: Array<{ state: string; agentId: string }>;
        }>(`/api/work/items/${item.id}`);
        const assignment = detail.body.assignments[0];
        assignmentState = assignment?.state ?? '';
        agentId = assignment?.agentId ?? '';
        if (assignmentState === 'done') break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(agentId).toBe('assistant');
    expect(assignmentState).toBe('done');
  });

  it('GitHub webhook 只给 projectId 时自动使用 #GitHub', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '默认群聊' }),
      },
    );
    const projectId = project.body.project.id;
    const response = await request<{ duplicate: boolean }>(
      `/api/work/sources/github?projectId=${projectId}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          externalId: 'default-group-1',
          title: '默认群聊问题',
          url: 'https://github.com/acme/app/issues/99',
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(response.body.duplicate).toBe(false);
    const groups = await request<{ groups: Array<{ id: string; name: string }> }>(
      `/api/work/groups?projectId=${projectId}`,
    );
    expect(groups.body.groups.some((group) => group.name === '#GitHub')).toBe(
      true,
    );
  });

  it('GitHub ping 返回 200', async () => {
    const response = await request<{ ok: boolean; pong: boolean }>(
      '/api/work/sources/github',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
        },
        body: JSON.stringify({ zen: 'Design for failure.' }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, pong: true });
  });

  it('GitHub webhook 别名与 ping', async () => {
    const response = await request<{ ok: boolean; pong: boolean }>(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
        },
        body: JSON.stringify({ zen: 'Stay focused.' }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.pong).toBe(true);
  });

  it('GitHub webhook 不传 projectId 时使用默认项目', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '无配置项目' }),
      },
    );
    const projectId = project.body.project.id;
    const response = await request<{ duplicate: boolean }>(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          externalId: 'no-project-1',
          title: '无配置 GitHub 问题',
          url: 'https://github.com/acme/app/issues/110',
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(response.body.duplicate).toBe(false);
    const groups = await request<{ groups: Array<{ name: string }> }>(
      `/api/work/groups?projectId=${projectId}`,
    );
    expect(groups.body.groups.some((group) => group.name === '#GitHub')).toBe(
      true,
    );
  });

  it('GitHub delivery id 幂等', async () => {
    const project = await request<{ project: { id: string } }>(
      '/api/chat/projects',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Delivery 幂等' }),
      },
    );
    const projectId = project.body.project.id;
    const group = await request<{ group: { id: string } }>('/api/work/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: '#delivery' }),
    });
    const payload = {
      projectId,
      groupId: group.body.group.id,
      externalId: 'delivery-issue-1',
      title: 'Delivery 幂等测试',
      url: 'https://github.com/acme/app/issues/120',
    };
    const first = await request<{ duplicate: boolean }>(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-1',
        },
        body: JSON.stringify(payload),
      },
    );
    expect(first.status).toBe(202);
    const second = await request<{ duplicate: boolean }>(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-1',
        },
        body: JSON.stringify({ ...payload, title: 'title changed' }),
      },
    );
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const third = await request<{ duplicate: boolean }>(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'delivery-2',
        },
        body: JSON.stringify(payload),
      },
    );
    expect(third.status).toBe(200);
    expect(third.body.duplicate).toBe(true);
  });

  it('GitHub 状态端点返回回执配置', async () => {
    const response = await request<{
      transport: string | null;
      tokenConfigured: boolean;
      ready: boolean;
    }>('/api/github/status');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('transport');
    expect(typeof response.body.tokenConfigured).toBe('boolean');
    expect(typeof response.body.ready).toBe('boolean');
  });
});
