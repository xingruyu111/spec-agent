import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatService } from '../chat/chat.js';
import { normalizeGitHubPayload } from '../integrations/github-source.js';
import { sourceSecret, verifySourceSignature } from '../integrations/source-signature.js';
import type { WorkService } from '../work/work-service.js';
import type { WorkExecutor } from '../work/work-executor.js';

type WorkGitHubRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  readRawBody: (request: IncomingMessage) => Promise<string>;
};

type WorkGitHubRouteContext = {
  work: WorkService;
  workExecutor: WorkExecutor | undefined;
  chat: ChatService;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: WorkGitHubRouteIo;
  fail: (status: number, code: string, message: string) => void;
};

export async function handleWorkGitHubRoutes(
  ctx: WorkGitHubRouteContext,
): Promise<boolean> {
  const { work, workExecutor, chat, request, response, path, url, io, fail } = ctx;

    if (request.method === 'GET' && path === '/api/work/source-rules') {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      io.json(response, 200, { rules: work.sourceRules(projectId) });
      return true;
    }

    if (request.method === 'POST' && path === '/api/work/source-rules') {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const source = typeof body.source === 'string' ? body.source : '';
      if (!projectId || !source) {
        fail(400, 'E_WORK_RULE', '需要 projectId 和 source');
        return true;
      }
      io.json(response, 200, {
        rule: work.upsertSourceRule({
          projectId,
          source,
          groupId:
            typeof body.groupId === 'string' ? body.groupId : null,
          actions: Array.isArray(body.actions)
            ? body.actions.filter(
                (action): action is string => typeof action === 'string',
              )
            : [],
          labels: Array.isArray(body.labels)
            ? body.labels.filter(
                (label): label is string => typeof label === 'string',
              )
            : [],
          authors: Array.isArray(body.authors)
            ? body.authors.filter(
                (author): author is string => typeof author === 'string',
              )
            : [],
          ...(typeof body.enabled === 'boolean'
            ? { enabled: body.enabled }
            : {}),
        }),
      });
      return true;
    }

    const sourceRuleMatch =
      /^\/api\/work\/source-rules\/([^/]+)$/.exec(path);
    if (request.method === 'DELETE' && sourceRuleMatch) {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      io.json(response, 200, {
        deleted: work.deleteSourceRule(
          decodeURIComponent(sourceRuleMatch[1]!),
          projectId,
        ),
      });
      return true;
    }

    if (request.method === 'GET' && path === '/api/github/status') {
      const transport = process.env.SPEC_AGENT_OUTBOX_URL
        ? 'http'
        : process.env.SPEC_AGENT_OUTBOX_TRANSPORT === 'github' &&
            process.env.GITHUB_TOKEN
          ? 'github'
          : process.env.SPEC_AGENT_OUTBOX_TRANSPORT === 'log'
            ? 'log'
            : null;
      io.json(response, 200, {
        transport,
        tokenConfigured: Boolean(process.env.GITHUB_TOKEN),
        ready: transport === 'github',
      });
      return true;
    }

    const sourceMatch = /^\/api\/work\/sources\/([^/]+)$/.exec(path);
    const githubWebhook = path === '/api/github/webhook';
    if (request.method === 'POST' && (sourceMatch || githubWebhook)) {
      const source = githubWebhook
        ? 'github'
        : decodeURIComponent(sourceMatch![1]!);
      if (source !== 'github') {
        fail(
          410,
          'E_WORK_SOURCE_UNSUPPORTED',
          '当前只支持 GitHub 事件',
        );
        return true;
      }
      const raw = await io.readRawBody(request);
      const secret = sourceSecret(source);
      const signature =
        String(
          request.headers['x-hub-signature-256'] ??
            request.headers['x-spec-agent-signature'] ??
            '',
        ) || undefined;
      const verified = verifySourceSignature({
        secret,
        body: raw,
        signature,
      });
      if (!verified.ok) {
        fail(
          401,
          'E_WORK_SOURCE_SIGNATURE',
          verified.reason ?? '签名校验失败',
        );
        return true;
      }
      if (request.headers['x-github-event'] === 'ping') {
        io.json(response, 200, { ok: true, pong: true });
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        fail(400, 'E_BAD_JSON', '请求体不是合法 JSON');
        return true;
      }
      const normalized =
        source === 'github' ? normalizeGitHubPayload(body) : null;
      let projectId =
        typeof body.projectId === 'string'
          ? body.projectId.trim()
          : (url.searchParams.get('projectId') ?? '');
      if (!projectId && source === 'github') {
        projectId =
          chat
            .listProjects()
            .find((candidate) => candidate.status === 'active')?.id ?? '';
      }
      let groupId =
        typeof body.groupId === 'string'
          ? body.groupId.trim()
          : (url.searchParams.get('groupId') ?? '');
      if (!groupId && projectId) {
        groupId = work.ensureDefaultGroup(projectId).id;
      }
      const externalId =
        normalized?.externalId ??
        (typeof body.externalId === 'string' ? body.externalId.trim() : '');
      const title =
        normalized?.title ??
        (typeof body.title === 'string' ? body.title.trim() : '');
      const sourceBody =
        normalized?.body ??
        (typeof body.body === 'string' ? body.body : undefined);
      const sourceUrl =
        normalized?.url ??
        (typeof body.url === 'string' ? body.url : undefined);
      if (!projectId || !groupId || !externalId || !title) {
        fail(
          400,
          'E_WORK_SOURCE',
          '需要 projectId、groupId、externalId、title',
        );
        return true;
      }
      const rule = work.sourceRule(projectId, groupId, source);
      if (rule?.enabled === false) {
        io.json(response, 202, {
          ignored: true,
          reason: 'source 规则已停用',
        });
        return true;
      }
      if (normalized?.action) {
        const allowedActions =
          rule && rule.actions.length > 0
            ? rule.actions
            : (
                process.env.SPEC_AGENT_GITHUB_ACTIONS ??
                'opened,reopened,created,ready_for_review,submitted'
              )
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        if (
          !allowedActions.includes('*') &&
          !allowedActions.includes(normalized.action)
        ) {
          io.json(response, 202, {
            ignored: true,
            reason: `action ${normalized.action} 被过滤`,
            event: normalized.event,
            action: normalized.action,
          });
          return true;
        }
      }
      if (rule && normalized) {
        if (rule.labels.length > 0) {
          const labels = normalized.labels.map((label) =>
            label.toLowerCase(),
          );
          if (
            !rule.labels.some((label) =>
              labels.includes(label.toLowerCase()),
            )
          ) {
            io.json(response, 202, {
              ignored: true,
              reason: '没有匹配的 label',
            });
            return true;
          }
        }
        if (rule.authors.length > 0) {
          const author = (normalized.author ?? '').toLowerCase();
          if (
            !author ||
            !rule.authors.some(
              (candidate) => candidate.toLowerCase() === author,
            )
          ) {
            io.json(response, 202, {
              ignored: true,
              reason: '作者不在白名单',
            });
            return true;
          }
        }
      }
      const result = work.ingestSourceEvent({
        projectId,
        groupId,
        source,
        externalId,
        title,
        ...(sourceBody ? { body: sourceBody } : {}),
        ...(sourceUrl ? { url: sourceUrl } : {}),
        ...(normalized?.event ? { event: normalized.event } : {}),
        ...(normalized?.action ? { action: normalized.action } : {}),
        ...(typeof request.headers['x-github-delivery'] === 'string'
          ? { deliveryId: request.headers['x-github-delivery'] }
          : {}),
      });
      if (!result.duplicate && result.messageEvent) {
        const opened = work.openWorkItem({
          groupId,
          eventId: result.messageEvent.id,
          requestedBy: { type: 'user', id: 'github' },
          title,
          intent: sourceBody ?? '',
          assignee: 'assistant',
        });
        workExecutor?.startReady(opened.item.id);
      }
      io.json(response, result.duplicate ? 200 : 202, result);
      return true;
    }

  return false;
}
