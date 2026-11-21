import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '@spec-agent/server';
import { loadProviderFile } from '../../apps/server/src/infra/provider-config.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Spec Agent LLM gateway', () => {
  it('按模型前缀路由供应商，并透传 SSE 与上游凭证', async () => {
    const requests: Array<{ url: string; authorization: string; apiKey: string; body: any }> = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        url: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
        apiKey: String(request.headers['x-api-key'] ?? ''),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: message_start\ndata: {"ok":true}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      response.end('event: message_stop\ndata: {}\n\n');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    const upstreamUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const root = mkdtempSync(join(tmpdir(), 'spec-agent-proxy-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const providerFile = join(root, 'provider.json');
    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
      providerFile,
      provider: {
        id: 'alpha', name: 'Alpha', protocol: 'anthropic', baseUrl: upstreamUrl,
        authToken: 'alpha-secret', models: { 'model-alpha': {} },
      },
      providers: [
        {
          id: 'beta', name: 'Beta', protocol: 'anthropic', baseUrl: upstreamUrl,
          authToken: 'beta-secret', models: { 'model-beta': {} },
        },
        {
          id: 'gamma', name: 'Gamma', protocol: 'openai', baseUrl: upstreamUrl,
          authToken: 'gamma-secret', models: { 'gpt-test': {} },
        },
      ],
      model: 'model-alpha',
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.url}/api/llm/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer client-must-not-leak' },
      body: JSON.stringify({ model: 'beta/model-beta', stream: true }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('message_start');
    expect(text).toContain('message_stop');
    expect(requests[0]).toMatchObject({
      url: '/v1/messages',
      authorization: 'Bearer beta-secret',
      apiKey: 'beta-secret',
      body: { model: 'model-beta', stream: true },
    });

    await fetch(`${server.url}/api/llm/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gamma/gpt-test', messages: [] }),
    });
    expect(requests[1]?.authorization).toBe('Bearer gamma-secret');
    expect(requests[1]?.body.model).toBe('gpt-test');
  });

  it('保存多供应商配置且公开 GET 不返回 API Key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spec-agent-provider-registry-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const providerFile = join(root, 'provider.json');
    const server: RunningServer = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
      providerFile,
      provider: {
        id: 'alpha', protocol: 'anthropic', baseUrl: 'https://alpha.example',
        authToken: 'alpha-secret', models: { 'model-alpha': {} },
      },
      model: 'model-alpha',
    });
    cleanups.push(() => server.close());

    const accepted = await fetch(`${server.url}/api/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultProviderId: 'beta',
        model: 'model-beta',
        providers: [
          { id: 'alpha', name: 'Alpha', protocol: 'anthropic', baseUrl: 'https://alpha.example', models: ['model-alpha'] },
          { id: 'beta', name: 'Beta', protocol: 'openai', baseUrl: 'https://beta.example', models: ['model-beta'] },
        ],
      }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).defaultProviderId).toBe('beta');

    const update = await fetch(`${server.url}/api/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultProviderId: 'alpha',
        model: 'model-alpha',
        providers: [
          { id: 'alpha', name: 'Alpha', protocol: 'anthropic', baseUrl: 'https://alpha.example', models: ['model-alpha'] },
          { id: 'beta', name: 'Beta', protocol: 'openai', baseUrl: 'https://beta.example', authToken: 'beta-secret', models: [{ id: 'model-beta', contextWindow: 200000, autoCompact: false }] },
        ],
      }),
    });
    expect(update.status).toBe(200);
    const settings = await update.json();
    expect(settings.defaultProviderId).toBe('alpha');
    expect(settings.providers).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain('alpha-secret');
    expect(JSON.stringify(settings)).not.toContain('beta-secret');
    const editor = await fetch(`${server.url}/api/provider?secrets=1`).then((r) => r.json());
    expect(editor.providers.find((provider: any) => provider.id === 'beta')?.authToken).toBe('beta-secret');
    expect(editor.providers.find((provider: any) => provider.id === 'alpha')?.authToken).toBe('alpha-secret');
    expect(editor.providers.find((provider: any) => provider.id === 'beta')?.models[0]).toMatchObject({
      id: 'model-beta', contextWindow: 200000, autoCompact: false,
    });

    const cleared = await fetch(`${server.url}/api/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultProviderId: 'alpha',
        model: 'model-alpha',
        providers: [
          { id: 'alpha', name: 'Alpha', protocol: 'anthropic', baseUrl: 'https://alpha.example', models: ['model-alpha'], authToken: '' },
          { id: 'beta', name: 'Beta', protocol: 'openai', baseUrl: 'https://beta.example', models: ['model-beta'] },
        ],
      }),
    });
    expect(cleared.status).toBe(200);
    const afterClear = await fetch(`${server.url}/api/provider?secrets=1`).then((r) => r.json());
    expect(afterClear.providers.find((provider: any) => provider.id === 'alpha')?.authToken).toBe('');
    expect(afterClear.providers.find((provider: any) => provider.id === 'beta')?.authToken).toBe('beta-secret');
    expect(loadProviderFile(providerFile)).toMatchObject({
      version: 2,
      defaultProviderId: 'alpha',
      model: 'model-alpha',
    });

    await server.close();
    const restarted = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
      providerFile,
      provider: {
        id: 'alpha', protocol: 'anthropic', baseUrl: 'https://alpha.example',
        authToken: 'alpha-secret', models: { 'model-alpha': {} },
      },
      model: 'model-alpha',
    });
    cleanups.push(() => restarted.close());
    const reloaded = await fetch(`${restarted.url}/api/provider?secrets=1`).then((r) => r.json());
    expect(reloaded.providers.find((provider: any) => provider.id === 'alpha')?.models).toEqual([
      { id: 'model-alpha' },
    ]);
    expect(reloaded.providers.find((provider: any) => provider.id === 'beta')?.models[0]).toMatchObject({
      id: 'model-beta', contextWindow: 200000, autoCompact: false,
    });
  });
});
