import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { startServer, type RunningServer } from '@spec-agent/server';

const io = { out: () => {}, err: () => {} };
const dirs: string[] = [];
const servers: RunningServer[] = [];

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => undefined);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('server hardening', () => {
  it('安全头、ready 自检、请求体上限和幂等关闭', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-hardening-'));
    dirs.push(root);
    await main(['init', '--root', root], io);

    const web = join(root, 'web');
    mkdirSync(web, { recursive: true });
    writeFileSync(
      join(web, 'index.html'),
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );

    const token = 'test-token-1234567890';
    const server = await startServer({
      root,
      port: 0,
      webDist: web,
      token,
      shutdownTimeoutMs: 100,
    });
    servers.push(server);

    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
    expect(await page.text()).toContain('id="root"');

    const ready = await fetch(`${server.url}/api/ready`).then((response) =>
      response.json(),
    ) as {
      ok: boolean;
      projects: Array<{
        ok: boolean;
        migration: number;
        git: boolean;
        warnings: string[];
      }>;
    };
    expect(ready.ok).toBe(true);
    expect(ready.projects[0]).toMatchObject({
      ok: true,
      migration: 42,
      git: true,
    });
    expect(ready.projects[0]?.warnings).toEqual([]);

    const tooLarge = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({
      error: { code: 'E_BODY_TOO_LARGE' },
    });

    const badJson = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toMatchObject({
      error: { code: 'E_BAD_JSON' },
    });

    await server.close();
    await server.close();
  });

  it('非法配置在 listen 前失败', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-hardening-config-'));
    dirs.push(root);
    await main(['init', '--root', root], io);

    await expect(
      startServer({ root, port: -1 }),
    ).rejects.toMatchObject({ code: 'E_CONFIG' });
    await expect(
      startServer({ root, port: 0, mergeAttempts: 0 }),
    ).rejects.toMatchObject({ code: 'E_CONFIG' });
  });
});




















