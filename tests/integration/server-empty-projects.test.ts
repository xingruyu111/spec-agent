import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startServer } from '@spec-agent/server';

describe('desktop first-run project management', () => {
  it('没有项目注册表时也能启动，并能创建第一个项目', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-empty-projects-'));
    const server = await startServer({
      projectsFile: join(root, 'projects.json'),
      projectsHome: join(root, 'Projects'),
      providerFile: join(root, 'provider.json'),
      port: 0,
      webDist: join(root, 'missing-web'),
    });
    try {
      const initial = await fetch(`${server.url}/api/projects`).then((r) => r.json());
      expect(initial.projects).toEqual([]);
      const projectRoot = join(root, 'first-project');
      const created = await fetch(`${server.url}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '第一个项目', root: projectRoot }),
      });
      expect(created.status).toBe(201);
      const projects = await fetch(`${server.url}/api/projects`).then((r) => r.json());
      expect(projects.projects).toHaveLength(1);
      expect(projects.projects[0].name).toBe('第一个项目');
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
