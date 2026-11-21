/**
 * I3+：engine × git —— 每个任务一个 worktree，节点成功后自动提交并带 trailer。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { AgentId, WorkflowSpec } from '@spec-agent/schema';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
  Planner,
  ShellResult,
  ShellRunner,
} from '@spec-agent/core';
import { Engine, GitCli, Store, specHash } from '@spec-agent/core';
import { createIdFactory, type Clock } from '@spec-agent/kernel';

const execFileAsync = promisify(execFile);

const clock: Clock = {
  now: () => Date.parse('2026-10-26T00:00:00.000Z'),
  iso: (at = Date.parse('2026-10-26T00:00:00.000Z')) => new Date(at).toISOString(),
  sleep: async () => {},
};

async function gitRun(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return String(stdout);
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-engine-git-'));
  await gitRun(dir, ['init', '-q', '-b', 'main']);
  await gitRun(dir, ['config', 'user.name', 'Test']);
  await gitRun(dir, ['config', 'user.email', 'test@example.com']);
  await gitRun(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  await gitRun(dir, ['add', '.']);
  await gitRun(dir, ['commit', '-qm', 'init']);
  return dir;
}

class WritingRuntime implements AgentRuntime {
  readonly id = 'writing';
  async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    mkdirSync(join(input.cwd, 'src'), { recursive: true });
    writeFileSync(join(input.cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    return {
      outputs: [{ name: 'a', kind: 'file', path: 'src/a.ts' }],
      transcriptRef: 't',
      usage: { usd: 0.1 },
      stopReason: 'finished',
    };
  }
}

class OkShell implements ShellRunner {
  async run(): Promise<ShellResult> {
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
  }
}

/** 子任务优先执行绑定的 spec；没有绑定时退回父 spec。 */
function plannerFor(store: Store, spec: WorkflowSpec): Planner {
  return {
    async plan(task) {
      const boundId = store.getSpecIdForTask(task.id);
      const bound = boundId ? store.getSpec(boundId) : undefined;
      return { spec: bound ?? spec };
    },
  };
}

