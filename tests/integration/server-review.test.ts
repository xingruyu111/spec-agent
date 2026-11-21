/**
 * 变更审查 API：提交列表、commit diff、按分支 blame。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { startServer, type RunningServer } from '@spec-agent/server';

const SPEC = `name: review
version: 1
params: []
nodes:
  - id: write
    type: shell
    description: 写文件
    inputs: []
    outputs: []
    run: "node -e \\"require('fs').writeFileSync('out.txt','hi')\\""
edges: []
`;

const io = { out: () => {}, err: () => {} };
let root = '';
let server: RunningServer;
let taskId = '';
let commit = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hive-review-'));
  await main(['init', '--root', root], io);
  const specPath = join(root, 'review.yaml');
  writeFileSync(specPath, SPEC);
  await main(['run', '--root', root, '--spec', specPath, '写文件的任务'], io);

  server = await startServer({
    root,
    port: 0,
    webDist: join(root, 'missing-web'),
  });

  const response = await fetch(`${server.url}/api/tasks`);
  const body = (await response.json()) as { tasks: Array<{ id: string }> };
  taskId = body.tasks[0]!.id;
});

afterAll(async () => {
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('变更审查', () => {
  it('提交列表带出 agent 提交', async () => {
    const response = await fetch(`${server.url}/api/tasks/${taskId}/commits`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      commits: Array<{ hash: string; subject: string; author: string }>;
    };

    const taskCommit = body.commits.find((entry) =>
      entry.subject.includes('写文件'),
    );
    expect(taskCommit).toBeTruthy();
    expect(taskCommit?.author).toBe('pm');
    commit = taskCommit!.hash;
  });

  it('commit diff 包含改动文件', async () => {
    const response = await fetch(
      `${server.url}/api/tasks/${taskId}/commits/${commit}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      patch: string;
      files: Array<{ status: string; path: string }>;
    };
    expect(body.patch).toContain('out.txt');
    expect(body.patch).toContain('Spec-Agent-Task');
    expect(body.files).toEqual([{ status: 'A', path: 'out.txt' }]);
  });

  it('blame 能追回任务与 agent', async () => {
    const response = await fetch(
      `${server.url}/api/tasks/${taskId}/blame?path=out.txt&line=1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      content: string;
      trailers: Record<string, string>;
    };
    expect(body.content).toBe('hi');
    expect(body.trailers['Spec-Agent-Task']).toBe(taskId);
    expect(body.trailers['Spec-Agent']).toBe('pm');
  });

  it('timeline 返回任务树和节点时间', async () => {
    const response = await fetch(`${server.url}/api/tasks/${taskId}/timeline`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rootId: string;
      tasks: Array<{ id: string; createdAt: string }>;
      nodes: Array<{
        id: string;
        taskId: string;
        nodeId: string;
        createdAt: string;
        finishedAt: string | null;
        commits: Array<{ hash: string; subject: string }>;
      }>;
    };

    expect(body.rootId).toBe(taskId);
    expect(body.tasks).toHaveLength(1);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({
      taskId,
      nodeId: 'write',
      commits: [{ hash: commit }],
    });
    expect(body.nodes[0]?.createdAt).toBeTruthy();
    expect(body.nodes[0]?.finishedAt).toBeTruthy();
  });

  it('文件 review 返回内容和每行归属', async () => {
    const response = await fetch(
      `${server.url}/api/tasks/${taskId}/file?path=out.txt&ref=${commit}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      content: string;
      lines: Array<{
        line: number;
        content: string;
        trailers: Record<string, string>;
      }>;
    };
    expect(body.content).toBe('hi');
    expect(body.lines[0]).toMatchObject({
      line: 1,
      content: 'hi',
    });
    expect(body.lines[0]?.trailers['Spec-Agent-Task']).toBe(taskId);
    expect(body.lines[0]?.trailers['Spec-Agent']).toBe('pm');
  });

  it('文件 review 拒绝路径穿越', async () => {
    const response = await fetch(
      `${server.url}/api/tasks/${taskId}/file?path=../spec-agent.db`,
    );
    expect(response.status).toBe(400);
  });

  it('不存在的 commit 返回 404', async () => {
    const response = await fetch(
      `${server.url}/api/tasks/${taskId}/commits/deadbeef`,
    );
    expect(response.status).toBe(404);
  });
});
