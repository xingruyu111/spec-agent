import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '@spec-agent/server';

let base = '';
let providerFile = '';
let server: RunningServer;

const projectRoot = () => join(base, 'project');

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'hive-provider-'));
  providerFile = join(base, 'provider.json');
  writeFileSync(
    providerFile,
    JSON.stringify({
      baseUrl: 'https://initial.example.com/anthropic',
      authToken: 'initial-secret',
      model: 'initial-model',
      models: ['initial-model', 'initial-small'],
    }),
  );
  const projectsFile = join(base, 'projects.json');
  writeFileSync(
    projectsFile,
    JSON.stringify({
      projects: [{ id: 'demo', name: 'Demo', root: projectRoot() }],
    }),
  );
  server = await startServer({
    projectsFile,
    providerFile,
    port: 0,
  });
});

afterAll(async () => {
  await server?.close();
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function call(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe('模型供应商配置', () => {
  it('GET 返回配置但不泄露 token', async () => {
    const response = await call('/api/provider');
    expect(response.status).toBe(200);
    expect(response.body.baseUrl).toBe('https://initial.example.com/anthropic');
    expect(response.body.model).toBe('initial-model');
    expect(response.body.models).toEqual(['initial-model', 'initial-small']);
    expect(response.body.hasToken).toBe(true);
    expect(response.body.tokenHint).toBe('…cret');
    expect(JSON.stringify(response.body)).not.toContain('initial-secret');
  });

  it('PUT 校验并持久化新配置', async () => {
    const response = await call('/api/provider', {
      method: 'PUT',
      body: {
        baseUrl: 'https://relay.example.com/anthropic',
        authToken: 'new-secret',
        model: 'new-model',
        models: ['new-model', 'new-small'],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.baseUrl).toBe('https://relay.example.com/anthropic');
    expect(response.body.model).toBe('new-model');
    expect(response.body.models).toEqual(['new-model', 'new-small']);
    expect(response.body.hasToken).toBe(true);

    const stored = JSON.parse(readFileSync(providerFile, 'utf8')) as {
      baseUrl: string;
      authToken: string;
      model: string;
      models: string[];
    };
    expect(stored.baseUrl).toBe('https://relay.example.com/anthropic');
    expect(stored.authToken).toBe('new-secret');
    expect(stored.model).toBe('new-model');
    expect(stored.models).toEqual(['new-model', 'new-small']);
  });

  it('拒绝非法 URL', async () => {
    const response = await call('/api/provider', {
      method: 'PUT',
      body: { baseUrl: 'ftp://example.com', model: 'new-model' },
    });
    expect(response.status).toBe(400);
  });

  it('可以清除 token', async () => {
    const response = await call('/api/provider', {
      method: 'PUT',
      body: {
        baseUrl: 'https://relay.example.com/anthropic',
        model: 'new-model',
        clearToken: true,
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.hasToken).toBe(false);
    expect(response.body.tokenHint).toBe('');
  });
});
