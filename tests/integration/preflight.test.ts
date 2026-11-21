import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { preflightRoot, validateServerConfig } from '../../apps/server/src/infra/preflight.js';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('preflight', () => {
  it('拒绝非法启动配置', () => {
    expect(() => validateServerConfig({ port: -1 })).toThrowError(/port/);
    expect(() => validateServerConfig({ port: Number.NaN })).toThrowError(/port/);
    expect(() => validateServerConfig({ maxConcurrentChildren: 0 })).toThrowError(
      /maxConcurrentChildren/,
    );
    expect(() => validateServerConfig({ mergeAttempts: 0 })).toThrowError(
      /mergeAttempts/,
    );
    expect(() => validateServerConfig({ maxUsdPerTask: 0 })).toThrowError(
      /maxUsdPerTask/,
    );
    expect(() => validateServerConfig({ host: ' ' })).toThrowError(/host/);
  });

  it('空目录可以启动，但会给出缺 git / 缺 web 的 warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-preflight-'));
    dirs.push(root);
    mkdirSync(join(root, '.spec-agent'), { recursive: true });

    const result = preflightRoot(root, {
      webDist: join(root, 'missing-web'),
      hasToken: false,
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'root', level: 'ok' }),
        expect.objectContaining({ name: 'repo', level: 'warn' }),
        expect.objectContaining({ name: 'web-dist', level: 'warn' }),
        expect.objectContaining({ name: 'auth', level: 'warn' }),
      ]),
    );
  });
});
