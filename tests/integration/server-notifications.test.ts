/**
 * 审批通知：webhook 重试/去重、飞书 payload、gate 结束后不再发送。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '@spec-agent/cli';
import { Store } from '@spec-agent/core';
import { startServer, type RunningServer } from '@spec-agent/server';

const io = { out: () => {}, err: () => {} };
const SPEC = `name: notify
version: 1
params: []
nodes:
  - id: gate
    type: shell
    description: 等待审批
    inputs: []
    outputs: []
    approval:
      approvers: [human]
    run: 'node -e "process.exit(0)"'
edges: []
`;

const roots: string[] = [];
const servers: RunningServer[] = [];

async function makeGateProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'hive-notify-'));
  roots.push(root);
  await main(['init', '--root', root], io);
  const specPath = join(root, 'gate.yaml');
  writeFileSync(specPath, SPEC);
  await main(['run', '--root', root, '--spec', specPath, '通知测试'], io);
  return root;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('等待超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type FakeSmtp = {
  port: number;
  message: Promise<string>;
  close(): Promise<void>;
};

function startSmtp(): Promise<FakeSmtp> {
  let resolveMessage: (message: string) => void;
  const message = new Promise<string>((resolve) => {
    resolveMessage = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.write('220 fake SMTP\r\n');
    let buffer = '';
    let inData = false;
    let data = '';

    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);

        if (inData) {
          if (line === '.') {
            inData = false;
            resolveMessage(data);
            socket.write('250 queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250 fake\r\n');
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 end\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        message,
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

afterAll(async () => {
  for (const server of servers) {
    await server.close().catch(() => undefined);
  }
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('审批通知', () => {
  it('webhook 首次失败会重试，成功后去重且不重复发送', async () => {
    const root = await makeGateProject();
    const calls: Array<{ url: string; body: any }> = [];
    let failures = 1;

    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      if (failures > 0) {
        failures -= 1;
        return new Response('', { status: 500 });
      }
      return new Response('', { status: 200 });
    };

    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
      notifications: {
        webhookUrl: 'http://hook.test/notify',
        intervalMs: 15,
        retryDelaysMs: [10],
        fetchImpl: fakeFetch,
      },
    });
    servers.push(server);

    await waitFor(() => calls.length >= 2);
    expect(calls[0]?.url).toBe('http://hook.test/notify');
    expect(calls[0]?.body.type).toBe('gate.requested');
    expect(calls[0]?.body.gate.title).toContain('等待审批');
    expect(calls[0]?.body.task.title).toBe('通知测试');

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(calls).toHaveLength(2);

    const gates = await fetch(`${server.url}/api/gates`).then((response) =>
      response.json(),
    ) as { gates: Array<{ id: string }> };
    await fetch(`${server.url}/api/gates/${gates.gates[0]!.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', by: 'test' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toHaveLength(2);

    await server.close();
    const store = new Store({ path: join(root, '.spec-agent', 'spec-agent.db') });
    try {
      const rows = store.listOverallNotifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'sent', attempts: 1 });
    } finally {
      store.close();
    }
  });

  it('飞书 webhook 收到文本消息', async () => {
    const root = await makeGateProject();
    const calls: Array<{ url: string; body: any }> = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response('', { status: 200 });
    };

    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
      notifications: {
        feishuUrl: 'http://feishu.test/hook',
        intervalMs: 15,
        fetchImpl: fakeFetch,
      },
    });
    servers.push(server);

    await waitFor(() => calls.length >= 1);
    expect(calls[0]?.url).toBe('http://feishu.test/hook');
    expect(calls[0]?.body.msg_type).toBe('text');
    expect(calls[0]?.body.content.text).toContain('通知测试');
  });

  it('SMTP 邮件通知走 outbox 和邮件通道', async () => {
    const root = await makeGateProject();
    const smtp = await startSmtp();
    try {
      const server = await startServer({
        root,
        port: 0,
        webDist: join(root, 'missing-web'),
        notifications: {
          smtpUrl: `smtp://127.0.0.1:${smtp.port}?from=hive@test.local&to=ops@test.local`,
          intervalMs: 15,
        },
      });
      servers.push(server);

      const message = await smtp.message;
      expect(message).toContain('Subject: =?UTF-8?B?');
      const body = message.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
      expect(Buffer.from(body, 'base64').toString('utf8')).toContain(
        '通知测试',
      );
    } finally {
      await smtp.close();
    }
  });
});
