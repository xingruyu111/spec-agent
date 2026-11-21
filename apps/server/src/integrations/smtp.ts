/**
 * 最小 SMTP 客户端。
 *
 * 只支持明文和隐式 TLS（smtps:// / secure=1），不实现 STARTTLS；
 * 够发审批提醒，不引入新依赖。凭证只从 URL 读，不落库、不写日志。
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
};

export function parseSmtpUrl(raw: string): SmtpConfig {
  const url = new URL(raw);
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new Error('SMTP URL 必须是 smtp:// 或 smtps://');
  }

  const secure =
    url.protocol === 'smtps:' ||
    ['1', 'true', 'yes'].includes(url.searchParams.get('secure') ?? '');
  const host = url.hostname;
  const port = Number(url.port || (secure ? 465 : 25));
  const from = (url.searchParams.get('from') || decodeURIComponent(url.username)).trim();
  const to = (url.searchParams.get('to') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!host || !from || to.length === 0) {
    throw new Error('SMTP URL 需要 host、from 和 to');
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('SMTP 端口不合法');
  }

  return {
    host,
    port,
    secure,
    ...(url.username
      ? {
          user: decodeURIComponent(url.username),
          pass: decodeURIComponent(url.password),
        }
      : {}),
    from,
    to,
  };
}

type Connection = Socket | TLSSocket;

class LineReader {
  private buffer = '';
  private current: string[] = [];
  private queue: string[] = [];
  private waiter?: { resolve: (value: string) => void; reject: (error: Error) => void };

  constructor(private readonly socket: Connection) {
    socket.on('data', (chunk: Buffer | string) => this.feed(String(chunk)));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('SMTP 连接已关闭')));
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.current.push(line);
      if (/^\d{3} /.test(line)) {
        const response = this.current.join('\n');
        this.current = [];
        const waiter = this.waiter;
        if (waiter) {
          this.waiter = undefined;
          waiter.resolve(response);
        } else {
          this.queue.push(response);
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    }
  }

  next(timeoutMs = 15_000): Promise<string> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error('SMTP 响应超时'));
      }, timeoutMs);
      this.waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }
}

export class SmtpMailer {
  constructor(private readonly config: SmtpConfig) {}

  async send(subject: string, text: string): Promise<void> {
    const socket = this.config.secure
      ? tlsConnect({
          host: this.config.host,
          port: this.config.port,
          servername: this.config.host,
        })
      : createConnection({
          host: this.config.host,
          port: this.config.port,
        });

    await new Promise<void>((resolve, reject) => {
      const event = this.config.secure ? 'secureConnect' : 'connect';
      socket.once(event, () => resolve());
      socket.once('error', reject);
    });

    const reader = new LineReader(socket);
    const command = async (line: string, expected: number): Promise<void> => {
      socket.write(`${line}\r\n`);
      const response = await reader.next();
      if (!response.startsWith(`${expected}`)) {
        throw new Error(`SMTP ${line.split(' ')[0]} 失败：${response}`);
      }
    };

    try {
      const greeting = await reader.next();
      if (!greeting.startsWith('220')) {
        throw new Error(`SMTP 握手失败：${greeting}`);
      }

      await command('EHLO hive', 250);
      if (this.config.user) {
        await command('AUTH LOGIN', 334);
        socket.write(`${Buffer.from(this.config.user).toString('base64')}\r\n`);
        const userResponse = await reader.next();
        if (!userResponse.startsWith('334')) {
          throw new Error(`SMTP AUTH 用户名失败：${userResponse}`);
        }
        socket.write(`${Buffer.from(this.config.pass ?? '').toString('base64')}\r\n`);
        const passResponse = await reader.next();
        if (!passResponse.startsWith('235')) {
          throw new Error(`SMTP AUTH 密码失败：${passResponse}`);
        }
      }

      await command(`MAIL FROM:<${this.config.from}>`, 250);
      for (const recipient of this.config.to) {
        await command(`RCPT TO:<${recipient}>`, 250);
      }
      await command('DATA', 354);

      const message = buildMessage(subject, text, this.config);
      socket.write(`${message}\r\n.\r\n`);
      const stored = await reader.next();
      if (!stored.startsWith('250')) {
        throw new Error(`SMTP DATA 失败：${stored}`);
      }

      socket.write('QUIT\r\n');
      await reader.next().catch(() => undefined);
    } finally {
      socket.end();
      socket.destroy();
    }
  }
}

function buildMessage(subject: string, text: string, config: SmtpConfig): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const body = Buffer.from(text, 'utf8')
    .toString('base64')
    .match(/.{1,76}/g)!
    .join('\r\n');

  return [
    `From: ${config.from}`,
    `To: ${config.to.join(', ')}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}
