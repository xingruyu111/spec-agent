/** Spec Agent unified LLM gateway: configured providers only, streaming pass-through. */

import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { AppError } from '@spec-agent/kernel';
import type { ProviderConfig } from '@spec-agent/core';

const MAX_PROXY_BODY = 32 * 1024 * 1024;
const FORWARD_HEADERS = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'x-request-id',
];

export async function handleLlmProxy(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  providers: ProviderConfig[],
  defaultProviderId: string,
): Promise<void> {
  const match = /^\/api\/llm\/(anthropic|openai)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    proxyError(response, 404, 'E_PROXY_ROUTE', '未知中转路径');
    return;
  }
  const protocol = match[1] as 'anthropic' | 'openai';
  const suffix = match[2] ?? '';
  if (!suffix || suffix.includes('..') || suffix.includes('\\')) {
    proxyError(response, 400, 'E_PROXY_ROUTE', '中转路径无效');
    return;
  }

  let provider = providers.find((entry) => entry.id === defaultProviderId) ?? providers[0];
  const requestedProvider = request.headers['x-spec-agent-provider'];
  if (typeof requestedProvider === 'string' && requestedProvider.trim()) {
    provider = providers.find((entry) => entry.id === requestedProvider.trim());
  }

  let body: Buffer | undefined;
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    try {
      body = await readBody(request);
    } catch (error) {
      proxyError(
        response,
        error instanceof AppError && error.code === 'E_PROXY_BODY_TOO_LARGE' ? 413 : 400,
        error instanceof AppError ? error.code : 'E_PROXY_BODY',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const contentType = String(request.headers['content-type'] ?? '');
    if (contentType.includes('application/json') && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        if (typeof parsed.model === 'string') {
          const slash = parsed.model.indexOf('/');
          if (slash > 0) {
            const candidate = parsed.model.slice(0, slash);
            const selected = providers.find((entry) => entry.id === candidate);
            if (selected) {
              provider = selected;
              parsed.model = parsed.model.slice(slash + 1);
              body = Buffer.from(JSON.stringify(parsed), 'utf8');
            }
          }
        }
      } catch {
        proxyError(response, 400, 'E_PROXY_BODY', '请求体不是合法 JSON');
        return;
      }
    }
  }

  if (!provider) {
    proxyError(response, 404, 'E_PROVIDER_NOT_FOUND', '没有可用供应商');
    return;
  }
  if ((provider.protocol ?? 'anthropic') !== protocol) {
    proxyError(response, 400, 'E_PROVIDER_PROTOCOL', `供应商 ${provider.id} 不是 ${protocol} 协议`);
    return;
  }
  if (!provider.baseUrl) {
    proxyError(response, 400, 'E_PROVIDER_CONFIG', `供应商 ${provider.id} 没有 Base URL`);
    return;
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string' && value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    headers.set(name, value);
  }
  if (provider.authToken) {
    headers.set('authorization', `Bearer ${provider.authToken}`);
    if (protocol === 'anthropic') headers.set('x-api-key', provider.authToken);
  }

  let targetSuffix = suffix;
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1') && targetSuffix.startsWith('/v1/')) {
    targetSuffix = targetSuffix.slice(3);
  }
  const target = `${base}${targetSuffix}${url.search}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.SPEC_AGENT_PROXY_TIMEOUT_MS ?? 0);
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  const onClose = (): void => {
    if (!response.writableEnded) controller.abort();
  };
  response.once('close', onClose);

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: controller.signal,
    });
    const responseHeaders: Record<string, string> = {};
    for (const name of [
      'content-type',
      'cache-control',
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-reset-requests',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    response.writeHead(upstream.status, responseHeaders);
    if (upstream.body && request.method !== 'HEAD') {
      const stream = Readable.fromWeb(upstream.body as never);
      stream.on('error', () => {
        if (!response.writableEnded) response.destroy();
      });
      stream.pipe(response);
      await new Promise<void>((resolve) => {
        response.once('finish', resolve);
        response.once('close', resolve);
      });
    } else {
      response.end();
    }
  } catch (error) {
    if (!response.headersSent) {
      const aborted = controller.signal.aborted;
      proxyError(
        response,
        aborted ? 499 : 502,
        aborted ? 'E_PROXY_CANCELLED' : 'E_LLM_UPSTREAM',
        aborted ? '客户端已断开' : error instanceof Error ? error.message : String(error),
      );
    } else if (!response.writableEnded) {
      response.destroy();
    }
  } finally {
    if (timer) clearTimeout(timer);
    response.off('close', onClose);
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROXY_BODY) {
      throw new AppError('E_PROXY_BODY_TOO_LARGE', '中转请求体最多 32MB');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function proxyError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: { code, message } }));
}
