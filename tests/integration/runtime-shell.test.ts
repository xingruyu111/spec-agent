/**
 * 生产组合根：session 模式下 shell 节点直接在 task worktree 执行。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkflowSpec } from '@spec-agent/schema';
import { main } from '@spec-agent/cli';
import { createRuntime } from '@spec-agent/runtime';

const io = { out: () => {}, err: () => {} };
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('runtime shell isolation', () => {
  it('两个 shell 节点在 task worktree 执行，不再拆子任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-runtime-shell-'));
    roots.push(root);
    await main(['init', '--root', root], io);

    const spec: WorkflowSpec = {
      name: 'runtime-shell',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'a' as never,
          type: 'shell',
          description: '写 a',
          inputs: [],
          outputs: [{ name: 'a', kind: 'file', path: 'a.txt' }],
          run: `node -e "require('fs').writeFileSync('a.txt','a')"`,
        },
        {
          id: 'b' as never,
          type: 'shell',
          description: '写 b',
          inputs: [],
          outputs: [{ name: 'b', kind: 'file', path: 'b.txt' }],
          run: `node -e "require('fs').writeFileSync('b.txt','b')"`,
        },
      ],
      edges: [],
    };

    const hive = createRuntime({
      root,
      defaultSpec: spec,
      isolateNodes: true,
    });

    try {
      const taskId = hive.ids.task();
      hive.engine.dispatch({
        type: 'task.create',
        taskId,
        assignee: 'pm' as never,
        caller: null,
        title: 'shell 隔离',
        brief: '',
      });
      await hive.engine.runUntilIdle();

      expect(hive.store.getTask(taskId)?.status).toBe('succeeded');
      expect(hive.store.listChildTasks(taskId)).toHaveLength(0);
      expect(hive.store.listMerges(taskId)).toHaveLength(0);

      const parentWorktree = join(root, 'worktrees', taskId);
      expect(readFileSync(join(parentWorktree, 'a.txt'), 'utf8')).toBe('a');
      expect(readFileSync(join(parentWorktree, 'b.txt'), 'utf8')).toBe('b');
    } finally {
      hive.close();
    }
  }, 20_000);
});
