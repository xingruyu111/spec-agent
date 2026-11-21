/**
 * 归档保护：项目还有未结束任务时默认拒绝，force=1 才允许。
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { startServer, type RunningServer } from '@spec-agent/server';

const io = { out: () => {}, err: () => {} };
const SPEC = `name: busy
version: 1
params: []
nodes:
  - id: wait
    type: shell
    description: 等待审批
    inputs: []
    outputs: []
    approval:
      approvers: [human]
    run: 'node -e "process.exit(0)"'
edges: []
`;

let base = '';
let server: RunningServer;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'hive-project-busy-'));
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  await main(['init', '--root', beta], io);

  const specPath = join(base, 'busy.yaml');
  writeFileSync(specPath, SPEC);
  await main(['run', '--root', beta, '--spec', specPath, '忙碌项目'], io);

  const projectsFile = join(base, 'projects.json');
  writeFileSync(
    projectsFile,
    JSON.stringify({
      projects: [
        { id: 'alpha', name: 'Alpha', root: alpha },
        { id: 'beta', name: 'Beta', root: beta },
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

describe('归档忙碌项目', () => {
  it('有未结束任务时拒绝，force=1 才归档', async () => {
    const denied = await fetch(`${server.url}/api/projects/beta`, {
      method: 'DELETE',
    });
    expect(denied.status).toBe(409);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_PROJECT_BUSY');

    const forced = await fetch(`${server.url}/api/projects/beta?force=1`, {
      method: 'DELETE',
    });
    expect(forced.status).toBe(200);

    const list = await fetch(`${server.url}/api/projects`);
    const data = (await list.json()) as {
      projects: Array<{ id: string }>;
    };
    expect(data.projects.map((project) => project.id)).toEqual(['alpha']);
    expect(existsSync(join(base, 'beta'))).toBe(true);
  });
});
