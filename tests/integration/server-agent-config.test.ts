/**
 * 组织配置 API：读取完整配置、保存、校验失败不落盘、空项目初始化。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '@spec-agent/server';

const AGENTS = {
  agents: {
    pm: {
      name: '产品经理',
      parent: null,
      role: '拆解与验收',
      systemPrompt: '你是 pm',
      model: { provider: 'inherit', model: 'inherit' },
      canDelegateTo: ['fe'],
    },
    fe: {
      name: '前端',
      parent: 'pm',
      role: '写前端',
      model: { provider: 'inherit', model: 'inherit' },
      tools: { allow: ['Read', 'Write'], shell: 'readonly' },
      workspace: { writeScope: ['src/'] },
    },
  },
};

let base = '';
let emptyRoot = '';
let server: RunningServer;
let emptyServer: RunningServer;

async function call(
  path: string,
  options: { method?: string; body?: unknown; server?: RunningServer } = {},
): Promise<{ status: number; body: any }> {
  const target = options.server ?? server;
  const response = await fetch(`${target.url}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'hive-agent-config-'));
  mkdirSync(join(base, '.spec-agent'), { recursive: true });
  writeFileSync(join(base, '.spec-agent', 'agents.yaml'), JSON.stringify(AGENTS));

  emptyRoot = mkdtempSync(join(tmpdir(), 'hive-agent-empty-'));

  server = await startServer({
    root: base,
    port: 0,
    webDist: join(base, 'missing-web'),
  });
  emptyServer = await startServer({
    root: emptyRoot,
    port: 0,
    webDist: join(emptyRoot, 'missing-web'),
  });
});

afterAll(async () => {
  await server?.close();
  await emptyServer?.close();
  for (const root of [base, emptyRoot]) {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('组织配置', () => {
  it('读取完整配置并返回路径', async () => {
    const result = await call('/api/agents/config');
    expect(result.status).toBe(200);
    expect(result.body.exists).toBe(true);
    expect(result.body.path).toBe(join(base, '.spec-agent', 'agents.yaml'));
    expect(result.body.agents).toHaveLength(2);
    const pm = result.body.agents.find((agent: { id: string }) => agent.id === 'pm');
    expect(pm.systemPrompt).toBe('你是 pm');
    expect(pm.model).toEqual({ provider: 'inherit', model: 'inherit' });
  });

  it('保存后热加载并写回 YAML', async () => {
    const current = await call('/api/agents/config');
    const agents = current.body.agents as Array<Record<string, unknown>>;
    const pm = agents.find((agent) => agent.id === 'pm')!;
    pm.role = '新的产品经理角色';
    pm.systemPrompt = '你是新的 pm';
    pm.model = { provider: 'deepseek', model: 'deepseek-chat' };
    pm.nodes = [
      {
        id: 'design',
        name: '需求拆解',
        description: '拆解目标',
        instructions: '输出验收标准',
        approval: true,
      },
    ];
    const fe = agents.find((agent) => agent.id === 'fe')!;
    fe.role = '新的前端角色';

    const saved = await call('/api/agents/config', {
      method: 'PUT',
      body: { agents },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.agents).toHaveLength(2);

    const sanitized = await call('/api/agents');
    const savedPm = sanitized.body.agents.find(
      (agent: { id: string }) => agent.id === 'pm',
    );
    expect(savedPm.role).toBe('新的产品经理角色');
    expect(savedPm.nodes).toEqual([
      {
        id: 'design',
        name: '需求拆解',
        description: '拆解目标',
        instructions: '输出验收标准',
        approval: true,
      },
    ]);
    const text = readFileSync(join(base, '.spec-agent', 'agents.yaml'), 'utf8');
    expect(text).toContain('新的产品经理角色');
    expect(text).toContain('deepseek-chat');
    expect(text).toContain('需求拆解');
  });

  it('非法组织返回 400 且不覆盖文件', async () => {
    const path = join(base, '.spec-agent', 'agents.yaml');
    const before = readFileSync(path, 'utf8');
    const current = await call('/api/agents/config');
    const agents = current.body.agents as Array<Record<string, unknown>>;
    const fe = agents.find((agent) => agent.id === 'fe')!;
    fe.parent = 'ghost';

    const result = await call('/api/agents/config', {
      method: 'PUT',
      body: { agents },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('E_AGENT_CONFIG');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('没有 agents.yaml 时可以从空配置创建', async () => {
    const empty = await call('/api/agents/config', { server: emptyServer });
    expect(empty.status).toBe(200);
    expect(empty.body.exists).toBe(false);
    expect(empty.body.agents).toEqual([]);

    const noOrg = await call('/api/tasks', {
      method: 'POST',
      server: emptyServer,
      body: { goal: '没有组织时不能创建任务' },
    });
    expect(noOrg.status).toBe(400);
    expect(noOrg.body.error.code).toBe('E_ORG_REQUIRED');

    const created = await call('/api/agents/config', {
      method: 'PUT',
      server: emptyServer,
      body: {
        agents: [
          {
            id: 'pm',
            name: '产品经理',
            parent: null,
            role: '拆解需求',
            model: { provider: 'inherit', model: 'inherit' },
            tools: { allow: ['Read', 'Write'], shell: 'readonly' },
            workspace: { writeScope: ['.'] },
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.agents).toHaveLength(1);
    expect(existsSync(join(emptyRoot, '.spec-agent', 'agents.yaml'))).toBe(true);

    const sanitized = await call('/api/agents', { server: emptyServer });
    expect(sanitized.body.agents).toHaveLength(1);

    const unknownAssignee = await call('/api/tasks', {
      method: 'POST',
      server: emptyServer,
      body: { goal: '做一个页面', assignee: 'ghost' },
    });
    expect(unknownAssignee.status).toBe(400);
    expect(unknownAssignee.body.error.code).toBe('E_AGENT_NOT_FOUND');
  });
});
