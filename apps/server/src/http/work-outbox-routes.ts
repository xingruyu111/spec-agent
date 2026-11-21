import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OutboxWorker } from '../work/outbox-worker.js';
import type { WorkService } from '../work/work-service.js';

type WorkOutboxRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};

type WorkOutboxRouteContext = {
  work: WorkService;
  outboxWorker: OutboxWorker | undefined;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: WorkOutboxRouteIo;
  fail: (status: number, code: string, message: string) => void;
};

export async function handleWorkOutboxRoutes(
  ctx: WorkOutboxRouteContext,
): Promise<boolean> {
  const { work, outboxWorker, request, response, path, url, io, fail } = ctx;

    if (request.method === 'POST' && path === '/api/work/outbox/run') {
      if (!outboxWorker) {
        fail(503, 'E_WORK_OUTBOX', '没有配置 Outbox transport');
        return true;
      }
      io.json(response, 200, await outboxWorker.runOnce());
      return true;
    }

    if (request.method === 'GET' && path === '/api/work/outbox') {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const status = url.searchParams.get('status');
      const valid =
        status === 'pending' || status === 'sent' || status === 'failed'
          ? status
          : undefined;
      io.json(response, 200, { outbox: work.outbox(projectId, valid) });
      return true;
    }

    if (
      request.method === 'GET' &&
      path === '/api/work/outbox/audit.csv'
    ) {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const escape = (value: unknown): string =>
        `"${String(value ?? '').replace(/"/g, '""')}"`;
      const rows = [
        [
          'createdAt',
          'source',
          'externalId',
          'outboxId',
          'attempt',
          'ok',
          'error',
        ]
          .map(escape)
          .join(','),
        ...work.outboxAudit(projectId).map((attempt) =>
          [
            attempt.createdAt,
            attempt.source,
            attempt.externalId ?? '',
            attempt.outboxId,
            attempt.attempt,
            attempt.ok ? 'yes' : 'no',
            attempt.error ?? '',
          ]
            .map(escape)
            .join(','),
        ),
      ].join('\n');
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="outbox-audit.csv"',
      });
      response.end(rows);
      return true;
    }

    const outboxAttemptsMatch =
      /^\/api\/work\/outbox\/([^/]+)\/attempts$/.exec(path);
    if (request.method === 'GET' && outboxAttemptsMatch) {
      io.json(response, 200, {
        attempts: work.outboxAttempts(
          decodeURIComponent(outboxAttemptsMatch[1]!),
        ),
      });
      return true;
    }

    const outboxSendMatch =
      /^\/api\/work\/outbox\/([^/]+)\/send$/.exec(path);
    if (request.method === 'POST' && outboxSendMatch) {
      if (!outboxWorker) {
        fail(503, 'E_WORK_OUTBOX', '没有配置 Outbox transport');
        return true;
      }
      const result = await outboxWorker.runOne(
        decodeURIComponent(outboxSendMatch[1]!),
      );
      if (!result.outbox) {
        fail(404, 'E_WORK_OUTBOX', result.error ?? '回执不存在');
        return true;
      }
      io.json(response, 200, result);
      return true;
    }

    const outboxRetryMatch =
      /^\/api\/work\/outbox\/([^/]+)\/retry$/.exec(path);
    if (request.method === 'POST' && outboxRetryMatch) {
      io.json(response, 200, {
        outbox: work.retryOutbox(decodeURIComponent(outboxRetryMatch[1]!)),
      });
      return true;
    }

    const outboxMatch = /^\/api\/work\/outbox\/([^/]+)\/status$/.exec(path);
    if (request.method === 'POST' && outboxMatch) {
      const body = await io.readJson(request);
      const status =
        body.status === 'sent' || body.status === 'failed'
          ? body.status
          : 'pending';
      io.json(response, 200, {
        outbox: work.markOutbox(
          decodeURIComponent(outboxMatch[1]!),
          status,
        ),
      });
      return true;
    }

  return false;
}