describe('engine × git', { timeout: 15_000 }, () => {
  it('session 模式记录节点前后 Git checkpoint', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-checkpoint-'));
    const store = new Store({ path: ':memory:', clock });
    const spec: WorkflowSpec = {
      name: 'checkpoint-flow',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'implement' as never,
          type: 'llm',
          description: '写文件',
          inputs: [],
          outputs: [{ name: 'a', kind: 'file', path: 'src/a.ts' }],
          tools: [],
        },
      ],
      edges: [],
    };
    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime: new WritingRuntime(),
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      executionMode: 'session',
    });
    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_01' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '写文件',
        brief: '',
      });
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const node = store.listNodeRuns(run.id)[0]!;
      expect(node.checkpointBefore).toMatch(/^refs\/spec-agent\/checkpoints\//);
      expect(node.checkpointAfter).toMatch(/^refs\/spec-agent\/checkpoints\//);
      expect(node.checkpointBefore).not.toBe(node.checkpointAfter);
      await gitRun(repo, ['show-ref', '--verify', node.checkpointBefore!]);
      await gitRun(repo, ['show-ref', '--verify', node.checkpointAfter!]);

      const worktree = join(worktreeRoot, 'task_01');
      expect(existsSync(join(worktree, 'src/a.ts'))).toBe(true);
      await engine.restoreNodeCheckpoint('task_01', node.id, 'before');
      expect(existsSync(join(worktree, 'src/a.ts'))).toBe(false);
      expect(store.getNodeRun(node.id)?.transcriptRef).toBeNull();
      expect(store.getNodeRun(node.id)?.sessionKey).toBeNull();
      await engine.restoreNodeCheckpoint('task_01', node.id, 'after');
      expect(existsSync(join(worktree, 'src/a.ts'))).toBe(true);
      await expect(
        engine.restoreNodeCheckpoint('missing-task', node.id, 'before'),
      ).rejects.toMatchObject({ code: 'E_TASK_NOT_FOUND' });
      await expect(
        engine.restoreNodeCheckpoint('task_01', 'missing-node', 'before'),
      ).rejects.toMatchObject({ code: 'E_NODE_NOT_FOUND' });
      rmSync(worktree, { recursive: true, force: true });
      await expect(
        engine.restoreNodeCheckpoint('task_01', node.id, 'before'),
      ).rejects.toMatchObject({ code: 'E_CHECKPOINT_NO_WORKTREE' });
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('节点指定其他 agent 时自动开子任务并合并', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-engine-'));
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'git-flow',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'implement' as never,
          type: 'llm',
          description: '写一个文件',
          inputs: [],
          outputs: [{ name: 'a', kind: 'file', path: 'src/a.ts' }],
          tools: ['edit_file'],
          agent: 'fe' as AgentId,
        },
      ],
      edges: [],
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime: new WritingRuntime(),
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      agents: [
        {
          id: 'pm' as AgentId,
          name: 'PM',
          parent: null,
          role: 'PM',
          model: { provider: 'inherit', model: 'inherit' },
          skills: [],
          tools: { allow: ['edit_file'] },
          workspace: { writeScope: ['src/'] },
        },
        {
          id: 'fe' as AgentId,
          name: 'FE',
          parent: 'pm' as AgentId,
          role: 'FE',
          model: { provider: 'inherit', model: 'inherit' },
          skills: [],
          tools: { allow: ['edit_file'] },
          workspace: { writeScope: ['src/'] },
        },
      ],
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_01' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '写文件',
        brief: '写一个文件',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_01')?.status).toBe('succeeded');

      const worktree = join(worktreeRoot, 'task_01');
      expect(existsSync(join(worktree, 'src', 'a.ts'))).toBe(true);

      const body = await gitRun(worktree, ['log', '-1', '--format=%B']);
      expect(body).toContain('Spec-Agent-Merged-Agent: fe');
      expect(body).toContain('Spec-Agent: pm');
      expect(body).toContain('Spec-Agent-Merged-Task:');

      const children = store.listChildTasks('task_01');
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ assignee: 'fe', status: 'succeeded' });

      const git = new GitCli();
      const blame = await git.blame({ dir: worktree, path: 'src/a.ts', line: 1 });
      expect(blame.trailers['Spec-Agent-Task']).toBe(children[0]!.id);
      expect(blame.author).toBe('fe');

      // 主仓库没有被直接改动
      expect(existsSync(join(repo, 'src', 'a.ts'))).toBe(false);
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('同 agent 的独立节点各开 worktree 并合并回父任务', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-same-agent-'));
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'same-agent-files',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'a' as never,
          type: 'llm',
          description: '写 A',
          inputs: [],
          outputs: [{ name: 'a.txt', kind: 'file', path: 'a.txt' }],
          tools: ['edit_file'],
          writeScope: ['.'],
        },
        {
          id: 'b' as never,
          type: 'llm',
          description: '写 B',
          inputs: [],
          outputs: [{ name: 'b.txt', kind: 'file', path: 'b.txt' }],
          tools: ['edit_file'],
          writeScope: ['.'],
        },
      ],
      edges: [],
    };

    const runtime: AgentRuntime = {
      id: 'files',
      async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
        const file = input.task.includes('写 A') ? 'a.txt' : 'b.txt';
        writeFileSync(join(input.cwd, file), `${file}\n`);
        return {
          outputs: [{ name: file, kind: 'file', path: file }],
          transcriptRef: 't',
          usage: { usd: 0.01 },
          stopReason: 'finished',
        };
      },
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime,
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      isolateNodes: true,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_same_agent' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '同 agent 文件',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_same_agent')?.status).toBe('succeeded');
      const children = store.listChildTasks('task_same_agent');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.assignee === 'pm')).toBe(true);

      const parentWorktree = join(worktreeRoot, 'task_same_agent');
      expect(existsSync(join(parentWorktree, 'a.txt'))).toBe(true);
      expect(existsSync(join(parentWorktree, 'b.txt'))).toBe(true);

      const subjects = (await gitRun(parentWorktree, ['log', '--format=%s']))
        .trim()
        .split('\n');
      expect(subjects.filter((subject) => subject.startsWith('Merge pm'))).toHaveLength(2);
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('shell 节点在独立 worktree 执行并合并', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-shell-iso-'));
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'shell-isolate',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'sh-a' as never,
          type: 'shell',
          description: '写 shell a',
          inputs: [],
          outputs: [{ name: 'a', kind: 'file', path: 'shell-a.txt' }],
          run: 'write-a',
        },
        {
          id: 'sh-b' as never,
          type: 'shell',
          description: '写 shell b',
          inputs: [],
          outputs: [{ name: 'b', kind: 'file', path: 'shell-b.txt' }],
          run: 'write-b',
        },
      ],
      edges: [],
    };

    const calls: string[] = [];
    const shell: ShellRunner = {
      async run(input) {
        calls.push(input.cwd);
        const file = input.command.includes('a') ? 'shell-a.txt' : 'shell-b.txt';
        writeFileSync(join(input.cwd, file), `${file}\n`);
        return {
          exitCode: 0,
          stdout: `wrote ${file}`,
          stderr: '',
          durationMs: 1,
          timedOut: false,
        };
      },
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime: new WritingRuntime(),
      shell,
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      isolateNodes: true,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_shell_iso' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: 'shell 隔离',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_shell_iso')?.status).toBe('succeeded');
      const children = store.listChildTasks('task_shell_iso');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.assignee === 'pm')).toBe(true);
      expect(
        children.every(
          (child) => store.listChildTasks(child.id).length === 0,
        ),
      ).toBe(true);

      const parentWorktree = join(worktreeRoot, 'task_shell_iso');
      expect(calls).toHaveLength(2);
      expect(calls.includes(parentWorktree)).toBe(false);
      expect(existsSync(join(parentWorktree, 'shell-a.txt'))).toBe(true);
      expect(existsSync(join(parentWorktree, 'shell-b.txt'))).toBe(true);

      const subjects = (await gitRun(parentWorktree, ['log', '--format=%s']))
        .trim()
        .split('\n');
      expect(subjects.filter((subject) => subject.startsWith('Merge pm'))).toHaveLength(2);
      expect(store.listMerges('task_shell_iso')).toHaveLength(2);
      expect(
        store.listMerges('task_shell_iso').every((merge) => merge.status === 'merged'),
      ).toBe(true);
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 20_000);

  it('合并冲突会重试 resolver，并记录 merge queue', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-merge-retry-'));
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'merge-retry',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'a' as never,
          type: 'llm',
          description: '写 A',
          inputs: [],
          outputs: [{ name: 'shared', kind: 'file', path: 'shared.txt' }],
          tools: ['edit_file'],
          writeScope: ['.'],
        },
        {
          id: 'b' as never,
          type: 'llm',
          description: '写 B',
          inputs: [],
          outputs: [{ name: 'shared', kind: 'file', path: 'shared.txt' }],
          tools: ['edit_file'],
          writeScope: ['.'],
        },
      ],
      edges: [],
    };

    const runtime: AgentRuntime = {
      id: 'shared-file',
      async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
        const content = input.task.includes('写 A') ? 'A\n' : 'B\n';
        writeFileSync(join(input.cwd, 'shared.txt'), content);
        return {
          outputs: [{ name: 'shared', kind: 'file', path: 'shared.txt' }],
          transcriptRef: 't',
          usage: { usd: 0.01 },
          stopReason: 'finished',
        };
      },
    };

    let resolverCalls = 0;
    const ids = createIdFactory({ clock, random: () => new Uint8Array(10) });
    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime,
      shell: new OkShell(),
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      isolateNodes: true,
      mergeAttempts: 2,
      mergeRetryDelayMs: 1,
      conflictResolver: async ({ worktree }) => {
        resolverCalls += 1;
        if (resolverCalls === 1) return false;
        writeFileSync(join(worktree, 'shared.txt'), 'merged\n');
        return true;
      },
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_merge' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '合并重试',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_merge')?.status).toBe('succeeded');
      expect(resolverCalls).toBe(2);
      const parentWorktree = join(worktreeRoot, 'task_merge');
      expect(readFileSync(join(parentWorktree, 'shared.txt'), 'utf8')).toBe(
        'merged\n',
      );

      const merges = store.listMerges('task_merge');
      expect(merges).toHaveLength(2);
      expect(merges.some((merge) => merge.attempts === 1)).toBe(true);
      expect(merges.every((merge) => merge.status === 'merged')).toBe(true);

      const failingEngine = new Engine({
        store,
        planner: plannerFor(store, spec),
        runtime,
        shell: new OkShell(),
        clock,
        ids,
        provider: { id: 'fake' },
        model: 'fake',
        workspaceRoot: repo,
        git: new GitCli(),
        repoPath: repo,
        worktreeRoot,
        isolateNodes: true,
        mergeAttempts: 1,
        mergeRetryDelayMs: 0,
        conflictResolver: async () => false,
      });
      failingEngine.dispatch({
        type: 'task.create',
        taskId: 'task_merge_fail' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '合并失败',
        brief: '',
      });
      await failingEngine.runUntilIdle();

      expect(store.getTask('task_merge_fail')?.status).toBe('failed');
      const failedMerges = store.listMerges('task_merge_fail');
      const failedMerge = failedMerges.find(
        (merge) => merge.status === 'failed',
      )!;
      expect(failedMerge.attempts).toBe(1);

      await failingEngine.retryNode(
        'task_merge_fail' as never,
        failedMerge.nodeRunId as never,
        '重试合并',
      );
      expect(store.getTask('task_merge_fail')?.status).toBe('failed');
      expect(store.getMerge(failedMerge.nodeRunId)?.attempts).toBe(2);
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 20_000);

  it('cleanupWorktrees 删除工作区但保留分支', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-clean-'));
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'cleanup',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'implement' as never,
          type: 'llm',
          description: '写文件',
          inputs: [],
          outputs: [{ name: 'a', kind: 'file', path: 'src/a.ts' }],
          tools: ['edit_file'],
          writeScope: ['src/'],
        },
      ],
      edges: [],
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime: new WritingRuntime(),
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      cleanupWorktrees: true,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_clean' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '清理测试',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_clean')?.status).toBe('succeeded');
      expect(existsSync(join(worktreeRoot, 'task_clean'))).toBe(false);

      const branch = await gitRun(repo, ['branch', '--list', 'agent/pm/task_clean']);
      expect(branch).toContain('agent/pm/task_clean');
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('没有 worktreeRoot 时 cleanup 安全跳过', async () => {
    const repo = await makeRepo();
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'no-worktree',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'noop' as never,
          type: 'shell',
          description: '空命令',
          inputs: [],
          outputs: [],
          run: 'node -e "process.exit(0)"',
        },
      ],
      edges: [],
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime: new WritingRuntime(),
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      cleanupWorktrees: true,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_no_worktree' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '无工作区',
        brief: '',
      });
      await engine.runUntilIdle();
      expect(store.getTask('task_no_worktree')?.status).toBe('succeeded');
    } finally {
      store.close();
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('取消任务时 cleanupWorktrees 也会删除工作区', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-cancel-'));
    const store = new Store({ path: ':memory:', clock });

    const spec: WorkflowSpec = {
      name: 'cancel-clean',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'wait' as never,
          type: 'shell',
          description: '等待审批',
          inputs: [],
          outputs: [],
          run: 'node -e "console.log(1)"',
          approval: { approvers: ['human'] },
        },
      ],
      edges: [],
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime: new WritingRuntime(),
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
      cleanupWorktrees: true,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_cancel_clean' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '取消清理',
        brief: '',
      });
      await engine.runUntilIdle();
      expect(store.getTask('task_cancel_clean')?.status).toBe('waiting_gate');
      expect(existsSync(join(worktreeRoot, 'task_cancel_clean'))).toBe(true);

      engine.cancelTask('task_cancel_clean' as never, '不做了');

      for (let i = 0; i < 50; i += 1) {
        if (!existsSync(join(worktreeRoot, 'task_cancel_clean'))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(existsSync(join(worktreeRoot, 'task_cancel_clean'))).toBe(false);

      const branch = await gitRun(repo, [
        'branch',
        '--list',
        'agent/pm/task_cancel_clean',
      ]);
      expect(branch).toContain('agent/pm/task_cancel_clean');
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('无改动与 autoCommit:false 的节点不会产生提交', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-engine-'));
    const store = new Store({ path: ':memory:', clock });

    let calls = 0;
    const runtime: AgentRuntime = {
      id: 'counting',
      async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
        calls += 1;
        mkdirSync(join(input.cwd, 'src'), { recursive: true });
        writeFileSync(join(input.cwd, 'src', `${calls}.ts`), 'export const x = 1;\n');
        return {
          outputs: [{ name: 'f', kind: 'file', path: `src/${calls}.ts` }],
          transcriptRef: 't',
          usage: { usd: 0.1 },
          stopReason: 'finished',
        };
      },
    };

    const spec: WorkflowSpec = {
      name: 'mixed',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'noop' as never,
          type: 'shell',
          description: '什么都不做',
          inputs: [],
          outputs: [],
          run: 'true',
        },
        {
          id: 'write' as never,
          type: 'llm',
          description: '写一个文件',
          inputs: [],
          outputs: [{ name: 'f', kind: 'file', path: 'src/1.ts' }],
          tools: ['edit_file'],
          writeScope: ['src/'],
        },
        {
          id: 'scratch' as never,
          type: 'llm',
          description: '写草稿但不提交',
          inputs: [],
          outputs: [{ name: 'f', kind: 'file', path: 'src/2.ts' }],
          tools: ['edit_file'],
          writeScope: ['src/'],
          autoCommit: false,
        },
      ],
      edges: [
        { from: 'noop' as never, to: 'write' as never },
        { from: 'write' as never, to: 'scratch' as never },
      ],
    };

    const engine = new Engine({
      store,
      planner: plannerFor(store, spec),
      runtime,
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_02' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '混合提交',
        brief: '测试',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_02')?.status).toBe('succeeded');
      const worktree = join(worktreeRoot, 'task_02');
      // 只有 write 节点产生提交（init + 1）
      const log = await gitRun(worktree, ['log', '--oneline']);
      expect(log.trim().split('\n')).toHaveLength(2);
      // scratch 的文件留在工作区但没提交
      const status = await gitRun(worktree, ['status', '--porcelain']);
      expect(status).toContain('src/2.ts');
      expect(status).not.toContain('src/1.ts');
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('delegate 成功后把子分支合入父工作区', async () => {
    const repo = await makeRepo();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'hive-wt-merge-'));
    const store = new Store({ path: ':memory:', clock });

    const pmSpec: WorkflowSpec = {
      name: 'pm',
      version: 1,
      params: [],
      nodes: [
        {
          id: 'fe' as never,
          type: 'delegate',
          description: '前端',
          inputs: [],
          outputs: [],
          agent: 'fe' as AgentId,
          brief: '写前端',
        },
        {
          id: 'be' as never,
          type: 'delegate',
          description: '后端',
          inputs: [],
          outputs: [],
          agent: 'be' as AgentId,
          brief: '写后端',
        },
      ],
      edges: [],
    };
    const childSpec = (name: string, description: string, dir: string): WorkflowSpec => ({
      name,
      version: 1,
      params: [],
      nodes: [
        {
          id: 'implement' as never,
          type: 'llm',
          description,
          inputs: [],
          outputs: [{ name: 'out', kind: 'file', path: `${dir}/out` }],
          tools: ['Write'],
          writeScope: [`${dir}/`],
        },
      ],
      edges: [],
    });

    const runtime: AgentRuntime = {
      id: 'multi-writing',
      async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
        const isFe = input.task.includes('前端');
        // FE 故意更慢：验证合并顺序按 spec，而不是按完成顺序
        await new Promise((resolve) => setTimeout(resolve, isFe ? 80 : 5));
        const rel = isFe ? 'frontend/login.html' : 'backend/login.ts';
        const abs = join(input.cwd, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, isFe ? '<html>fe</html>\n' : 'export const be = 1;\n');
        return {
          outputs: [{ name: basename(rel), kind: 'file', path: rel }],
          transcriptRef: 't',
          usage: { usd: 0.01 },
          stopReason: 'finished',
        };
      },
    };

    const engine = new Engine({
      store,
      planner: {
        plan: async (task) => ({
          spec:
            task.assignee === 'fe'
              ? childSpec('fe', '前端实现', 'frontend')
              : task.assignee === 'be'
                ? childSpec('be', '后端实现', 'backend')
                : pmSpec,
        }),
      },
      runtime,
      shell: new OkShell(),
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: repo,
      git: new GitCli(),
      repoPath: repo,
      worktreeRoot,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: 'task_pm' as never,
        assignee: 'pm' as AgentId,
        caller: null,
        title: '登录功能',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_pm')?.status).toBe('succeeded');
      const children = store.listChildTasks('task_pm');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.status === 'succeeded')).toBe(true);

      const pmWorktree = join(worktreeRoot, 'task_pm');
      expect(existsSync(join(pmWorktree, 'frontend/login.html'))).toBe(true);
      expect(existsSync(join(pmWorktree, 'backend/login.ts'))).toBe(true);

      const log = await gitRun(pmWorktree, ['log', '--format=%B']);
      expect(log).toContain('Spec-Agent-Merged-Agent: fe');
      expect(log).toContain('Spec-Agent-Merged-Agent: be');
      expect(log).toContain('Spec-Agent-Task: task_pm');

      // FE 完成得更晚，但仍应先合并；BE 后合并，所以在 log 里更新
      const subjects = (await gitRun(pmWorktree, ['log', '--format=%s']))
        .trim()
        .split('\n');
      const beIndex = subjects.findIndex((line) => line.startsWith('Merge be'));
      const feIndex = subjects.findIndex((line) => line.startsWith('Merge fe'));
      expect(feIndex).toBeGreaterThanOrEqual(0);
      expect(beIndex).toBeGreaterThanOrEqual(0);
      expect(beIndex).toBeLessThan(feIndex);

      // merge 不改变行归属：合并后的文件仍能 blame 回具体 agent
      const git = new GitCli();
      const feBlame = await git.blame({
        dir: pmWorktree,
        path: 'frontend/login.html',
        line: 1,
      });
      expect(feBlame.trailers['Spec-Agent']).toBe('fe');
      const beBlame = await git.blame({
        dir: pmWorktree,
        path: 'backend/login.ts',
        line: 1,
      });
      expect(beBlame.trailers['Spec-Agent']).toBe('be');
    } finally {
      store.close();
      rmSync(worktreeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

