/**
 * 启动配置校验与部署自检。
 *
 * 配置错误在 listen 前失败；运行环境问题（缺 git、缺 web 构建）作为 warning
 * 暴露在 /api/ready 里，避免把开发机问题伪装成健康。
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AppError } from '@spec-agent/kernel';

type PreflightLevel = 'ok' | 'warn' | 'error';

type PreflightCheck = {
  name: string;
  level: PreflightLevel;
  detail?: string;
};

export type PreflightResult = {
  ok: boolean;
  checks: PreflightCheck[];
};

export type ServerConfigInput = {
  port?: number;
  host?: string;
  maxConcurrentChildren?: number;
  mergeAttempts?: number;
  mergeRetryDelayMs?: number;
  maxUsdPerTask?: number;
  shutdownTimeoutMs?: number;
};

function integer(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(
      'E_CONFIG',
      `${name} 必须是 ${min}..${max} 的整数，当前为 ${String(value)}`,
    );
  }
}

export function validateServerConfig(input: ServerConfigInput): void {
  integer('port', input.port, 0, 65_535);
  integer('maxConcurrentChildren', input.maxConcurrentChildren, 1, 64);
  integer('mergeAttempts', input.mergeAttempts, 1, 20);
  integer('mergeRetryDelayMs', input.mergeRetryDelayMs, 0, 3_600_000);
  integer('shutdownTimeoutMs', input.shutdownTimeoutMs, 0, 120_000);

  if (input.maxUsdPerTask !== undefined) {
    if (
      !Number.isFinite(input.maxUsdPerTask) ||
      input.maxUsdPerTask <= 0
    ) {
      throw new AppError('E_CONFIG', 'maxUsdPerTask 必须是正数');
    }
  }

  if (input.host !== undefined && input.host.trim() === '') {
    throw new AppError('E_CONFIG', 'host 不能为空');
  }
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], {
      stdio: 'ignore',
      timeout: 3000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function gitRepo(path: string): boolean {
  if (!existsSync(join(path, '.git'))) return false;
  try {
    const result = execFileSync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: path, stdio: 'pipe', timeout: 3000, windowsHide: true },
    );
    return String(result).trim() === 'true';
  } catch {
    return false;
  }
}

export function preflightRoot(
  root: string,
  options: { webDist?: string; hasToken?: boolean; repoPath?: string } = {},
): PreflightResult {
  const checks: PreflightCheck[] = [];

  const exists = existsSync(root);
  checks.push({
    name: 'root',
    level: exists ? 'ok' : 'error',
    detail: root,
  });
  if (!exists) return { ok: false, checks };

  const isDir = statSync(root).isDirectory();
  checks.push({
    name: 'root-directory',
    level: isDir ? 'ok' : 'error',
    detail: root,
  });

  const canWrite = writable(root);
  checks.push({
    name: 'root-writable',
    level: canWrite ? 'ok' : 'error',
    detail: canWrite ? undefined : `没有写权限：${root}`,
  });

  checks.push({
    name: 'hive-dir',
    level: existsSync(join(root, '.spec-agent')) ? 'ok' : 'warn',
    detail: existsSync(join(root, '.spec-agent'))
      ? undefined
      : '缺少 .spec-agent/，项目可能还没有初始化',
  });

  const hasGit = gitAvailable();
  checks.push({
    name: 'git',
    level: hasGit ? 'ok' : 'warn',
    detail: hasGit ? undefined : '没有找到 git 可执行文件',
  });

  const repo = options.repoPath ?? join(root, 'repo');
  const repoOk = hasGit && gitRepo(repo);
  checks.push({
    name: 'repo',
    level: repoOk ? 'ok' : 'warn',
    detail: repoOk ? repo : `git 仓库不可用：${repo}`,
  });

  if (options.webDist) {
    const webOk = existsSync(join(options.webDist, 'index.html'));
    checks.push({
      name: 'web-dist',
      level: webOk ? 'ok' : 'warn',
      detail: webOk ? undefined : `前端构建不存在：${options.webDist}`,
    });
  }

  if (options.hasToken === false) {
    checks.push({
      name: 'auth',
      level: 'warn',
      detail: '没有设置 SPEC_AGENT_TOKEN，/api 不鉴权',
    });
  }

  return {
    ok: checks.every((check) => check.level !== 'error'),
    checks,
  };
}

export function formatChecks(result: PreflightResult): string {
  return result.checks
    .filter((check) => check.level !== 'ok')
    .map((check) => `${check.level}: ${check.name}${check.detail ? ` (${check.detail})` : ''}`)
    .join('\n');
}

