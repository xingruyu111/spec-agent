import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GitCli } from '@spec-agent/core';
import type { ChatService } from '../chat/chat.js';
import type { ChatMode, ChatPermissionMode } from '../chat/chat-store.js';
import { streamChatReply } from './chat-routes.js';

type ChatRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  readRawBody: (request: IncomingMessage) => Promise<string>;
};

const GIT = new GitCli();

type ChatRouteContext = {
  chat: ChatService;
  projectRoot: string;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: ChatRouteIo;
  chatError: (error: unknown) => void;
};

export async function handleChatSessionRoutes(
  ctx: ChatRouteContext,
): Promise<boolean> {
  const { chat, projectRoot, request, response, path, url, io, chatError } = ctx;

  if (
    request.method === 'GET' &&
    (path === '/api/chat/projects' || path === '/api/chat/subprojects')
  ) {
    io.json(response, 200, { projects: chat.listProjects() });
    return true;
  }

  if (
    request.method === 'POST' &&
    (path === '/api/chat/projects' || path === '/api/chat/subprojects')
  ) {
    try {
      const body = await io.readJson(request);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        io.json(response, 400, {
          error: { code: 'E_CHAT_PROJECT', message: '项目名称不能为空' },
        });
        return true;
      }
      const requestedRoot =
        typeof body.root === 'string' && body.root.trim()
          ? body.root.trim()
          : '';
      if (requestedRoot && !isAbsolute(requestedRoot)) {
        io.json(response, 400, {
          error: { code: 'E_CHAT_PROJECT', message: '项目目录必须是绝对路径' },
        });
        return true;
      }
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'project';
      const managedRoot = requestedRoot
        ? resolve(requestedRoot)
        : join(projectRoot, 'projects', `${slug}-${Date.now().toString(36)}`);
      mkdirSync(managedRoot, { recursive: true });
      if (!existsSync(join(managedRoot, '.git'))) {
        await GIT.initRepo(managedRoot);
      }
      const project = chat.createProject({
        name,
        root: managedRoot,
        repoPath: managedRoot,
      });
      io.json(response, 201, { project });
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const chatProjectMatch =
    /^\/api\/chat\/(?:projects|subprojects)\/([^/]+)$/.exec(path);
  if (request.method === 'DELETE' && chatProjectMatch) {
    try {
      chat.deleteProject(decodeURIComponent(chatProjectMatch[1]!));
      io.json(response, 200, { removed: true });
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  if (request.method === 'GET' && path === '/api/chat/sessions') {
    io.json(response, 200, { sessions: chat.listSessions() });
    return true;
  }

  if (request.method === 'POST' && path === '/api/chat/sessions') {
    try {
      const body = await io.readJson(request);
      const mode = body.mode === 'task' ? 'task' : body.mode === 'qa' ? 'qa' : undefined;
      const session = chat.createSession({
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(mode ? { mode } : {}),
        ...(body.kind === 'assistant' || body.kind === 'direct' || body.kind === 'group'
          ? { kind: body.kind }
          : {}),
        ...(typeof body.primaryAgentId === 'string'
          ? { primaryAgentId: body.primaryAgentId }
          : {}),
        ...(typeof body.projectId === 'string'
          ? { projectId: body.projectId }
          : {}),
        ...(Array.isArray(body.participantAgentIds)
          ? {
              participantAgentIds: body.participantAgentIds.filter(
                (item): item is string => typeof item === 'string',
              ),
            }
          : {}),
        ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(body.permissionMode === 'read-only' ||
        body.permissionMode === 'workspace-write' ||
        body.permissionMode === 'danger-full-access'
          ? { permissionMode: body.permissionMode }
          : {}),
      });
      io.json(response, 201, {
        session,
        participants: chat.getSessionDetail(session.id).participants,
        messages: [],
      });
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const chatParticipantsMatch =
    /^\/api\/chat\/sessions\/([^/]+)\/participants(?:\/([^/]+))?$/.exec(path);
  if (chatParticipantsMatch) {
    const sessionId = decodeURIComponent(chatParticipantsMatch[1]!);
    try {
      if (request.method === 'POST' && !chatParticipantsMatch[2]) {
        const body = await io.readJson(request);
        if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
          io.json(response, 400, {
            error: { code: 'E_CHAT_PARTICIPANT', message: '需要 agentId' },
          });
          return true;
        }
        const participant = chat.addParticipant(sessionId, body.agentId);
        io.json(response, 201, { participant });
        return true;
      }
      if (request.method === 'DELETE' && chatParticipantsMatch[2]) {
        const removed = chat.removeParticipant(
          sessionId,
          decodeURIComponent(chatParticipantsMatch[2]),
        );
        if (!removed) {
          io.json(response, 409, {
            error: { code: 'E_CHAT_PARTICIPANT', message: '不能移除助理或成员不存在' },
          });
          return true;
        }
        io.json(response, 200, { removed: true });
        return true;
      }
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const chatSessionMatch = /^\/api\/chat\/sessions\/([^/]+)$/.exec(path);
  if (chatSessionMatch) {
    const sessionId = decodeURIComponent(chatSessionMatch[1]!);
    try {
      if (request.method === 'GET') {
        io.json(response, 200, chat.getSessionDetail(sessionId));
        return true;
      }
      if (request.method === 'PATCH') {
        const body = await io.readJson(request);
        const hasMode = body.mode === 'qa' || body.mode === 'task';
        const hasPermission =
          body.permissionMode === 'read-only' ||
          body.permissionMode === 'workspace-write' ||
          body.permissionMode === 'danger-full-access';
        const hasRoute =
          typeof body.providerId === 'string' && typeof body.model === 'string';
        const hasTitle = typeof body.title === 'string';
        if (!hasMode && !hasRoute && !hasTitle && !hasPermission) {
          io.json(response, 400, {
            error: { code: 'E_CHAT_MODE', message: '需要 title、mode、权限或 providerId/model' },
          });
          return true;
        }
        let session = hasTitle
          ? chat.renameSession(sessionId, body.title as string)
          : undefined;
        if (hasRoute) {
          session = chat.setRoute(sessionId, body.providerId as string, body.model as string);
        }
        if (hasPermission) {
          session = chat.setPermissionMode(sessionId, body.permissionMode as ChatPermissionMode);
        }
        if (hasMode) session = chat.setMode(sessionId, body.mode as ChatMode);
        io.json(response, 200, { session });
        return true;
      }
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const chatStreamMatch = /^\/api\/chat\/sessions\/([^/]+)\/stream$/.exec(path);
  if (request.method === 'POST' && chatStreamMatch) {
    await streamChatReply(
      chat,
      decodeURIComponent(chatStreamMatch[1]!),
      request,
      response, io
    );
    return true;
  }

  const chatMessagesMatch = /^\/api\/chat\/sessions\/([^/]+)\/messages$/.exec(path);
  if (request.method === 'POST' && chatMessagesMatch) {
    const sessionId = decodeURIComponent(chatMessagesMatch[1]!);
    try {
      const body = await io.readJson(request);
      const content = typeof body.content === 'string' ? body.content : '';
      const mode: ChatMode | undefined =
        body.mode === 'task' ? 'task' : body.mode === 'qa' ? 'qa' : undefined;
      if (!mode) {
        io.json(response, 400, {
          error: { code: 'E_CHAT_MODE', message: 'mode 只能是 qa 或 task' },
        });
        return true;
      }
      const mentions = Array.isArray(body.mentions)
        ? body.mentions.filter((item): item is string => typeof item === 'string')
        : [];
      const parallel = body.parallel === true;
      io.json(response, 200, await chat.sendMessage(sessionId, content, mode, {
        mentions,
        parallel,
      }));
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const changeApplyMatch = /^\/api\/change-sets\/([^/]+)\/(apply|reject)$/.exec(path);
  if (request.method === 'POST' && changeApplyMatch) {
    const id = decodeURIComponent(changeApplyMatch[1]!);
    try {
      if (changeApplyMatch[2] === 'apply') {
        const result = chat.applyChangeSet(id);
        const detail = await chat.continueAfterChangeSet(id);
        io.json(response, 200, {
          changeSet: result.changeSet,
          agents: result.agents,
          detail,
        });
      } else {
        io.json(response, 200, { changeSet: chat.rejectChangeSet(id) });
      }
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const workflowDraftMatch =
    /^\/api\/chat\/workflow-drafts\/([^/]+)\/(confirm|reject)$/.exec(path);
  if (request.method === 'POST' && workflowDraftMatch) {
    const id = decodeURIComponent(workflowDraftMatch[1]!);
    try {
      if (workflowDraftMatch[2] === 'confirm') {
        io.json(response, 200, {
          detail: await chat.confirmWorkflowDraft(id),
        });
      } else {
        io.json(response, 200, {
          draft: chat.rejectWorkflowDraft(id),
        });
      }
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  const planDraftMatch = /^\/api\/project-plan-drafts\/([^/]+)\/(apply|reject)$/.exec(path);
  if (request.method === 'POST' && planDraftMatch) {
    const id = decodeURIComponent(planDraftMatch[1]!);
    try {
      if (planDraftMatch[2] === 'apply') {
        io.json(response, 200, {
          projectPlanDraft: await chat.applyProjectPlanDraft(id),
        });
      } else {
        io.json(response, 200, {
          projectPlanDraft: chat.rejectProjectPlanDraft(id),
        });
      }
      return true;
    } catch (error) {
      chatError(error);
      return true;
    }
  }

  if (request.method === 'GET' && path === '/api/memories') {
    const agentId = url.searchParams.get('agentId');
    io.json(response, 200, { memories: chat.listMemories(agentId) });
    return true;
  }

  return false;
}
