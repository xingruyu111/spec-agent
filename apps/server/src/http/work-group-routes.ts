import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatService } from '../chat/chat.js';
import type { PrivateAssistant } from '../assistant/private-assistant.js';
import type { WorkExecutor } from '../work/work-executor.js';
import type { WorkService } from '../work/work-service.js';
import type { WorkTriage } from '../work/work-triage.js';

type WorkGroupRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};

type WorkGroupRouteContext = {
  work: WorkService;
  workTriage: WorkTriage | undefined;
  privateAssistant: PrivateAssistant | undefined;
  workExecutor: WorkExecutor | undefined;
  chat: ChatService;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: WorkGroupRouteIo;
  fail: (status: number, code: string, message: string) => void;
};

export async function handleWorkGroupRoutes(
  ctx: WorkGroupRouteContext,
): Promise<boolean> {
  const { work, workTriage, privateAssistant, workExecutor, chat, request, response, path, url, io, fail } = ctx;

    if (request.method === 'GET' && path === '/api/work/groups') {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      io.json(response, 200, { groups: work.listGroups(projectId) });
      return true;
    }

    if (request.method === 'POST' && path === '/api/work/groups') {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!projectId || !name) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId 和 name');
        return true;
      }
      if (!chat.getProject(projectId)) {
        fail(404, 'E_WORK_PROJECT', `项目不存在：${projectId}`);
        return true;
      }
      const members: Array<{
        type: 'user' | 'agent' | 'system';
        id: string;
        role?: string;
      }> | undefined = Array.isArray(body.members)
        ? body.members
            .filter(
              (member): member is { type: string; id: string; role?: string } =>
                typeof member === 'object' &&
                member !== null &&
                typeof (member as { type?: unknown }).type === 'string' &&
                typeof (member as { id?: unknown }).id === 'string',
            )
            .map((member) => ({
              type:
                member.type === 'agent' || member.type === 'system'
                  ? member.type
                  : 'user',
              id: member.id,
              ...(member.role ? { role: member.role } : {}),
            }))
        : undefined;
      io.json(response, 201, {
        group: work.createGroup({
          projectId,
          name,
          topic: typeof body.topic === 'string' ? body.topic : null,
          ...(members ? { members } : {}),
        }),
      });
      return true;
    }

    const groupMatch = /^\/api\/work\/groups\/([^/]+)(?:\/(messages|events|triage|assistant-triage|members|reply))?$/.exec(
      path,
    );
    if (groupMatch) {
      const groupId = decodeURIComponent(groupMatch[1]!);
      const group = work.getGroup(groupId);
      if (!group) {
        fail(404, 'E_WORK_GROUP', `群聊不存在：${groupId}`);
        return true;
      }
      if (request.method === 'GET' && groupMatch[2] === 'events') {
        io.json(response, 200, { events: work.listEvents(groupId, 200) });
        return true;
      }
      if (groupMatch[2] === 'members') {
        if (request.method === 'GET') {
          io.json(response, 200, { members: work.listGroupMembers(groupId) });
          return true;
        }
        if (request.method === 'POST') {
          const body = await io.readJson(request);
          const agentId =
            typeof body.agentId === 'string' ? body.agentId.trim() : '';
          if (!agentId) {
            fail(400, 'E_WORK_ITEM', '需要 agentId');
            return true;
          }
          io.json(response, 200, {
            members: work.addGroupMember(groupId, agentId),
          });
          return true;
        }
      }
      if (request.method === 'POST' && groupMatch[2] === 'reply') {
        const body = await io.readJson(request);
        const content =
          typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) {
          fail(400, 'E_WORK_ITEM', '需要 content');
          return true;
        }
        io.json(response, 200, {
          event: work.postAssistantMessage({
            groupId,
            content,
            correlationId: `agent-reply:${groupId}`,
          }),
        });
        return true;
      }
      if (request.method === 'POST' && groupMatch[2] === 'assistant-triage') {
        if (!workTriage) {
          fail(503, 'E_WORK_TRIAGE', '没有配置可用的 AgentRuntime');
          return true;
        }
        const body = await io.readJson(request);
        const eventId =
          typeof body.eventId === 'string' ? body.eventId.trim() : '';
        if (!eventId) {
          fail(400, 'E_WORK_ITEM', '需要 eventId');
          return true;
        }
        io.json(response, 200, await workTriage.triage(groupId, eventId));
        return true;
      }
      if (request.method === 'POST' && groupMatch[2] === 'triage') {
        const body = await io.readJson(request);
        const eventId =
          typeof body.eventId === 'string' ? body.eventId.trim() : '';
        if (!eventId) {
          fail(400, 'E_WORK_ITEM', '需要 eventId');
          return true;
        }
        io.json(
          response,
          201,
          (() => {
            const triaged = work.triageMessage({
              groupId,
              eventId,
              ...(typeof body.title === 'string'
                ? { title: body.title }
                : {}),
              ...(typeof body.assignee === 'string' && body.assignee
                ? { assignee: body.assignee }
                : {}),
            });
            if (body.start === true) {
              const detail = work.getWorkItemDetail(triaged.item.id);
              if (detail && detail.assignments.length === 0) {
                work.assignWorkItem(triaged.item.id, 'assistant');
              }
              workExecutor?.startReady(triaged.item.id);
            }
            return triaged;
          })(),
        );
        return true;
      }
      if (request.method === 'POST' && groupMatch[2] === 'messages') {
        const body = await io.readJson(request);
        const content =
          typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) {
          fail(400, 'E_WORK_MESSAGE', '消息不能为空');
          return true;
        }
        const authorType =
          body.authorType === 'agent' || body.authorType === 'system'
            ? body.authorType
            : 'user';
        const authorId =
          typeof body.authorId === 'string' && body.authorId.trim()
            ? body.authorId.trim()
            : 'local-user';
        const mentions = Array.isArray(body.mentions)
          ? body.mentions.filter(
              (mention): mention is string => typeof mention === 'string',
            )
          : [];
        io.json(
          response,
          201,
          work.intakeGroupMessage({
            groupId,
            author: { type: authorType, id: authorId },
            content,
            mentions,
            ...(typeof body.dedupeKey === 'string'
              ? { dedupeKey: body.dedupeKey }
              : {}),
            ...(typeof body.correlationId === 'string'
              ? { correlationId: body.correlationId }
              : {}),
          }),
        );
        return true;
      }
    }

    const privateStreamMatch =
      /^\/api\/work\/private\/([^/]+)\/stream$/.exec(path);
    if (request.method === 'POST' && privateStreamMatch) {
      if (!privateAssistant) {
        fail(503, 'E_WORK_TRIAGE', '没有配置可用的 ChatEngine');
        return true;
      }
      const agentId = decodeURIComponent(privateStreamMatch[1]!);
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      if (!projectId || !content) {
        fail(400, 'E_WORK_PRIVATE', '需要 projectId 和 content');
        return true;
      }
      if (!chat.getProject(projectId)) {
        fail(404, 'E_WORK_PROJECT', `项目不存在：${projectId}`);
        return true;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const sendEvent = (event: string, data: unknown): void => {
        response.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
      };
      sendEvent('status', { status: 'thinking' });
      try {
        const result = await privateAssistant.answerStream(
          {
            projectId,
            agentId,
            userId:
              typeof body.userId === 'string' && body.userId
                ? body.userId
                : 'local-user',
            content,
          },
          {
            onDelta: (delta) => sendEvent('delta', { text: delta }),
            onStatus: (status) => sendEvent('status', { status }),
            onReasoning: (text) => sendEvent('reasoning', { text }),
          },
        );
        sendEvent('done', result);
      } catch (error) {
        sendEvent('error', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      response.end();
      return true;
    }

    const privateMatch = /^\/api\/work\/private\/([^/]+)(?:\/messages)?$/.exec(
      path,
    );
    if (privateMatch) {
      const agentId = decodeURIComponent(privateMatch[1]!);
      if (request.method === 'GET' && !privateMatch[0].endsWith('/messages')) {
        const projectId = url.searchParams.get('projectId') ?? '';
        if (!projectId) {
          fail(400, 'E_WORK_PROJECT', '需要 projectId');
          return true;
        }
        io.json(
          response,
          200,
          work.privateMessages(
            projectId,
            agentId,
            url.searchParams.get('userId') ?? 'local-user',
          ),
        );
        return true;
      }
      if (request.method === 'POST' && privateMatch[0].endsWith('/messages')) {
        const body = await io.readJson(request);
        const projectId =
          typeof body.projectId === 'string' ? body.projectId.trim() : '';
        const content =
          typeof body.content === 'string' ? body.content.trim() : '';
        if (!projectId || !content) {
          fail(400, 'E_WORK_PRIVATE', '需要 projectId 和 content');
          return true;
        }
        if (!chat.getProject(projectId)) {
          fail(404, 'E_WORK_PROJECT', `项目不存在：${projectId}`);
          return true;
        }
        const userId =
          typeof body.userId === 'string' && body.userId
            ? body.userId
            : 'local-user';
        const targetGroupId =
          typeof body.targetGroupId === 'string' && body.targetGroupId
            ? body.targetGroupId
            : '';
        if (!targetGroupId && privateAssistant) {
          io.json(
            response,
            201,
            await privateAssistant.answer({
              projectId,
              agentId,
              userId,
              content,
            }),
          );
          return true;
        }
        const result = work.sendPrivateMessage({
          projectId,
          agentId,
          userId,
          content,
          ...(targetGroupId ? { targetGroupId } : {}),
        });
        if (result.groupEvent && workTriage) {
          void workTriage
            .triage(result.groupEvent.groupId!, result.groupEvent.id)
            .catch((error: unknown) => {
              console.error('[private-triage]', error);
            });
        }
        io.json(response, 201, result);
        return true;
      }
    }

  return false;
}
