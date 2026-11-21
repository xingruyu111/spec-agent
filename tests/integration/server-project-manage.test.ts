/**
 * 项目管理：创建、归档、持久化、只读模式。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '@spec-agent/server';

let base = '';
let projectsFile = '';
let server: RunningServer;
let gammaId = '';
const alpha = () => join(base, 'alpha');
const beta = () => join(base, 'beta');
const gamma = () => join(base, 'gamma');

async function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    project?: string;
  } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.project ? { 'x-spec-agent-project': options.project } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'hive-project-manage-'));
  projectsFile = join(base, 'projects.json');
  writeFileSync(
    projectsFile,
    JSON.stringify({
      projects: [
        { id: 'alpha', name: 'Alpha', root: alpha() },
        { id: 'beta', name: 'Beta', root: beta() },
      ],
    }),
  );

  server = await startServer({
    projectsFile,
    port: 0,
    webDist: join(base, 'missing-web'),
  });
});

afterAll(async () => {
  await server?.close();
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('项目管理', () => {
  it('列出项目和可管理标记', async () => {
    const result = await call('/api/projects');
    expect(result.status).toBe(200);
    expect(result.body.manageable).toBe(true);
    expect(result.body.projects.map((project: { id: string }) => project.id)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(result.body.projects[0].root).toBe(alpha());
  });

  it('创建项目会初始化目录并持久化', async () => {
    const result = await call('/api/projects', {
      method: 'POST',
      body: { name: 'Gamma', root: gamma() },
    });
    expect(result.status).toBe(201);
    expect(result.body.project.name).toBe('Gamma');
    expect(result.body.project.id).toMatch(/^p-[a-z0-9]+$/);
    gammaId = result.body.project.id;
    expect(existsSync(join(gamma(), '.spec-agent'))).toBe(true);
    expect(existsSync(join(gamma(), 'repo', '.git'))).toBe(true);

    const saved = JSON.parse(readFileSync(projectsFile, 'utf8')) as {
      projects: Array<{ id: string }>;
    };
    expect(saved.projects.map((project) => project.id)).toContain(gammaId);

    const tasks = await call('/api/tasks', { project: gammaId });
    expect(tasks.status).toBe(200);
    expect(tasks.body.tasks).toEqual([]);

    const agents = await call('/api/agents', { project: gammaId });
    expect(agents.status).toBe(200);
    expect(agents.body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'assistant', name: '助理' }),
      ]),
    );
  });

  it('重复 id / 目录、相对路径被拒绝', async () => {
    const duplicateId = await call('/api/projects', {
      method: 'POST',
      body: { id: 'alpha', name: 'Dup', root: join(base, 'dup-a') },
    });
    expect(duplicateId.status).toBe(409);
    expect(duplicateId.body.error.code).toBe('E_PROJECT_EXISTS');

    const duplicateRoot = await call('/api/projects', {
      method: 'POST',
      body: { name: 'Dup', root: alpha() },
    });
    expect(duplicateRoot.status).toBe(409);
    expect(duplicateRoot.body.error.code).toBe('E_PROJECT_EXISTS');

    const relative = await call('/api/projects', {
      method: 'POST',
      body: { name: 'Rel', root: 'relative/path' },
    });
    expect(relative.status).toBe(400);
    expect(relative.body.error.code).toBe('E_PROJECT_INVALID');
  });

  it('归档后从列表消失，目录保留，默认项目顺延', async () => {
    const archived = await call(`/api/projects/${gammaId}`, { method: 'DELETE' });
    expect(archived.status).toBe(200);
    expect(existsSync(gamma())).toBe(true);

    const after = await call('/api/projects');
    expect(after.body.projects.map((project: { id: string }) => project.id)).not.toContain(
      gammaId,
    );

    const alphaArchived = await call('/api/projects/alpha', {
      method: 'DELETE',
    });
    expect(alphaArchived.status).toBe(200);
    expect(alphaArchived.body.defaultProject).toBe('beta');
  });

  it('至少保留一个项目', async () => {
    const last = await call('/api/projects/beta', { method: 'DELETE' });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('E_PROJECT_LAST');
  });

  it('项目管理受 token 保护', async () => {
    const secure = await startServer({
      projectsFile,
      port: 0,
      webDist: join(base, 'missing-web'),
      token: 'secret',
    });
    try {
      const denied = await fetch(`${secure.url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', root: join(base, 'nope') }),
      });
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${secure.url}/api/projects`, {
        headers: { authorization: 'Bearer secret' },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await secure.close();
    }
  });

  it('重启后保留创建的项目', async () => {
    const created = await call('/api/projects', {
      method: 'POST',
      body: { id: 'delta', name: 'Delta', root: join(base, 'delta') },
    });
    expect(created.status).toBe(201);

    await server.close();
    server = await startServer({
      projectsFile,
      port: 0,
      webDist: join(base, 'missing-web'),
    });

    const list = await call('/api/projects');
    expect(list.body.projects.map((project: { id: string }) => project.id)).toContain(
      'delta',
    );
  });

  it('静态配置下不能创建项目', async () => {
    const staticServer = await startServer({
      root: alpha(),
      port: 0,
      webDist: join(base, 'missing-web'),
    });
    try {
      const response = await fetch(`${staticServer.url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nope', root: join(base, 'nope') }),
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('E_PROJECTS_READONLY');
    } finally {
      await staticServer.close();
    }
  });
});
