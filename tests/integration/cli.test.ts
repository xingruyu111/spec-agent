/**
 * I4 黑盒：CLI 端到端。
 *
 * 用真实的 CLI 入口、真实 SQLite、真实 git 仓库，跑一个 shell-only 工作流。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { Store } from '@spec-agent/core';

const SPEC = `name: shell-only
version: 1
params: []
nodes:
  - id: hello
    type: shell
    description: 打印一句话
    inputs: []
    outputs: []
    run: 'node -e "console.log(1)"'
edges: []
`;

function collector() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
    lines,
    errors,
  };
}

describe('I4: CLI', () => {
  it('init → run → status → events 全流程', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-cli-'));
    const specPath = join(root, 'shell.yaml');
    writeFileSync(specPath, SPEC);

    try {
      const init = collector();
      expect(await main(['init', '--root', root], init.io)).toBe(0);
      expect(init.lines.join('\n')).toContain('initialized');

      const run = collector();
      const code = await main(
        ['run', '--root', root, '--spec', specPath, '跑一个只含 shell 的流程'],
        run.io,
      );
      expect(run.errors).toEqual([]);
      expect(code).toBe(0);
      expect(run.lines.join('\n')).toContain('succeeded');
      expect(run.lines.join('\n')).toContain('node hello [succeeded]');

      const store = new Store({ path: join(root, '.spec-agent', 'spec-agent.db') });
      try {
        const tasks = store.listTasks(10);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.status).toBe('succeeded');
        const taskId = tasks[0]!.id;

        const status = collector();
        expect(await main(['status', '--root', root], status.io)).toBe(0);
        expect(status.lines.join('\n')).toContain(taskId);

        const events = collector();
        expect(await main(['events', '--root', root, taskId], events.io)).toBe(0);
        expect(events.lines.join('\n')).toContain('task.created');
        expect(events.lines.join('\n')).toContain('task.finished');
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('缺少 --spec 时返回非零并给出提示', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-cli-'));
    try {
      const io = collector();
      expect(await main(['run', '--root', root], io.io)).toBe(1);
      expect(io.errors.join('\n')).toContain('--spec');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
