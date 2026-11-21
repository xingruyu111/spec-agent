/**
 * I3 集成：git 适配器 + 真仓库。
 *
 * 证明：worktree 隔离、commit 包装器注入 trailer 并拦截越界写入、
 * checkpoint/reset、blame 能追回 task/node。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { GitCli, parseTrailers } from '@spec-agent/core';

const execFileAsync = promisify(execFile);

async function gitRun(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return String(stdout);
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-git-'));
  await gitRun(dir, ['init', '-q', '-b', 'main']);
  await gitRun(dir, ['config', 'user.name', 'Test']);
  await gitRun(dir, ['config', 'user.email', 'test@example.com']);
  // 避免 Windows 上 autocrlf 把 LF 改成 CRLF，导致内容断言不稳定
  await gitRun(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  await gitRun(dir, ['add', '.']);
  await gitRun(dir, ['commit', '-qm', 'init']);
  return dir;
}

async function withRepo(fn: (repo: string, root: string) => Promise<void>): Promise<void> {
  const repo = await makeRepo();
  const root = mkdtempSync(join(tmpdir(), 'hive-wt-'));
  try {
    await fn(repo, root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const author = { name: 'fe', email: 'fe@spec-agent.local' };

describe('I3: git 适配器', () => {
  it('initRepo 幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-git-init-'));
    try {
      const git = new GitCli();
      await git.initRepo(dir);
      await git.initRepo(dir);
      expect(existsSync(join(dir, '.git'))).toBe(true);
      expect((await gitRun(dir, ['log', '--format=%s'])).trim()).toBe('init');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  it('worktree 相互隔离，各自提交不影响对方', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const fe = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t1',
      });
      const be = await git.createWorktree({
        repo,
        worktree: join(root, 'be'),
        branch: 'agent/be/t1',
      });

      writeFileSync(join(fe.path, 'a.txt'), 'a\n');
      writeFileSync(join(be.path, 'b.txt'), 'b\n');

      expect(existsSync(join(repo, 'a.txt'))).toBe(false);

      const result = await git.commit({
        worktree: fe.path,
        message: 'feat: a',
        scope: ['.'],
        trailers: { 'Spec-Agent': 'fe', 'Spec-Agent-Task': 'task_1' },
        author,
      });
      expect(result.files).toBe(1);
      expect(result.insertions).toBe(1);

      expect(await git.head(fe.path)).toBe(result.commit);
      expect(await git.head(be.path)).toBe(be.baseCommit);
      expect(await git.head(repo)).toBe(fe.baseCommit);
    });
  });

  it('commit 注入 trailer，blame 能读回来', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t2',
      });
      writeFileSync(join(wt.path, 'src.ts'), 'export const a = 1;\n');

      const committed = await git.commit({
        worktree: wt.path,
        message: 'feat: 登录校验',
        scope: ['src.ts'],
        trailers: {
          'Spec-Agent': 'fe',
          'Spec-Agent-Parent-Agent': 'pm',
          'Spec-Agent-Task': 'task_7',
          'Spec-Agent-Node': 'implement',
        },
        author,
      });

      const blame = await git.blame({ dir: wt.path, path: 'src.ts', line: 1 });
      expect(blame.commit).toBe(committed.commit);
      expect(blame.author).toBe('fe');
      expect(blame.content).toBe('export const a = 1;');
      expect(blame.trailers).toMatchObject({
        'Spec-Agent': 'fe',
        'Spec-Agent-Task': 'task_7',
        'Spec-Agent-Node': 'implement',
        'Spec-Agent-Parent-Agent': 'pm',
      });

      const commits = await git.log(wt.path, 'HEAD', 10);
      expect(commits[0]).toMatchObject({
        hash: committed.commit,
        author: 'fe',
        subject: 'feat: 登录校验',
        trailers: {
          'Spec-Agent': 'fe',
          'Spec-Agent-Task': 'task_7',
          'Spec-Agent-Node': 'implement',
        },
      });

      const shown = await git.show(wt.path, committed.commit);
      expect(shown.patch).toContain('src.ts');
      expect(shown.patch).toContain('Spec-Agent-Task');
      expect(shown.files).toEqual([{ status: 'A', path: 'src.ts' }]);

      const content = await git.fileAt(wt.path, 'HEAD', 'src.ts');
      expect(content).toContain('export const a = 1;');

      const allBlame = await git.blameAll({
        dir: wt.path,
        path: 'src.ts',
        ref: 'HEAD',
      });
      expect(allBlame[0]).toMatchObject({
        line: 1,
        commit: committed.commit,
        author: 'fe',
        content: 'export const a = 1;',
      });

      const refBlame = await git.blame({
        dir: wt.path,
        path: 'src.ts',
        line: 1,
        ref: 'HEAD',
      });
      expect(refBlame.trailers['Spec-Agent-Task']).toBe('task_7');
    });
  });

  it('越界写入被拒绝，HEAD 不变', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t3',
      });
      writeFileSync(join(wt.path, 'src.ts'), 'ok\n');
      writeFileSync(join(wt.path, 'secret.env'), 'TOKEN=1\n');

      const before = await git.head(wt.path);
      await expect(
        git.commit({
          worktree: wt.path,
          message: 'feat: 越界',
          scope: ['src.ts'],
          trailers: { 'Spec-Agent-Task': 'task_1' },
          author,
        }),
      ).rejects.toMatchObject({ code: 'E_GIT_SCOPE' });

      expect(await git.head(wt.path)).toBe(before);
      expect(existsSync(join(wt.path, 'secret.env'))).toBe(true);
    });
  });

  it('没有改动时拒绝提交', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t4',
      });
      await expect(
        git.commit({
          worktree: wt.path,
          message: 'empty',
          scope: ['.'],
          trailers: {},
          author,
        }),
      ).rejects.toMatchObject({ code: 'E_GIT_NOTHING' });
    });
  });

  it('checkpoint 后 reset 能回到提交前', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t5',
      });
      const file = join(wt.path, 'a.txt');
      writeFileSync(file, 'first\n');
      await git.commit({
        worktree: wt.path,
        message: 'first',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 't' },
        author,
      });

      const checkpoint = await git.checkpoint(wt.path, 'refs/hive/cp/run_1/node_1/1');

      writeFileSync(file, 'second\n');
      await git.commit({
        worktree: wt.path,
        message: 'second',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 't' },
        author,
      });
      expect(readFileSync(file, 'utf8')).toBe('second\n');

      await git.resetHard(wt.path, checkpoint);
      expect(readFileSync(file, 'utf8')).toBe('first\n');
      expect(await git.head(wt.path)).toBe(checkpoint);
    });
  });

  it('worktree 路径冲突会显式报错', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const path = join(root, 'fe');
      await git.createWorktree({ repo, worktree: path, branch: 'agent/fe/t6' });
      await expect(
        git.createWorktree({ repo, worktree: path, branch: 'agent/fe/t6b' }),
      ).rejects.toMatchObject({ code: 'E_GIT_WORKTREE_EXISTS' });
    });
  });

  it('removeWorktree 之后目录消失', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'tmp'),
        branch: 'agent/fe/t7',
      });
      await git.removeWorktree({ repo, worktree: wt.path });
      expect(existsSync(wt.path)).toBe(false);
    });
  });

  it('git 命令失败时抛出带 stderr 的 E_GIT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-not-repo-'));
    try {
      await expect(new GitCli().head(dir)).rejects.toMatchObject({ code: 'E_GIT' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('允许空提交，统计为 0 个文件', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t8',
      });
      const before = await git.head(wt.path);
      const result = await git.commit({
        worktree: wt.path,
        message: 'chore: 空提交',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 't' },
        author,
        allowEmpty: true,
      });
      expect(result.files).toBe(0);
      expect(await git.head(wt.path)).toBe(result.commit);
      expect(result.commit).not.toBe(before);
    });
  });

  it('重命名文件也能通过范围检查', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const wt = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t9',
      });
      writeFileSync(join(wt.path, 'old.ts'), 'export const a = 1;\n');
      await git.commit({
        worktree: wt.path,
        message: 'add',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 't' },
        author,
      });

      renameSync(join(wt.path, 'old.ts'), join(wt.path, 'new.ts'));
      const renamed = await git.commit({
        worktree: wt.path,
        message: 'rename',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 't' },
        author,
      });
      expect(renamed.files).toBeGreaterThanOrEqual(1);
    });
  });

  it('merge 把子分支合入目标工作区，并留下合并提交', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const fe = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t1',
      });
      const be = await git.createWorktree({
        repo,
        worktree: join(root, 'be'),
        branch: 'agent/be/t1',
      });

      writeFileSync(join(fe.path, 'fe.txt'), 'fe\n');
      await git.commit({
        worktree: fe.path,
        message: 'fe',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 'fe' },
        author,
      });
      writeFileSync(join(be.path, 'be.txt'), 'be\n');
      await git.commit({
        worktree: be.path,
        message: 'be',
        scope: ['.'],
        trailers: { 'Spec-Agent-Task': 'be' },
        author,
      });

      const first = await git.merge({
        worktree: repo,
        branch: 'agent/fe/t1',
        message: 'merge fe',
        trailers: { 'Spec-Agent-Merged-Agent': 'fe' },
        author,
      });
      expect(first.alreadyUpToDate).toBe(false);

      const second = await git.merge({
        worktree: repo,
        branch: 'agent/be/t1',
        message: 'merge be',
        trailers: { 'Spec-Agent-Merged-Agent': 'be' },
        author,
      });
      expect(second.alreadyUpToDate).toBe(false);

      expect(existsSync(join(repo, 'fe.txt'))).toBe(true);
      expect(existsSync(join(repo, 'be.txt'))).toBe(true);

      const log = await gitRun(repo, ['log', '-1', '--format=%B']);
      expect(log).toContain('Spec-Agent-Merged-Agent: be');

      const again = await git.merge({
        worktree: repo,
        branch: 'agent/be/t1',
        message: 'merge be again',
        trailers: {},
        author,
      });
      expect(again.alreadyUpToDate).toBe(true);
    });
  });

  it('冲突时用 resolver 解决并完成合并提交', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const fe = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t10',
      });
      const be = await git.createWorktree({
        repo,
        worktree: join(root, 'be'),
        branch: 'agent/be/t10',
      });

      writeFileSync(join(fe.path, 'README.md'), 'fe version\n');
      await git.commit({
        worktree: fe.path,
        message: 'fe',
        scope: ['.'],
        trailers: {},
        author,
      });
      writeFileSync(join(be.path, 'README.md'), 'be version\n');
      await git.commit({
        worktree: be.path,
        message: 'be',
        scope: ['.'],
        trailers: {},
        author,
      });

      await git.merge({
        worktree: repo,
        branch: 'agent/fe/t10',
        message: 'merge fe',
        trailers: {},
        author,
      });

      const merged = await git.merge({
        worktree: repo,
        branch: 'agent/be/t10',
        message: 'merge be',
        trailers: { 'Spec-Agent-Merged-Agent': 'be' },
        author,
        resolveConflicts: async ({ worktree, files }) => {
          expect(files).toEqual(['README.md']);
          writeFileSync(join(worktree, 'README.md'), 'resolved\n');
          return true;
        },
      });

      expect(merged.alreadyUpToDate).toBe(false);
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('resolved\n');

      const parents = (await gitRun(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']))
        .trim()
        .split(' ');
      expect(parents).toHaveLength(3); // merge commit + 两个父提交

      const log = await gitRun(repo, ['log', '-1', '--format=%B']);
      expect(log).toContain('Spec-Agent-Merged-Agent: be');

      const status = await gitRun(repo, ['status', '--porcelain']);
      expect(status.trim()).toBe('');
    });
  });

  it('resolver 返回 false 时中止合并，工作区保持干净', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const fe = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t11',
      });
      const be = await git.createWorktree({
        repo,
        worktree: join(root, 'be'),
        branch: 'agent/be/t11',
      });

      writeFileSync(join(fe.path, 'README.md'), 'fe version\n');
      await git.commit({
        worktree: fe.path,
        message: 'fe',
        scope: ['.'],
        trailers: {},
        author,
      });
      writeFileSync(join(be.path, 'README.md'), 'be version\n');
      await git.commit({
        worktree: be.path,
        message: 'be',
        scope: ['.'],
        trailers: {},
        author,
      });

      await git.merge({
        worktree: repo,
        branch: 'agent/fe/t11',
        message: 'merge fe',
        trailers: {},
        author,
      });

      await expect(
        git.merge({
          worktree: repo,
          branch: 'agent/be/t11',
          message: 'merge be',
          trailers: {},
          author,
          resolveConflicts: async () => false,
        }),
      ).rejects.toMatchObject({ code: 'E_GIT_MERGE_CONFLICT' });

      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('fe version\n');
      const status = await gitRun(repo, ['status', '--porcelain']);
      expect(status.trim()).toBe('');
    });
  });

  it('merge 冲突时中止，不留下 MERGE_HEAD', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      const fe = await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t2',
      });
      const be = await git.createWorktree({
        repo,
        worktree: join(root, 'be'),
        branch: 'agent/be/t2',
      });

      writeFileSync(join(fe.path, 'README.md'), 'fe version\n');
      await git.commit({
        worktree: fe.path,
        message: 'fe',
        scope: ['.'],
        trailers: {},
        author,
      });
      writeFileSync(join(be.path, 'README.md'), 'be version\n');
      await git.commit({
        worktree: be.path,
        message: 'be',
        scope: ['.'],
        trailers: {},
        author,
      });

      await git.merge({
        worktree: repo,
        branch: 'agent/fe/t2',
        message: 'merge fe',
        trailers: {},
        author,
      });

      await expect(
        git.merge({
          worktree: repo,
          branch: 'agent/be/t2',
          message: 'merge be',
          trailers: {},
          author,
        }),
      ).rejects.toMatchObject({ code: 'E_GIT_MERGE_CONFLICT' });

      const status = await gitRun(repo, ['status', '--porcelain']);
      expect(status.trim()).toBe('');
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('fe version\n');
    });
  });

  it('目标工作区有未提交改动时拒绝合并', async () => {
    await withRepo(async (repo, root) => {
      const git = new GitCli();
      await git.createWorktree({
        repo,
        worktree: join(root, 'fe'),
        branch: 'agent/fe/t3',
      });
      writeFileSync(join(repo, 'dirty.txt'), 'x\n');

      await expect(
        git.merge({
          worktree: repo,
          branch: 'agent/fe/t3',
          message: 'merge',
          trailers: {},
          author,
        }),
      ).rejects.toMatchObject({ code: 'E_GIT_DIRTY_TARGET' });
    });
  });

  it('fileBufferAt 保留二进制字节，不经过 UTF-8 截断', async () => {
    await withRepo(async (repo) => {
      const bytes = Buffer.from([0, 255, 1, 128, 10, 13, 42]);
      writeFileSync(join(repo, 'asset.bin'), bytes);
      await gitRun(repo, ['add', 'asset.bin']);
      await gitRun(repo, ['commit', '-qm', 'asset']);
      const git = new GitCli();
      const head = await git.head(repo);
      const actual = await git.fileBufferAt(repo, head, 'asset.bin');
      expect(actual.equals(bytes)).toBe(true);
    });
  });

  it('parseTrailers 忽略结尾空行，且不误吞正文', () => {
    expect(parseTrailers('feat: x\n\nSpec-Agent-Task: t1\nSpec-Agent: fe\n\n')).toEqual({
      'Spec-Agent-Task': 't1',
      'Spec-Agent': 'fe',
    });
    expect(parseTrailers('subject\n\nbody line\nSpec-Agent-Task: t1')).toEqual({});
  });
});
