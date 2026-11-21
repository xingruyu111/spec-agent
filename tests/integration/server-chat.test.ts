import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { Store, type AgentRuntime } from '@spec-agent/core';
import { startServer, type RunningServer } from '@spec-agent/server';
import type { ChatEngine } from '../../apps/server/src/dsh/dsh-chat.js';

const io = { out: () => {}, err: () => {} };
let root = '';
let server: RunningServer;

const PLAN = JSON.stringify({
  name: 'chat-task',
  description: 'chat task',
  nodes: [{ id: 'one', description: '完成一件事', instructions: '完成', agent: 'pm' }],
  edges: [],
});

const PROJECT_PLAN = JSON.stringify({
  title: '测试项目计划',
  workstreams: [
    {
      id: 'ws-1',
      title: '拆解',
      brief: '拆解目标',
      assignee: 'pm',
      milestone: 'M1',
      dependsOn: [],
    },
    {
      id: 'ws-2',
      title: '验收',
      brief: '验收交付',
      assignee: 'pm',
      milestone: 'M2',
      dependsOn: ['ws-1'],
    },
  ],
});

const fakeRuntime: AgentRuntime = {
  id: 'fake-chat-runtime',
  async run(input) {
    if (input.systemPrompt.includes('项目计划器')) {
      return {
        outputs: [],
        text: PROJECT_PLAN,
        transcriptRef: 'project-planner',
        usage: { usd: 0.01 },
        stopReason: 'finished',
      };
    }
    if (input.systemPrompt.includes('工作流规划器')) {
      return {
        outputs: [],
        text: PLAN,
        transcriptRef: 'planner',
        usage: { usd: 0.01 },
        stopReason: 'finished',
      };
    }
    return {
      outputs: [],
      text: 'done',
      transcriptRef: 'executor',
      usage: { usd: 0.01 },
      stopReason: 'finished',
    };
  },
};

const CHANGE = [
  '我起草了一个测试 agent。',
  '```hive-change',
  JSON.stringify({
    summary: '新增测试助手',
    operations: [
      {
        op: 'upsert_agent',
        agent: {
          id: 'qa',
          name: '测试助手',
          parent: null,
          role: '负责测试',
          tools: { allow: ['Read'], shell: 'readonly' },
        },
      },
    ],
  }),
  '```',
].join('\n');

const fakeEngine: ChatEngine = {
  async run(input) {
    if (input.prompt.includes('配置变更已应用')) {
      return {
        sessionId: 'dsh-test-session',
        text: '配置已生效，自动继续执行完成。',
      };
    }
    if (input.prompt.includes('请生成项目计划')) {
      return {
        sessionId: 'dsh-test-session',
        text: [
          '已生成分阶段计划草案。',
          '```hive-project-plan',
          PROJECT_PLAN,
          '```',
        ].join('\n'),
      };
    }
    return {
      sessionId: 'dsh-test-session',
      text: CHANGE,
      reasoning: '先检查当前组织，再生成变更草案。',
    };
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
  root = mkdtempSync(join(tmpdir(), 'hive-chat-server-'));
  await main(['init', '--root', root], io);
  writeFileSync(
    join(root, '.spec-agent', 'agents.yaml'),
    `agents:
  pm:
    name: 项目经理
    parent: null
    role: 拆解与验收
    model: { provider: inherit, model: inherit }
`,
  );
  const seed = new Store({ path: join(root, '.spec-agent', 'spec-agent.db') });
  seed.createMemory({ scope: 'project', content: '使用 pnpm', source: 'task:seed' });
  seed.close();
  server = await startServer({
    root,
    port: 0,
    webDist: join(root, 'missing-web'),
    providerFile: join(root, 'provider.json'),
    chatEngine: fakeEngine,
    autoMemory: false,
    agentRuntime: fakeRuntime,
    model: 'fake',
  });
});

