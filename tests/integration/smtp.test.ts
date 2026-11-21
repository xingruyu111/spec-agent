/**
 * 最小 SMTP 客户端契约测试：用假 SMTP 服务器验证握手、AUTH LOGIN、DATA。
 */

import { createServer, type Socket } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { SmtpMailer, parseSmtpUrl } from '@spec-agent/server';

type FakeSmtp = {
  port: number;
  message: Promise<string>;
  close(): Promise<void>;
};

function fakeSmtp(): Promise<FakeSmtp> {
  let resolveMessage: (message: string) => void;
  const message = new Promise<string>((resolve) => {
    resolveMessage = resolve;
  });
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.write('220 fake.smtp ESMTP\r\n');

    let buffer = '';
    let authStep = 0;
    let inData = false;
    let data = '';

    socket.on('data', (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);

        if (inData) {
          if (line === '.') {
            inData = false;
            resolveMessage(data);
            socket.write('250 2.0.0 queued\r\n');
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }

        if (authStep === 1) {
          authStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (authStep === 2) {
          authStep = 0;
          socket.write('235 2.7.0 Authentication successful\r\n');
          continue;
        }

        line = line.toUpperCase();
        if (line.startsWith('EHLO')) {
          socket.write('250-fake.smtp\r\n250 AUTH LOGIN\r\n');
        } else if (line.startsWith('AUTH LOGIN')) {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) {
          socket.write('250 2.1.0 OK\r\n');
        } else if (line === 'DATA') {
          inData = true;
          data = '';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 Bye\r\n');
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

let smtp: FakeSmtp | undefined;

afterAll(async () => {
  await smtp?.close();
});

describe('SMTP 客户端', () => {
  it('解析 smtp URL 并发送 UTF-8 邮件', async () => {
    smtp = await fakeSmtp();
    const config = parseSmtpUrl(
      `smtp://user:pass@127.0.0.1:${smtp.port}?from=hive@example.com&to=ops@example.com,dev@example.com`,
    );
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      from: 'hive@example.com',
      to: ['ops@example.com', 'dev@example.com'],
    });

    const mailer = new SmtpMailer(config);
    await mailer.send('审批提醒', '任务 A 等待审批');

    const message = await smtp.message;
    expect(message).toContain('Subject: =?UTF-8?B?');
    expect(message).toContain('Content-Type: text/plain; charset=utf-8');
    const body = message.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('任务 A 等待审批');
  });

  it('非法 URL 直接拒绝', () => {
    expect(() => parseSmtpUrl('http://example.com')).toThrow();
    expect(() => parseSmtpUrl('smtp://host:25')).toThrow();
  });
});
