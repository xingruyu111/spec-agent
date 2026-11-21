/**
 * M4：多项目 + Bearer token。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { startServer, type RunningServer } from '@spec-agent/server';

const SPEC = `name: shell-only
version: 1
params: []
nodes:
  - id: hello
    type: shell
    description: 打印
    inputs: []
    outputs: []
    run: 'node -e "console.log(1)"'
edges: []
`;

const io = { out: () => {}, err: () => {} };
const TOKEN = 'test-secret-token';
const roots: string[] = [];
let server: RunningServer;

async function seed(title: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'hive-project-'));
  roots.push(root);
  await main(['init', '--root', root], io);
  const specPath = join(root, 'shell.yaml');
  writeFileSync(specPath, SPEC);
  await main(['run', '--root', root, '--spec', specPath, title], io);
  return root;
}

async function call(
  path: string,
  options: { token?: string; project?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.project) headers['x-spec-agent-project'] = options.project;

  const response = await fetch(`${server.url}${path}`, { headers });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  const rootA = await seed('项目 A 的任务');
  const rootB = await seed('项目 B 的任务');
  server = await startServer({
    projects: [
      { id: 'alpha', name: 'Alpha', root: rootA },
      { id: 'beta', name: 'Beta', root: rootB },
    ],
    token: TOKEN,
    port: 0,
    webDist: join(rootA, 'missing-web'),
  });
});

afterAll(async () => {
  await server?.close();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('M4: 多项目 + token', () => {
  it('health 不需要 token', async () => {
    const response = await call('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, projects: 2 });
  });

  it('没有 token 时 API 返回 401', async () => {
    const response = await call('/api/projects');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: 'E_UNAUTHORIZED' } });
  });

  it('错误 token 返回 401', async () => {
    const response = await call('/api/projects', { token: 'wrong' });
    expect(response.status).toBe(401);
  });

  it('正确 token 返回项目列表', async () => {
    const response = await call('/api/projects', { token: TOKEN });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      defaultProject: 'alpha',
      projects: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
    });
  });

  it('任务按项目隔离', async () => {
    const alpha = await call('/api/tasks', { token: TOKEN, project: 'alpha' });
    const beta = await call('/api/tasks', { token: TOKEN, project: 'beta' });

    const alphaTasks = (alpha.body as { tasks: Array<{ title: string }> }).tasks;
    const betaTasks = (beta.body as { tasks: Array<{ title: string }> }).tasks;

    expect(alphaTasks.map((task) => task.title)).toEqual(['项目 A 的任务']);
    expect(betaTasks.map((task) => task.title)).toEqual(['项目 B 的任务']);
  });

  it('未知项目返回 404', async () => {
    const response = await call('/api/tasks', {
      token: TOKEN,
      project: 'missing',
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'E_PROJECT_NOT_FOUND' } });
  });

  it('ready 报告项目健康', async () => {
    const response = await call('/api/ready');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      projects: [
        { id: 'alpha', ok: true },
        { id: 'beta', ok: true },
      ],
    });
  });

  it('SSE 需要 token，并能建立事件流', async () => {    const denied = await fetch(`${server.url}/api/events/stream`, {
      headers: { 'x-spec-agent-project': 'alpha' },
    });
    expect(denied.status).toBe(401);

    const controller = new AbortController();
    const response = await fetch(`${server.url}/api/events/stream`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-spec-agent-project': 'alpha',
      },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes(': connected')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain(': connected');

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
