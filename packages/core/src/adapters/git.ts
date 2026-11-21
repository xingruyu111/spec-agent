/**
 * git CLI 适配器。
 *
 * 为什么直接调 CLI：封装库迟早会挡住某个参数；
 * 这里只允许通过包装器提交，保证 trailer 一定被注入。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '@spec-agent/kernel';
import type {
  BlameEntry,
  BlameLine,
  CommitFile,
  CommitInfo,
  CommitRequest,
  CommitResult,
  GitService,
  MergeRequest,
  MergeResult,
  WorktreeHandle,
  WorktreeRequest,
} from '../ports/git.js';

const execFileAsync = promisify(execFile);

type GitOptions = { cwd: string; input?: string };

async function git(options: GitOptions, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: options.cwd,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout);
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    throw new AppError('E_GIT', `git ${args.join(' ')} 失败`, {
      cause: error,
      details: { stderr: stderr.slice(0, 2000) },
    });
  }
}

export class GitCli implements GitService {
  async initRepo(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, '.git'))) return;

    await git({ cwd: dir }, ['init', '-q', '-b', 'main']);
    await git({ cwd: dir }, ['config', 'user.name', 'spec-agent']);
    await git({ cwd: dir }, ['config', 'user.email', 'spec-agent@localhost']);
    await git({ cwd: dir }, ['config', 'core.autocrlf', 'false']);
    if (!existsSync(join(dir, 'README.md'))) {
      writeFileSync(join(dir, 'README.md'), '# Spec Agent project\n');
    }
    await git({ cwd: dir }, ['add', '.']);
    await git({ cwd: dir }, ['commit', '-qm', 'init']);
  }

  async createWorktree(input: WorktreeRequest): Promise<WorktreeHandle> {
    if (existsSync(input.worktree)) {
      throw new AppError('E_GIT_WORKTREE_EXISTS', `worktree 路径已存在：${input.worktree}`);
    }
    const base = input.base ?? (await this.head(input.repo));
    await git({ cwd: input.repo }, [
      'worktree',
      'add',
      '-b',
      input.branch,
      input.worktree,
      base,
    ]);
    return { path: input.worktree, branch: input.branch, baseCommit: base };
  }

  async removeWorktree(input: {
    repo: string;
    worktree: string;
    force?: boolean;
  }): Promise<void> {
    const args = ['worktree', 'remove'];
    if (input.force !== false) args.push('--force');
    args.push(input.worktree);
    await git({ cwd: input.repo }, args);
  }

  async head(dir: string): Promise<string> {
    return (await git({ cwd: dir }, ['rev-parse', 'HEAD'])).trim();
  }

  async commit(input: CommitRequest): Promise<CommitResult> {
    const changed = await this.changedPaths(input.worktree);
    if (changed.length === 0 && !input.allowEmpty) {
      throw new AppError('E_GIT_NOTHING', '没有可提交的改动');
    }

    const outside = changed.filter((path) => !withinScope(path, input.scope));
    if (outside.length > 0) {
      throw new AppError('E_GIT_SCOPE', '提交超出允许的路径范围', {
        details: { outside },
      });
    }

    await git({ cwd: input.worktree }, ['add', '-A']);

    const trailerLines = Object.entries(input.trailers).map(([key, value]) => `${key}: ${value}`);
    const message = trailerLines.length > 0
      ? `${input.message}\n\n${trailerLines.join('\n')}\n`
      : input.message;

    const args = [
      '-c',
      `user.name=${input.author.name}`,
      '-c',
      `user.email=${input.author.email}`,
      'commit',
      '-m',
      message,
    ];
    if (input.allowEmpty) args.push('--allow-empty');
    await git({ cwd: input.worktree }, args);

    const commit = (await git({ cwd: input.worktree }, ['rev-parse', 'HEAD'])).trim();
    const stats = await this.stats(input.worktree, commit);
    return { commit, ...stats };
  }

  async checkpoint(dir: string, ref: string): Promise<string> {
    const head = await this.head(dir);
    await git({ cwd: dir }, ['update-ref', ref, head]);
    return head;
  }

  async resetHard(dir: string, commit: string): Promise<void> {
    await git({ cwd: dir }, ['reset', '--hard', commit]);
  }

  async clean(dir: string): Promise<void> {
    await git({ cwd: dir }, ['clean', '-fd']);
  }

  async log(dir: string, ref: string, limit = 50): Promise<CommitInfo[]> {
    const raw = await git({ cwd: dir }, [
      'log',
      `-n${limit}`,
      '--format=%H%x1f%an%x1f%ad%x1f%s%x1f%b%x1e',
      '--date=iso',
      ref,
    ]);
    return raw
      .split('\x1e')
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record) => {
        const fields = record.split('\x1f');
        const [hash = '', author = '', date = '', subject = ''] = fields;
        const body = fields.slice(4).join('\x1f');
        return {
          hash,
          author,
          date,
          subject,
          trailers: parseTrailers(body),
        };
      });
  }

  async show(dir: string, commit: string): Promise<{ patch: string; files: CommitFile[] }> {
    const raw = await git({ cwd: dir }, [
      'show',
      '--format=fuller',
      '--patch',
      '--stat',
      commit,
    ]);
    const nameStatus = await (async () => {
      try {
        // merge commit 的 git show 默认不输出文件；用 first-parent diff 拿合并结果
        return await git({ cwd: dir }, [
          'diff',
          '--name-status',
          `${commit}^1`,
          commit,
        ]);
      } catch {
        return await git({ cwd: dir }, [
          'show',
          '--name-status',
          '--format=',
          commit,
        ]);
      }
    })();

    const files: CommitFile[] = [];
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const [status = '', ...rest] = line.split('\t');
      const path = rest.at(-1);
      if (path) files.push({ status: status.slice(0, 1), path });
    }

    return { patch: raw.slice(0, 200_000), files };
  }

  async fileAt(dir: string, ref: string, path: string): Promise<string> {
    const raw = await git({ cwd: dir }, ['show', `${ref}:${path}`]);
    return raw.slice(0, 500_000);
  }

  async fileBufferAt(dir: string, ref: string, path: string): Promise<Buffer> {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${path}`], {
      cwd: dir,
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return Buffer.from(stdout);
  }

  async blameAll(input: {
    dir: string;
    path: string;
    ref: string;
  }): Promise<BlameLine[]> {
    const raw = await git({ cwd: input.dir }, [
      'blame',
      '--line-porcelain',
      input.ref,
      '--',
      input.path,
    ]);

    const lines: BlameLine[] = [];
    let current: BlameLine | null = null;

    const flush = (): void => {
      if (current) lines.push(current);
      current = null;
    };

    for (const rawLine of raw.split('\n')) {
      const header = /^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/.exec(rawLine);
      if (header) {
        flush();
        current = {
          line: Number(header[2]),
          commit: header[1]!,
          author: '',
          content: '',
        };
        continue;
      }
      if (!current) continue;
      if (rawLine.startsWith('author ')) {
        current.author = rawLine.slice('author '.length);
      } else if (rawLine.startsWith('\t')) {
        current.content = rawLine.slice(1);
      }
    }
    flush();

    return lines.sort((a, b) => a.line - b.line).slice(0, 5000);
  }

  async merge(input: MergeRequest): Promise<MergeResult> {    const dirty = (await git({ cwd: input.worktree }, ['status', '--porcelain'])).trim();
    if (dirty) {
      throw new AppError('E_GIT_DIRTY_TARGET', '目标工作区有未提交改动，拒绝合并', {
        details: { worktree: input.worktree },
      });
    }

    try {
      await git({ cwd: input.worktree }, ['rev-parse', '--verify', input.branch]);
    } catch (cause) {
      throw new AppError('E_GIT_BRANCH_MISSING', `源分支不存在：${input.branch}`, {
        cause,
      });
    }

    const before = (await git({ cwd: input.worktree }, ['rev-parse', 'HEAD'])).trim();
    const trailerLines = Object.entries(input.trailers).map(
      ([key, value]) => `${key}: ${value}`,
    );
    const message =
      trailerLines.length > 0
        ? `${input.message}\n\n${trailerLines.join('\n')}\n`
        : input.message;

    try {
      await git({ cwd: input.worktree }, [
        '-c',
        `user.name=${input.author.name}`,
        '-c',
        `user.email=${input.author.email}`,
        'merge',
        '--no-ff',
        input.branch,
        '-m',
        message,
      ]);
    } catch (cause) {
      const files = await this.unmergedFiles(input.worktree);

      if (input.resolveConflicts && files.length > 0) {
        let resolved = false;
        try {
          resolved = await input.resolveConflicts({
            worktree: input.worktree,
            branch: input.branch,
            files,
            attempt: input.attempt ?? 1,
          });
        } catch {
          resolved = false;
        }

        if (resolved) {
          // 必须先 stage，未 stage 的文件在 diff --diff-filter=U 里仍算未解决
          await git({ cwd: input.worktree }, ['add', '-A']);
          const remaining = await this.unmergedFiles(input.worktree);
          if (remaining.length === 0) {
            try {
              await git({ cwd: input.worktree }, [
                '-c',
                `user.name=${input.author.name}`,
                '-c',
                `user.email=${input.author.email}`,
                'commit',
                '-m',
                message,
              ]);
              const commit = (
                await git({ cwd: input.worktree }, ['rev-parse', 'HEAD'])
              ).trim();
              return { commit, alreadyUpToDate: false };
            } catch (commitError) {
              cause = commitError;
            }
          }
        }
      }

      // 失败后必须 abort，否则工作区卡在 MERGE_HEAD，后续节点全废
      try {
        await git({ cwd: input.worktree }, ['merge', '--abort']);
      } catch {
        // 没有进入合并状态时 abort 会失败，忽略
      }
      throw new AppError('E_GIT_MERGE_CONFLICT', `合并 ${input.branch} 失败`, {
        cause,
        details: { worktree: input.worktree, files },
      });
    }

    const after = (await git({ cwd: input.worktree }, ['rev-parse', 'HEAD'])).trim();
    return { commit: after, alreadyUpToDate: before === after };
  }

  async blame(input: {
    dir: string;
    path: string;
    line: number;
    ref?: string;
  }): Promise<BlameEntry> {
    const args = ['blame', '--line-porcelain', '-L', `${input.line},${input.line}`];
    if (input.ref) args.push(input.ref);
    args.push('--', input.path);

    const raw = await git({ cwd: input.dir }, args);

    const lines = raw.split('\n');
    const header = lines[0] ?? '';
    const commit = header.split(' ')[0] ?? '';
    if (!commit) throw new AppError('E_GIT_BLAME', `无法解析 blame 输出：${input.path}`);

    const authorLine = lines.find((line) => line.startsWith('author '));
    const contentLine = lines.find((line) => line.startsWith('\t'));
    const body = await git({ cwd: input.dir }, ['show', '-s', '--format=%B', commit]);

    return {
      commit,
      line: input.line,
      content: contentLine ? contentLine.slice(1) : '',
      author: authorLine ? authorLine.slice('author '.length) : '',
      trailers: parseTrailers(body),
    };
  }

  private async unmergedFiles(worktree: string): Promise<string[]> {
    const raw = await git(
      { cwd: worktree },
      ['diff', '--name-only', '--diff-filter=U', '-z'],
    );
    return raw.split('\0').filter((path) => path.length > 0);
  }

  private async changedPaths(worktree: string): Promise<string[]> {    const raw = await git(
      { cwd: worktree },
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    );
    const tokens = raw.split('\0').filter((token) => token.length > 0);
    const paths: string[] = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i]!;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      paths.push(path);
      // 重命名/复制：下一个 token 是原路径
      if (code.includes('R') || code.includes('C')) {
        const original = tokens[i + 1];
        if (original) {
          paths.push(original);
          i += 1;
        }
      }
    }
    return paths;
  }

  private async stats(
    worktree: string,
    commit: string,
  ): Promise<{ files: number; insertions: number; deletions: number }> {
    const raw = await git({ cwd: worktree }, ['show', '--numstat', '--format=', commit]);
    let files = 0;
    let insertions = 0;
    let deletions = 0;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const [added, removed] = line.split('\t');
      files += 1;
      insertions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
    return { files, insertions, deletions };
  }
}

/** 解析 commit message 末尾的 trailer 块（要求与正文之间有空行）。 */
export function parseTrailers(message: string): Record<string, string> {
  const lines = message.replace(/\r\n/g, '\n').split('\n');

  let end = lines.length - 1;
  while (end >= 0 && lines[end]!.trim() === '') end -= 1;

  const collected: Array<[string, string]> = [];
  let i = end;
  while (i >= 0) {
    const line = lines[i]!.trim();
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (!match) break;
    collected.push([match[1]!, match[2]!]);
    i -= 1;
  }

  if (collected.length === 0) return {};
  // trailer 块前面必须是空行（或文件开头），否则说明是正文里的普通行
  if (i >= 0 && lines[i]!.trim() !== '') return {};

  return Object.fromEntries(collected.reverse());
}

function withinScope(path: string, scope: string[]): boolean {
  const target = normalize(path);
  return scope.some((entry) => {
    const base = normalize(entry);
    if (base === '' || base === '.') return true;
    return target === base || target.startsWith(`${base}/`);
  });
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}