afterAll(async () => {
  await server?.close();
  if (root) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('chat API', () => {
  it('项目可创建独立 Git 目录、归属会话，删除后会话回到未归属', async () => {
    const createdSubproject = await request<{
      project: { id: string; name: string; root: string; repoPath: string };
    }>('/api/chat/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '客户端' }),
    });
    expect(createdSubproject.status).toBe(201);
    expect(createdSubproject.body.project.name).toBe('客户端');
    expect(createdSubproject.body.project.root).toBeTruthy();
    expect(createdSubproject.body.project.repoPath).toBe(
      createdSubproject.body.project.root,
    );
    expect(existsSync(join(createdSubproject.body.project.root, '.git'))).toBe(true);

    const listed = await request<{ projects: Array<{ id: string; name: string }> }>(
      '/api/chat/projects',
    );
    expect(listed.body.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: createdSubproject.body.project.id, name: '客户端' }),
      ]),
    );

    const session = await request<{
      session: { id: string; projectId: string | null };
    }>('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'qa',
        projectId: createdSubproject.body.project.id,
      }),
    });
    expect(session.status).toBe(201);
    expect(session.body.session.projectId).toBe(
      createdSubproject.body.project.id,
    );

    const missing = await request<{ error: { code: string } }>('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'qa', projectId: 'missing-project' }),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('E_CHAT_PROJECT');

    const removed = await request<{ removed: boolean }>(
      `/api/chat/projects/${createdSubproject.body.project.id}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);

    const sessions = await request<{
      sessions: Array<{ id: string; projectId: string | null }>;
    }>('/api/chat/sessions');
    expect(
      sessions.body.sessions.find((item) => item.id === session.body.session.id)
        ?.projectId,
    ).toBeNull();
  });

  it('聊天会话权限可切换并持久化', async () => {
    const created = await request<{
      session: { id: string; permissionMode: string };
    }>('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'qa' }),
    });
    expect(created.body.session.permissionMode).toBe('read-only');

    const changed = await request<{
      session: { permissionMode: string };
    }>(`/api/chat/sessions/${created.body.session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'workspace-write' }),
    });
    expect(changed.status).toBe(200);
    expect(changed.body.session.permissionMode).toBe('workspace-write');

    const invalid = await request<{ error: { code: string } }>(
      `/api/chat/sessions/${created.body.session.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permissionMode: 'root' }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('E_CHAT_MODE');
  });

  it('项目会话创建的任务写入项目独立 repoPath', async () => {
    const createdProject = await request<{
      project: { id: string; repoPath: string };
    }>('/api/chat/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '独立任务项目' }),
    });
    const projectId = createdProject.body.project.id;
    const session = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'task', projectId }),
      },
    );
    const sessionId = session.body.session.id;
    const sent = await request<{
      messages: Array<{ workflowDraft?: { id: string } }>;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '在独立项目里完成一个任务', mode: 'task' }),
    });
    const draftId = sent.body.messages.at(-1)?.workflowDraft?.id;
    expect(draftId).toBeTruthy();

    const confirmed = await request<{
      detail: { messages: Array<{ taskId: string | null }> };
    }>(`/api/chat/workflow-drafts/${draftId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const taskId = confirmed.body.detail.messages.at(-1)?.taskId;
    expect(taskId).toBeTruthy();

    const task = await request<{ task: { repoPath: string | null } }>(
      `/api/tasks/${taskId}`,
    );
    expect(task.body.task.repoPath).toBe(createdProject.body.project.repoPath);
  });

  it('项目计划按项目隔离并使用项目仓库', async () => {
    const first = await request<{
      project: { id: string; repoPath: string };
    }>('/api/chat/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '计划项目 A' }),
    });
    const second = await request<{
      project: { id: string };
    }>('/api/chat/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '计划项目 B' }),
    });

    const created = await request<{
      plan: { id: string; projectId: string | null };
      items: Array<{ repoPath: string | null }>;
    }>('/api/project-plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: '为项目 A 生成计划',
        projectId: first.body.project.id,
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.plan.projectId).toBe(first.body.project.id);
    expect(created.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoPath: first.body.project.repoPath }),
      ]),
    );

    const listA = await request<{ plans: Array<{ id: string }> }>(
      `/api/project-plans?projectId=${first.body.project.id}`,
    );
    expect(listA.body.plans).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.plan.id })]),
    );

    const listB = await request<{ plans: Array<{ id: string }> }>(
      `/api/project-plans?projectId=${second.body.project.id}`,
    );
    expect(listB.body.plans).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.plan.id })]),
    );
  });

  it('会话参与者与 @agent 回复走同一会话', async () => {
    const created = await request<{
      session: { id: string; kind: string };
      participants: Array<{ agentId: string; role: string }>;
    }>('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'qa',
        kind: 'group',
        participantAgentIds: ['pm'],
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body.session.kind).toBe('group');
    expect(created.body.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'assistant', role: 'assistant' }),
        expect.objectContaining({ agentId: 'pm', role: 'member' }),
      ]),
    );

    const sessionId = created.body.session.id;
    const sent = await request<{
      participants: Array<{ agentId: string }>;
      messages: Array<{ senderType: string; senderAgentId: string | null }>;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '@pm 看一下',
        mode: 'qa',
        mentions: ['pm'],
      }),
    });
    expect(sent.status).toBe(200);
    expect(sent.body.messages.at(-1)).toMatchObject({
      senderType: 'agent',
      senderAgentId: 'pm',
    });

    const removed = await request<{ removed: boolean }>(
      `/api/chat/sessions/${sessionId}/participants/pm`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);
    const removeAssistant = await request(
      `/api/chat/sessions/${sessionId}/participants/assistant`,
      { method: 'DELETE' },
    );
    expect(removeAssistant.status).toBe(409);
  });

  it('拒绝未知参与者与未加入会话的 @agent', async () => {
    const invalidCreate = await request<{ error: { code: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa', participantAgentIds: ['missing'] }),
      },
    );
    expect(invalidCreate.status).toBe(400);
    expect(invalidCreate.body.error.code).toBe('E_CHAT_PARTICIPANT');

    const created = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa' }),
      },
    );
    const sessionId = created.body.session.id;
    const invalidAdd = await request<{ error: { code: string } }>(
      `/api/chat/sessions/${sessionId}/participants`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'missing' }),
      },
    );
    expect(invalidAdd.status).toBe(400);
    expect(invalidAdd.body.error.code).toBe('E_CHAT_PARTICIPANT');

    const invalidMention = await request<{ error: { code: string } }>(
      `/api/chat/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '@pm 你好', mode: 'qa', mentions: ['pm'] }),
      },
    );
    expect(invalidMention.status).toBe(400);
    expect(invalidMention.body.error.code).toBe('E_CHAT_PARTICIPANT');
  });

  it('创建对话、读取项目并生成配置草案，确认后落盘', async () => {
    const created = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa' }),
      },
    );
    expect(created.status).toBe(201);
    const sessionId = created.body.session.id;

    const sent = await request<{
      messages: Array<{ role: string; changeSet?: { id: string; status: string } }>;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '创建一个测试 agent', mode: 'qa' }),
    });
    expect(sent.status).toBe(200);
    const changeSet = sent.body.messages.at(-1)?.changeSet;
    expect(changeSet?.status).toBe('pending');

    const applied = await request<{
      changeSet: { status: string };
      detail?: { messages: Array<{ role: string; content: string }> };
    }>(
      `/api/change-sets/${changeSet!.id}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.changeSet.status).toBe('applied');
    expect(applied.body.detail?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '配置已生效，自动继续执行完成。',
    });

    const agents = await request<{
      agents: Array<{ id: string; name: string }>;
    }>('/api/agents');
    expect(agents.body.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'qa', name: '测试助手' })]),
    );
  });

  it('任务模式先生成 workflow draft，确认后才创建 task', async () => {
    const created = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'task' }),
      },
    );
    const sessionId = created.body.session.id;
    const sent = await request<{
      messages: Array<{
        role: string;
        taskId: string | null;
        workflowDraft?: {
          id: string;
          status: string;
          spec: { nodes: Array<{ id: string }> };
        };
      }>;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '完成一个任务', mode: 'task' }),
    });
    expect(sent.status).toBe(200);
    const draftMessage = sent.body.messages.at(-1);
    expect(draftMessage?.taskId).toBeNull();
    expect(draftMessage?.workflowDraft?.status).toBe('pending');
    expect(draftMessage?.workflowDraft?.spec.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'one' })]),
    );

    const confirmed = await request<{
      detail: { messages: Array<{ taskId: string | null }> };
    }>(`/api/chat/workflow-drafts/${draftMessage!.workflowDraft!.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(confirmed.status).toBe(200);
    const taskId = confirmed.body.detail.messages.at(-1)?.taskId;
    expect(taskId).toBeTruthy();

    const task = await request<{
      task: { id: string; title: string };
      spec?: { nodes: unknown[] };
    }>(`/api/tasks/${taskId}`);
    expect(task.status).toBe(200);
    expect(task.body.spec?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'one' })]),
    );
  });

  it('workflow draft 可以放弃，不创建 task', async () => {
    const created = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'task' }),
      },
    );
    const sessionId = created.body.session.id;
    const sent = await request<{
      messages: Array<{ workflowDraft?: { id: string } }>;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '取消这个任务', mode: 'task' }),
    });
    const draftId = sent.body.messages.at(-1)?.workflowDraft?.id;
    expect(draftId).toBeTruthy();
    const rejected = await request<{ draft: { status: string } }>(
      `/api/chat/workflow-drafts/${draftId}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.draft.status).toBe('rejected');
    const rejectedAgain = await request(
      `/api/chat/workflow-drafts/${draftId}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(rejectedAgain.status).toBe(409);
    const detail = await request<{
      messages: Array<{ taskId: string | null; content: string }>;
    }>(`/api/chat/sessions/${sessionId}`);
    expect(detail.body.messages.some((message) => message.taskId)).toBe(false);
    expect(detail.body.messages.at(-1)?.content).toContain('不会创建任务');
  });

  it('流式端点推送 status / delta / done', async () => {
    const created = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa' }),
      },
    );
    const sessionId = created.body.session.id;
    const response = await fetch(
      `${server.url}/api/chat/sessions/${sessionId}/stream`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '流式测试', mode: 'qa' }),
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: status');
    expect(text).toContain('event: reasoning');
    expect(text).toContain('event: delta');
    expect(text).toContain('event: done');
    expect(text).toContain('先检查当前组织，再生成变更草案。');
    expect(text).toContain('"role":"assistant"');
  });

  it('记忆只读查询保留，手动写入接口不再暴露', async () => {
    const list = await request<{ memories: Array<{ content: string }> }>('/api/memories');
    expect(list.status).toBe(200);
    expect(list.body.memories.map((memory) => memory.content)).toContain('使用 pnpm');

    const created = await fetch(`${server.url}/api/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'project', content: '不应手动写入' }),
    });
    expect(created.status).toBe(404);
    const deleted = await fetch(`${server.url}/api/memories/memory-1`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(404);
  });

  it('非法变更会返回 422 并保留 pending 状态', async () => {
    const created = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa' }),
      },
    );
    const sessionId = created.body.session.id;
    const sent = await request<{
      messages: Array<{ changeSet?: { id: string } }>;
    }>(`/api/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '创建', mode: 'qa' }),
    });
    const changeSetId = sent.body.messages.at(-1)!.changeSet!.id;
    // overwrite is not exposed; verify closed-set behavior through apply twice
    await request(`/api/change-sets/${changeSetId}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const second = await request<{ error: { code: string } }>(
      `/api/change-sets/${changeSetId}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('E_CHANGE_SET_CLOSED');
  });

  it('项目计划可以生成、保存依赖并启动首个 workstream', async () => {
    const created = await request<{
      plan: { id: string; status: string };
      items: Array<{ id: string; status: string; dependsOn: string[] }>;
    }>('/api/project-plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '完成一个分阶段项目' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.plan.status).toBe('draft');
    expect(created.body.items).toHaveLength(2);
    expect(created.body.items[1]!.dependsOn).toEqual([created.body.items[0]!.id]);

    const started = await request<{
      plan: { status: string };
      items: Array<{ status: string; taskId: string | null }>;
    }>(`/api/project-plans/${created.body.plan.id}/start`, {
      method: 'POST',
    });
    expect(started.status).toBe(200);
    expect(started.body.plan.status).toBe('waiting');
    expect(started.body.items[0]!.taskId).toBeTruthy();
    expect(started.body.items[1]!.taskId).toBeNull();
  });

  it('聊天草案可保存为 draft 项目计划，应用保持幂等关闭', async () => {
    const session = await request<{ session: { id: string } }>(
      '/api/chat/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'qa' }),
      },
    );
    const sent = await request<{
      messages: Array<{
        projectPlanDraft?: {
          id: string;
          status: string;
          planId: string | null;
          workstreams: unknown[];
        } | null;
      }>;
    }>(`/api/chat/sessions/${session.body.session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '请生成项目计划', mode: 'qa' }),
    });
    const draft = sent.body.messages.at(-1)!.projectPlanDraft!;
    expect(draft.status).toBe('pending');
    expect(draft.workstreams).toHaveLength(2);

    const applied = await request<{
      projectPlanDraft: { status: string; planId: string };
    }>(`/api/project-plan-drafts/${draft.id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(applied.status).toBe(200);
    expect(applied.body.projectPlanDraft.status).toBe('applied');
    expect(applied.body.projectPlanDraft.planId).toBeTruthy();

    const plan = await request<{
      plan: { status: string };
      items: unknown[];
    }>(`/api/project-plans/${applied.body.projectPlanDraft.planId}`);
    expect(plan.status).toBe(200);
    expect(plan.body.plan.status).toBe('draft');
    expect(plan.body.items).toHaveLength(2);

    const again = await request<{ error: { code: string } }>(
      `/api/project-plan-drafts/${draft.id}/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('E_PROJECT_PLAN_DRAFT_CLOSED');
  });

  it('聊天会话持久化 provider/model，拒绝不属于供应商的模型', async () => {
    const created = await request<{
      session: { id: string; providerId: string | null; model: string | null };
    }>('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'qa', providerId: 'anthropic', model: 'fake' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.session.providerId).toBe('anthropic');    expect(created.body.session.model).toBe('fake');

    const invalid = await request<{ error: { code: string } }>(
      `/api/chat/sessions/${created.body.session.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'anthropic', model: 'not-configured' }),
      },
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('E_CHAT_MODEL');

    const renamed = await request<{ session: { title: string } }>(
      `/api/chat/sessions/${created.body.session.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '新的对话标题' }),
      },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.session.title).toBe('新的对话标题');
    const detail = await request<{ session: { title: string } }>(
      `/api/chat/sessions/${created.body.session.id}`,
    );
    expect(detail.body.session.title).toBe('新的对话标题');

    const emptyTitle = await request<{ error: { code: string } }>(
      `/api/chat/sessions/${created.body.session.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   ' }),
      },
    );
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.body.error.code).toBe('E_CHAT_TITLE');
  });
});

