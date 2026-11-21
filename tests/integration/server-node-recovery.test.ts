/**
 * 节点级恢复 API：失败节点重试、等待节点取消。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { Store } from '@spec-agent/core';
import { startServer, type RunningServer } from '@spec-agent/server';

const io = { out: () => {}, err: () => {} };
const roots: string[] = [];
const servers: RunningServer[] = [];

const RETRY_SPEC = `name: retry-shell
version: 1
params: []
nodes:
  - id: work
    type: shell
    description: 第一次失败
    inputs: []
    outputs: []
    run: |
      node -e "const fs=require('fs'); if(!fs.existsSync('retry-ok')){fs.writeFileSync('retry-ok','1');process.exit(1)}"
edges: []
`;

const CANCEL_SPEC = `name: cancel-gate
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

async function project(specText: string): Promise<{ root: string; taskId: string }> {
  const root = mkdtempSync(join(tmpdir(), 'hive-node-recovery-'));
  roots.push(root);
  await main(['init', '--root', root], io);
  const specPath = join(root, 'spec.yaml');
  writeFileSync(specPath, specText);
  await main(['run', '--root', root, '--spec', specPath, '节点恢复'], io);
  return { root, taskId: '' };
}

afterAll(async () => {
  for (const server of servers) {
    await server.close().catch(() => undefined);
  }
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('节点级恢复', () => {
  it('失败任务可以重试失败节点并成功收口', async () => {
    const { root } = await project(RETRY_SPEC);
    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
    });
    servers.push(server);

    const list = await fetch(`${server.url}/api/tasks`).then((response) =>
      response.json(),
    ) as { tasks: Array<{ id: string; status: string }> };
    const task = list.tasks[0]!;
    expect(task.status).toBe('failed');

    const detail = await fetch(`${server.url}/api/tasks/${task.id}`).then(
      (response) => response.json(),
    ) as { nodes: Array<{ id: string; nodeId: string; status: string }> };
    const node = detail.nodes[0]!;
    expect(node.status).toBe('failed');

    const retried = await fetch(
      `${server.url}/api/tasks/${task.id}/nodes/${node.id}/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '测试重试' }),
      },
    );
    expect(retried.status).toBe(200);

    const after = await fetch(`${server.url}/api/tasks/${task.id}`).then(
      (response) => response.json(),
    ) as {
      task: { status: string };
      nodes: Array<{ id: string; status: string; attempt: number }>;
    };
    expect(after.task.status).toBe('succeeded');
    expect(after.nodes.find((candidate) => candidate.id === node.id)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
    });
  });

  it('任务详情返回合并队列状态', async () => {
    const { root } = await project(RETRY_SPEC);
    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
    });
    servers.push(server);

    const list = await fetch(`${server.url}/api/tasks`).then((response) =>
      response.json(),
    ) as { tasks: Array<{ id: string }> };
    const task = list.tasks[0]!;
    const detail = await fetch(`${server.url}/api/tasks/${task.id}`).then(
      (response) => response.json(),
    ) as { nodes: Array<{ id: string }> };
    const node = detail.nodes[0]!;

    const store = new Store({ path: join(root, '.spec-agent', 'spec-agent.db') });
    try {
      store.ensureMerge(task.id, node.id, 'child_demo');
      store.markMergeAttempt(node.id, 'conflict');
      store.markMergeFailed(node.id, 'still conflict');
    } finally {
      store.close();
    }

    const after = await fetch(`${server.url}/api/tasks/${task.id}`).then(
      (response) => response.json(),
    ) as {
      merges: Array<{
        nodeRunId: string;
        status: string;
        attempts: number;
        lastError: string | null;
      }>;
    };
    expect(after.merges).toHaveLength(1);
    expect(after.merges[0]).toMatchObject({
      nodeRunId: node.id,
      status: 'failed',
      attempts: 1,
      lastError: 'still conflict',
    });
  });

  it('取消等待闸门的节点会取消闸门并让任务失败', async () => {
    const { root } = await project(CANCEL_SPEC);
    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
    });
    servers.push(server);

    const list = await fetch(`${server.url}/api/tasks`).then((response) =>
      response.json(),
    ) as { tasks: Array<{ id: string; status: string }> };
    const task = list.tasks[0]!;
    expect(task.status).toBe('waiting_gate');

    const detail = await fetch(`${server.url}/api/tasks/${task.id}`).then(
      (response) => response.json(),
    ) as { nodes: Array<{ id: string; status: string }> };
    const node = detail.nodes[0]!;
    expect(node.status).toBe('waiting_gate');

    const cancelled = await fetch(
      `${server.url}/api/tasks/${task.id}/nodes/${node.id}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '测试取消节点' }),
      },
    );
    expect(cancelled.status).toBe(200);

    const after = await fetch(`${server.url}/api/tasks/${task.id}`).then(
      (response) => response.json(),
    ) as {
      task: { status: string };
      nodes: Array<{ id: string; status: string }>;
      gates: Array<{ status: string }>;
    };
    expect(after.task.status).toBe('failed');
    expect(after.nodes[0]?.status).toBe('cancelled');
    expect(after.gates.every((gate) => gate.status !== 'pending')).toBe(true);
  });
});
