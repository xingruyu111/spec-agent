/**
 * I4+：server API 黑盒。
 *
 * 用 CLI 造一个停在闸门的真实任务，再通过 HTTP 审批并看它收口。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import type { AgentRuntime, AgentRuntimeInput } from '@spec-agent/core';
import { startServer, type RunningServer } from '@spec-agent/server';

const PLAN = JSON.stringify({
  name: 'login',
  description: '登录页',
  nodes: [
    {
      id: 'design',
      description: '设计登录页',
      instructions: '写出页面结构',
      agent: 'fe',
    },
    {
      id: 'implement',
      description: '实现登录页',
      instructions: '创建 login.html',
      agent: 'fe',
    },
  ],
  edges: [['design', 'implement']],
});

const captured: AgentRuntimeInput[] = [];

const fakeRuntime: AgentRuntime = {
  id: 'fake',
  async run(input) {
    captured.push(input);
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
      outputs: [{ name: 'out', kind: 'text' }],
      text: 'done',
      transcriptRef: 'executor',
      usage: { usd: 0.01 },
      stopReason: 'finished',
    };
  },
};

const SPEC = `name: gate-demo
version: 1
params: []
nodes:
  - id: gate
    type: shell
    description: 等待审批
    inputs: []
    outputs: []
    run: 'node -e "console.log(1)"'
    approval: { approvers: [human] }
edges: []
`;

const AGENTS_YAML = `agents:
  pm:
    name: 产品经理
    parent: null
    role: 拆解与验收
    systemPrompt: 你是 pm
    model: { provider: inherit, model: inherit }
    tools: { allow: [Read, Write, Edit, Bash] }
    workspace: { writeScope: ['.'] }
    canDelegateTo: [fe, be]
  fe:
    name: 前端
    parent: pm
    role: 写前端
    systemPrompt: FE-SYSTEM
    model: { provider: inherit, model: inherit }
  be:
    name: 后端
    parent: pm
    role: 写后端
    systemPrompt: BE-SYSTEM
    model: { provider: inherit, model: inherit }
`;

const io = { out: () => {}, err: () => {} };
let root = '';
let server: RunningServer;
let taskId = '';
let gateId = '';

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${path}`, init);
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hive-server-'));
  await main(['init', '--root', root], io);
  const specPath = join(root, 'gate.yaml');
  writeFileSync(specPath, SPEC);
  await main(['run', '--root', root, '--spec', specPath, '审批测试'], io);
  writeFileSync(join(root, '.spec-agent', 'agents.yaml'), AGENTS_YAML);

  server = await startServer({
    root,
    port: 0,
    webDist: join(root, 'missing-web'),
    agentRuntime: fakeRuntime,
    model: 'fake',
  });

  const list = await json<{ tasks: Array<{ id: string }>; gates: Array<{ id: string }> }>(
    '/api/tasks',
  );
  taskId = list.body.tasks[0]!.id;
  gateId = list.body.gates[0]!.id;
});

afterAll(async () => {
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('I4+: server', () => {
  it('列出停在闸门的任务与待审批', async () => {
    const list = await json<{
      tasks: Array<{ id: string; status: string }>;
      gates: Array<{ id: string; status: string }>;
    }>('/api/tasks');

    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0]?.status).toBe('waiting_gate');
    expect(list.body.gates).toHaveLength(1);
    expect(list.body.gates[0]?.status).toBe('pending');
  });

  it('AI 辅助接口返回模型文本', async () => {
    const response = await json<{ text: string }>('/api/ai/assist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'role',
        text: '根据需求生成文档',
        context: { name: '项目经理' },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.body.text).toBe('done');
  });

  it('任务详情包含节点与事件', async () => {
    const detail = await json<{
      task: { id: string; status: string };
      nodes: Array<{ nodeId: string; status: string }>;
      events: Array<{ type: string }>;
    }>(`/api/tasks/${taskId}`);

    expect(detail.status).toBe(200);
    expect(detail.body.task.status).toBe('waiting_gate');
    expect(detail.body.nodes[0]).toMatchObject({ nodeId: 'gate', status: 'waiting_gate' });
    expect(detail.body.events.some((event) => event.type === 'task.created')).toBe(true);
  });

  it('拒绝时缺少原因是 400', async () => {
    const response = await json<{ error: { code: string } }>(
      `/api/gates/${gateId}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('E_GATE_REASON');
  });

  it('HTTP 批准后任务收口', async () => {
    const response = await json<{ gate: { status: string } }>(
      `/api/gates/${gateId}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', by: 'web-test' }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.gate.status).toBe('passed');

    const detail = await json<{
      task: { status: string };
      nodes: Array<{ status: string }>;
    }>(`/api/tasks/${taskId}`);
    expect(detail.body.task.status).toBe('succeeded');
    expect(detail.body.nodes[0]?.status).toBe('succeeded');

    const gates = await json<{ gates: unknown[] }>('/api/gates');
    expect(gates.body.gates).toEqual([]);
  });

  it('未知任务返回 404，静态目录缺失也返回 404', async () => {
    const missing = await json<{ error: { code: string } }>('/api/tasks/task_missing');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('E_TASK_NOT_FOUND');

    const rootPage = await fetch(server.url + '/');
    expect(rootPage.status).toBe(404);
  });

  it('API 带 CORS 头', async () => {
    const response = await fetch(`${server.url}/api/tasks`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('返回组织树', async () => {
    const response = await json<{
      agents: Array<{ id: string; parent: string | null; name: string }>;
    }>('/api/agents');

    expect(response.status).toBe(200);
    expect(response.body.agents.map((agent) => agent.id).sort()).toEqual([
      'be',
      'fe',
      'pm',
    ]);
    expect(response.body.agents.find((agent) => agent.id === 'pm')?.parent).toBeNull();
    expect(response.body.agents.find((agent) => agent.id === 'fe')?.parent).toBe('pm');
  });

  it('目标 → 规划 → 确认 → 执行', async () => {
    const created = await json<{
      task: {
        id: string;
        status: string;
        costUsd: number;
        planCostUsd: number;
      };
      spec: { nodes: Array<{ id: string; type: string; agent?: string }> };
    }>('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '做一个登录页', assignee: 'pm' }),
    });

    expect(created.status).toBe(201);
    expect(created.body.task.status).toBe('waiting_gate');
    expect(created.body.task.planCostUsd).toBe(0.01);
    expect(created.body.task.costUsd).toBeGreaterThanOrEqual(0.01);
    expect(created.body.spec.nodes.map((node) => node.id)).toContain('plan-approval');
    expect(created.body.spec.nodes.filter((node) => node.type === 'llm')).toHaveLength(2);
    expect(
      created.body.spec.nodes
        .filter((node) => node.type === 'llm')
        .every((node) => node.agent === 'fe'),
    ).toBe(true);

    const taskIdNew = created.body.task.id;
    const detail = await json<{ spec: { nodes: unknown[] } }>(
      `/api/tasks/${taskIdNew}`,
    );
    expect(detail.body.spec.nodes).toHaveLength(3);

    const invalid = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodes: [{ id: 'design', agent: 'ghost' }] }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('E_AGENT_NOT_FOUND');

    const patched = await json<{
      spec: { nodes: Array<{ id: string; agent?: string }> };
    }>(`/api/tasks/${taskIdNew}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodes: [{ id: 'design', agent: 'be' }] }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.spec.nodes.find((node) => node.id === 'design')?.agent).toBe(
      'be',
    );

    const added = await json<{
      spec: { nodes: Array<{ id: string }>; edges: Array<{ from: string; to: string }> };
    }>(`/api/tasks/${taskIdNew}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: [],
        addNodes: [
          {
            id: 'tests',
            description: '补测试',
            instructions: '写测试',
            agent: 'fe',
            after: 'implement',
          },
        ],
      }),
    });
    expect(added.status).toBe(200);
    expect(added.body.spec.nodes.map((node) => node.id)).toContain('tests');
    expect(added.body.spec.edges).toEqual(
      expect.arrayContaining([{ from: 'implement', to: 'tests' }]),
    );

    const removed = await json<{ spec: { nodes: Array<{ id: string }> } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodes: [], removeNodes: ['tests'] }),
      },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.spec.nodes.map((node) => node.id)).not.toContain('tests');

    const edgeAdded = await json<{
      spec: { edges: Array<{ from: string; to: string }> };
    }>(`/api/tasks/${taskIdNew}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: [],
        addEdges: [{ from: 'plan-approval', to: 'implement' }],
      }),
    });
    expect(edgeAdded.status).toBe(200);
    expect(edgeAdded.body.spec.edges).toEqual(
      expect.arrayContaining([
        { from: 'plan-approval', to: 'implement' },
        { from: 'design', to: 'implement' },
      ]),
    );

    const edgeRemoved = await json<{
      spec: { edges: Array<{ from: string; to: string }> };
    }>(`/api/tasks/${taskIdNew}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: [],
        removeEdges: [{ from: 'plan-approval', to: 'implement' }],
      }),
    });
    expect(edgeRemoved.status).toBe(200);
    expect(edgeRemoved.body.spec.edges).not.toEqual(
      expect.arrayContaining([{ from: 'plan-approval', to: 'implement' }]),
    );

    const selfEdge = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: [],
          addEdges: [{ from: 'design', to: 'design' }],
        }),
      },
    );
    expect(selfEdge.status).toBe(400);
    expect(selfEdge.body.error.code).toBe('E_PLAN_PATCH');

    const duplicateEdge = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: [],
          addEdges: [{ from: 'design', to: 'implement' }],
        }),
      },
    );
    expect(duplicateEdge.status).toBe(400);
    expect(duplicateEdge.body.error.code).toBe('E_PLAN_PATCH');

    const cycle = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: [],
          addEdges: [{ from: 'implement', to: 'design' }],
        }),
      },
    );
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('E_PLAN_SHAPE');

    const unknownEdge = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: [],
          addEdges: [{ from: 'ghost', to: 'design' }],
        }),
      },
    );
    expect(unknownEdge.status).toBe(400);
    expect(unknownEdge.body.error.code).toBe('E_PLAN_PATCH');

    const missingEdge = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: [],
          removeEdges: [{ from: 'plan-approval', to: 'acceptance' }],
        }),
      },
    );
    expect(missingEdge.status).toBe(400);
    expect(missingEdge.body.error.code).toBe('E_PLAN_PATCH');

    const orphan = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: [],
          removeEdges: [{ from: 'design', to: 'implement' }],
        }),
      },
    );
    expect(orphan.status).toBe(400);
    expect(orphan.body.error.code).toBe('E_PLAN_SHAPE');

    const instructions = await json<{
      spec: { nodes: Array<{ id: string; instructions?: string }> };
    }>(`/api/tasks/${taskIdNew}/plan`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodes: [{ id: 'design', instructions: '新的页面结构指令' }],
      }),
    });
    expect(instructions.status).toBe(200);
    expect(
      instructions.body.spec.nodes.find((node) => node.id === 'design')
        ?.instructions,
    ).toBe('新的页面结构指令');

    const protectedRemove = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodes: [], removeNodes: ['plan-approval'] }),
      },
    );
    expect(protectedRemove.status).toBe(400);
    expect(protectedRemove.body.error.code).toBe('E_PLAN_SHAPE');

    const gates = await json<{ gates: Array<{ id: string; taskId: string }> }>('/api/gates');
    const gate = gates.body.gates.find((candidate) => candidate.taskId === taskIdNew)!;
    expect(gate).toBeTruthy();

    const approved = await json<{ gate: { status: string } }>(
      `/api/gates/${gate.id}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', by: 'plan-test' }),
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.gate.status).toBe('passed');

    const after = await json<{
      task: { status: string; costUsd: number; planCostUsd: number };
      nodes: Array<{ status: string }>;
    }>(`/api/tasks/${taskIdNew}`);
    expect(after.body.task.status).toBe('succeeded');
    expect(after.body.task.costUsd).toBeGreaterThan(after.body.task.planCostUsd);
    expect(after.body.nodes.every((node) => node.status === 'succeeded')).toBe(true);

    // 改过的计划真的生效：design 以 be 身份执行，implement 仍是 fe
    expect(captured.some((input) => input.systemPrompt.includes('BE-SYSTEM'))).toBe(true);
    expect(captured.some((input) => input.systemPrompt.includes('FE-SYSTEM'))).toBe(true);

    const locked = await json<{ error: { code: string } }>(
      `/api/tasks/${taskIdNew}/plan`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodes: [] }),
      },
    );
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('E_PLAN_LOCKED');
  });

  it('health / ready 不需要 token', async () => {
    const health = await json<{ ok: boolean; uptime: number; projects: number }>(
      '/api/health',
    );
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.projects).toBe(1);
    expect(health.body.uptime).toBeGreaterThanOrEqual(0);

    const ready = await json<{
      ok: boolean;
      projects: Array<{
        id: string;
        ok: boolean;
        migration: number;
        git: boolean;
        warnings: string[];
      }>;
    }>('/api/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.ok).toBe(true);
    expect(ready.body.projects).toEqual([
      expect.objectContaining({
        id: 'default',
        ok: true,
        migration: 42,
        git: true,
      }),
    ]);
    expect(ready.body.projects[0]?.warnings).toContain('web-dist');
  });

  it('取消等待审批的任务会清空收件箱', async () => {
    const created = await json<{ task: { id: string } }>('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: '取消我', assignee: 'pm' }),
    });
    const id = created.body.task.id;

    const cancelled = await json<{ task: { status: string } }>(
      `/api/tasks/${id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '不做了' }),
      },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task.status).toBe('cancelled');

    const gates = await json<{ gates: Array<{ taskId: string }> }>('/api/gates');
    expect(gates.body.gates.some((gate) => gate.taskId === id)).toBe(false);

    const detail = await json<{ nodes: Array<{ status: string }> }>(
      `/api/tasks/${id}`,
    );
    expect(detail.body.nodes.every((node) => node.status === 'cancelled')).toBe(true);
  });
});




















