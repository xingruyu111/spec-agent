/**
 * 审批通知 outbox worker。
 *
 * 只做三件事：把 pending gate 写入 outbox、按退避重试、发送成功后标记。
 * 去重靠 notification_outbox 的 (gate_id, channel) 唯一约束，重启也不会重复发。
 */

import type { GateRow, TaskRow } from '@spec-agent/core';
import type { SpecAgentRuntime } from '@spec-agent/runtime';
import { SmtpMailer, parseSmtpUrl } from './smtp.js';

export type NotificationOptions = {
  webhookUrl?: string;
  feishuUrl?: string;
  smtpUrl?: string;
  /** 通知里的任务链接；默认用 server.url */
  publicUrl?: string;
  intervalMs?: number;
  /** 第 1/2/3... 次失败后的等待时间 */
  retryDelaysMs?: number[];
  fetchImpl?: typeof fetch;
};

type ProjectRef = {
  id: string;
  name: string;
  runtime: SpecAgentRuntime;
};

type Channel = 'webhook' | 'feishu' | 'email';

type NotificationService = {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
};

const DEFAULT_RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function createNotificationService(input: {
  projects: () => ProjectRef[];
  options: NotificationOptions;
}): NotificationService {
  const { options } = input;
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const intervalMs = options.intervalMs ?? 5_000;
  const publicUrl = (options.publicUrl ?? 'http://127.0.0.1:4317').replace(/\/$/, '');

  const mailer = options.smtpUrl
    ? new SmtpMailer(parseSmtpUrl(options.smtpUrl))
    : undefined;

  const channels: Channel[] = [];
  if (options.webhookUrl) channels.push('webhook');
  if (options.feishuUrl) channels.push('feishu');
  if (mailer) channels.push('email');

  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const messageFor = (
    project: ProjectRef,
    gate: GateRow,
    task: TaskRow | undefined,
  ): { subject: string; text: string; url: string } => {
    const payload = (gate.payload ?? {}) as Record<string, unknown>;
    const title = String(payload.title ?? gate.ask);
    const summary = String(payload.summary ?? '');
    const url = `${publicUrl}/?project=${encodeURIComponent(project.id)}`;
    const subject = `[Hive] 待审批：${title}`;
    const text = [
      'Hive 有一个审批在等你',
      `项目：${project.name} (${project.id})`,
      `任务：${task?.title ?? gate.taskId ?? '-'}`,
      `闸门：${title}`,
      summary ? `说明：${summary}` : '',
      `链接：${url}`,
    ]
      .filter(Boolean)
      .join('\n');
    return { subject, text, url };
  };

  const deliver = async (
    channel: Channel,
    project: ProjectRef,
    gate: GateRow,
    task: TaskRow | undefined,
  ): Promise<void> => {
    const message = messageFor(project, gate, task);
    if (channel === 'email') {
      await mailer!.send(message.subject, message.text);
      return;
    }

    if (channel === 'webhook') {
      const response = await fetchImpl(options.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'gate.requested',
          project: { id: project.id, name: project.name },
          task: task
            ? { id: task.id, title: task.title, assignee: task.assignee }
            : null,
          gate: {
            id: gate.id,
            kind: gate.kind,
            ask: gate.ask,
            title: String(
              (gate.payload as Record<string, unknown> | null)?.title ?? gate.ask,
            ),
            summary: String(
              (gate.payload as Record<string, unknown> | null)?.summary ?? '',
            ),
            requestedAt: gate.requestedAt,
          },
          url: message.url,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`webhook 返回 ${response.status}`);
      }
      return;
    }

    const response = await fetchImpl(options.feishuUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text: message.text },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`feishu 返回 ${response.status}`);
    }
  };

  const tick = async (): Promise<void> => {
    if (running || channels.length === 0) return;
    running = true;
    try {
      for (const project of input.projects()) {
        try {
          const gates = project.runtime.store.listPendingGates();
          for (const gate of gates) {
            for (const channel of channels) {
              project.runtime.store.ensureNotification(gate.id, channel);
            }
          }

          const due = project.runtime.store.listDueNotifications(undefined, 20);
          for (const notification of due) {
            const gate = project.runtime.store.getGate(notification.gateId);
            if (!gate || gate.status !== 'pending') {
              project.runtime.store.markNotificationSkipped(
                notification.id,
                'gate 已结束',
              );
              continue;
            }

            const task = gate.taskId
              ? project.runtime.store.getTask(gate.taskId)
              : undefined;
            try {
              await deliver(
                notification.channel as Channel,
                project,
                gate,
                task,
              );
              project.runtime.store.markNotificationSent(notification.id);
            } catch (error) {
              const attempts = notification.attempts + 1;
              const message =
                error instanceof Error ? error.message : String(error);
              if (attempts > retryDelays.length) {
                project.runtime.store.markNotificationFailed(
                  notification.id,
                  null,
                  message,
                );
              } else {
                project.runtime.store.markNotificationFailed(
                  notification.id,
                  new Date(
                    Date.now() + retryDelays[attempts - 1]!,
                  ).toISOString(),
                  message,
                );
              }
            }
          }
        } catch {
          // 单个项目存储暂时不可用，不影响其他项目
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer || channels.length === 0) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}
