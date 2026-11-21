import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowSpec } from '@spec-agent/schema';
import {
  Engine,
  GitCli,
  Store,
  type ShellRunner,
} from '@spec-agent/core';
import { createIdFactory, createSystemClock } from '@spec-agent/kernel';

const roots: string[] = [];

const spec: WorkflowSpec = {
  name: 'repo-task',
  version: 1,
  params: [],
  nodes: [{
    id: 'write' as never,
    type: 'shell',
    description: '写仓库产物',
    inputs: [],
    outputs: [],
    run: 'write-result',
    autoCommit: false,
  }],
  edges: [],
};

describe('multi-repository tasks', () => {
  it('每个 root task 在自己的仓库创建 worktree 并执行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-multi-repo-'));
    roots.push(root);
    const repoA = join(root, 'repo-a');
    const repoB = join(root, 'repo-b');
    const git = new GitCli();
    await git.initRepo(repoA);
    await git.initRepo(repoB);

    const clock = createSystemClock();
    const store = new Store({ path: ':memory:', clock });
    const shell: ShellRunner = {
      async run(input) {
        writeFileSync(join(input.cwd, 'result.txt'), input.cwd);
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
    };
    const engine = new Engine({
      store,
      planner: { async plan() { return { spec }; } },
      runtime: { id: 'unused', async run() { throw new Error('unused'); } },
      shell,
      clock,
      ids: createIdFactory({ clock }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: join(root, 'repo'),
      git,
      repoPath: repoA,
      worktreeRoot: join(root, 'worktrees'),
      isolateNodes: false,
    });
    try {
      for (const [id, repoPath] of [['task-a', repoA], ['task-b', repoB]] as const) {
        engine.dispatch({
          type: 'task.create',
          taskId: id as never,
          assignee: 'pm' as never,
          caller: null,
          title: id,
          brief: id,
          repoPath,
        });
      }
      await engine.runUntilIdle();
      const taskA = store.getTask('task-a')!;
      const taskB = store.getTask('task-b')!;
      expect(taskA.status).toBe('succeeded');
      expect(taskB.status).toBe('succeeded');
      expect(taskA.repoPath).toBe(repoA);
      expect(taskB.repoPath).toBe(repoB);
      expect(readFileSync(join(root, 'worktrees', 'task-a', 'result.txt'), 'utf8')).toContain('task-a');
      expect(readFileSync(join(root, 'worktrees', 'task-b', 'result.txt'), 'utf8')).toContain('task-b');
    } finally {
      engine.shutdown();
      store.close();
      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  });
});
