import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '@spec-agent/server';

let base = '';
let server: RunningServer;
const projectsHome = () => join(base, 'projects');
const picked = () => join(base, 'picked-project');

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'hive-project-import-'));
  const projectsFile = join(base, 'projects.json');
  writeFileSync(
    projectsFile,
    JSON.stringify({
      projects: [{ id: 'base', name: 'Base', root: join(base, 'base') }],
    }),
  );
  server = await startServer({
    projectsFile,
    projectsHome: projectsHome(),
    port: 0,
    folderPicker: async () => picked(),
  });
});

afterAll(async () => {
  await server?.close();
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function call(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe('项目文件夹导入', () => {
  it('系统文件夹选择器返回路径', async () => {
    const response = await call('/api/system/pick-folder', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(response.body.path).toBe(picked());
  });

  it('拖入文件夹上传后创建项目并写入 repo', async () => {
    const form = new FormData();
    form.set('name', '导入项目');
    form.append('file', new Blob(['hello\n'], { type: 'text/plain' }), 'src/hello.txt');
    form.append('file', new Blob(['docs\n'], { type: 'text/plain' }), 'docs/readme.md');

    const response = await fetch(`${server.url}/api/projects/import`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      project: { id: string; name: string; root: string };
    };
    expect(body.project.name).toBe('导入项目');
    expect(body.project.root.startsWith(projectsHome())).toBe(true);
    expect(existsSync(join(body.project.root, 'repo', 'src', 'hello.txt'))).toBe(true);
    expect(readFileSync(join(body.project.root, 'repo', 'docs', 'readme.md'), 'utf8')).toBe(
      'docs\n',
    );

    const archived = await call(`/api/projects/${body.project.id}?force=1`, {
      method: 'DELETE',
    });
    expect(archived.status).toBe(200);
  });

  it('缺少项目名返回 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    const response = await fetch(`${server.url}/api/projects/import`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(400);
  });

  it('拒绝路径穿越', async () => {
    const form = new FormData();
    form.set('name', '路径穿越');
    form.append('file', new Blob(['x']), '../escape.txt');
    const response = await fetch(`${server.url}/api/projects/import`, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(400);
  });
});
