import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { startServer, type RunningServer } from '@spec-agent/server';

const io = { out: () => {}, err: () => {} };
const roots: string[] = [];
const servers: RunningServer[] = [];

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => undefined);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('observability', () => {
  it('metrics / stats 暴露任务、节点、成本和失败率', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-observability-'));
    roots.push(root);
    await main(['init', '--root', root], io);

    const successSpec = join(root, 'success.yaml');
    writeFileSync(
      successSpec,
      `name: obs-ok
version: 1
params: []
nodes:
  - id: ok
    type: shell
    description: ok
    inputs: []
    outputs: []
    run: 'node -e "process.exit(0)"'
edges: []
`,
    );
    await main(['run', '--root', root, '--spec', successSpec, '观测成功'], io);

    const failSpec = join(root, 'fail.yaml');
    writeFileSync(
      failSpec,
      `name: obs-fail
version: 1
params: []
nodes:
  - id: bad
    type: shell
    description: bad
    inputs: []
    outputs: []
    run: 'node -e "process.exit(1)"'
edges: []
`,
    );
    await main(['run', '--root', root, '--spec', failSpec, '观测失败'], io);

    const server = await startServer({
      root,
      port: 0,
      token: 'obs-token',
      webDist: join(root, 'missing-web'),
    });
    servers.push(server);

    const unauthorized = await fetch(`${server.url}/api/metrics`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${server.url}/api/metrics`, {
      headers: { authorization: 'Bearer obs-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('spec_agent_tasks{project="default",status="succeeded"} 1');
    expect(body).toContain('spec_agent_tasks{project="default",status="failed"} 1');
    expect(body).toContain('spec_agent_task_failure_ratio{project="default"} 0.5');
    expect(body).toContain('spec_agent_schema_version{project="default"} 42');
    expect(body).toContain('spec_agent_http_requests_total');
    expect(body).toContain('spec_agent_uptime_seconds');

    const stats = await fetch(`${server.url}/api/stats`, {
      headers: { authorization: 'Bearer obs-token' },
    }).then((result) => result.json()) as {
      ok: boolean;
      http: { requests: number };
      projects: Array<{
        id: string;
        taskCount: number;
        workflowCount: number;
        failedTaskCount: number;
        failureRate: number;
        totalCostUsd: number;
        migrationVersion: number;
        nodes: Record<string, number>;
      }>;
    };
    expect(stats.ok).toBe(true);
    expect(stats.http.requests).toBeGreaterThan(0);
    expect(stats.projects[0]).toMatchObject({
      id: 'default',
      taskCount: 2,
      workflowCount: 2,
      failedTaskCount: 1,
      failureRate: 0.5,
      migrationVersion: 42,
    });
    expect(stats.projects[0]?.nodes.succeeded).toBe(1);
    expect(stats.projects[0]?.nodes.failed).toBe(1);
  }, 20_000);
});




















