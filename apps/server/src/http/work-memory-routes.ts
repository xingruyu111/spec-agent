import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatService } from '../chat/chat.js';
type WorkRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};
import { diffLines } from '../infra/line-diff.js';
import type { WorkMemoryStore } from '../work/work-memory.js';
import type { WorkService } from '../work/work-service.js';

type WorkMemoryRouteContext = {
  work: WorkService;
  workMemory: WorkMemoryStore;
  chat: ChatService;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: WorkRouteIo;
  fail: (status: number, code: string, message: string) => void;
};

export async function handleWorkMemoryRoutes(
  ctx: WorkMemoryRouteContext,
): Promise<boolean> {
  const { work, workMemory, chat, request, response, path, url, io, fail } = ctx;
  const memoryScopes = new Set([
    'org',
    'project',
    'group',
    'agent',
    'private',
    'execution',
  ]);

    if (request.method === 'GET' && path === '/api/work/memories') {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const hasQuery = url.searchParams.has('query');
      const query = url.searchParams.get('query') ?? '';
      if (hasQuery) {
        io.json(response, 200, {
          memories: await workMemory.searchAsync({
            projectId,
            query,
            limit: 30,
            fallback: false,
          }),
        });
        return true;
      }
      const scopeType = url.searchParams.get('scopeType') ?? '';
      const scopeId = url.searchParams.get('scopeId') ?? '';
      if (!memoryScopes.has(scopeType) || !scopeId) {
        fail(400, 'E_WORK_MEMORY', '需要 query 或 scopeType/scopeId');
        return true;
      }
      io.json(response, 200, {
        memories: workMemory.list({
          projectId,
          scopeType: scopeType as never,
          scopeId,
          limit: 100,
        }),
      });
      return true;
    }

    if (request.method === 'POST' && path === '/api/work/memories') {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const scopeType =
        typeof body.scopeType === 'string' ? body.scopeType : '';
      const scopeId =
        typeof body.scopeId === 'string' ? body.scopeId.trim() : '';
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      if (
        !projectId ||
        !memoryScopes.has(scopeType) ||
        !scopeId ||
        !content
      ) {
        fail(400, 'E_WORK_MEMORY', '需要 projectId、scopeType、scopeId、content');
        return true;
      }
      if (!chat.getProject(projectId)) {
        fail(404, 'E_WORK_PROJECT', `项目不存在：${projectId}`);
        return true;
      }
      if (scopeType === 'org' && scopeId !== 'org') {
        fail(400, 'E_WORK_MEMORY', 'org scopeId 必须是 org');
        return true;
      }
      if (scopeType === 'project' && scopeId !== projectId) {
        fail(400, 'E_WORK_MEMORY', 'project scopeId 必须等于 projectId');
        return true;
      }
      if (scopeType === 'group') {
        const group = work.getGroup(scopeId);
        if (!group || group.projectId !== projectId) {
          fail(400, 'E_WORK_MEMORY', 'group 不存在或不属于该项目');
          return true;
        }
      }
      const agentId =
        scopeType === 'agent'
          ? scopeId
          : typeof body.agentId === 'string'
            ? body.agentId
            : undefined;
      io.json(response, 201, {
        memory: workMemory.write({
          projectId,
          scopeType: scopeType as never,
          scopeId,
          content,
          source:
            typeof body.source === 'string' ? body.source : 'manual',
          ...(agentId ? { agentId } : {}),
          ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
          ...(typeof body.confidence === 'number'
            ? { confidence: body.confidence }
            : {}),
          ...(typeof body.expiresAt === 'string'
            ? { expiresAt: body.expiresAt }
            : {}),
          ...(Array.isArray(body.supersedes)
            ? {
                supersedes: body.supersedes.filter(
                  (id): id is string => typeof id === 'string',
                ),
              }
            : {}),
          ...(body.autoResolveConflicts === true
            ? { autoResolveConflicts: true }
            : {}),
        }),
      });
      return true;
    }

    if (request.method === 'POST' && path === '/api/work/memories/cleanup') {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      io.json(response, 200, {
        deleted: workMemory.cleanupExpired(projectId),
      });
      return true;
    }

    if (
      request.method === 'GET' &&
      path === '/api/work/memory-vectors/stats'
    ) {
      io.json(
        response,
        200,
        workMemory.embeddingStats(
          url.searchParams.get('projectId') ?? undefined,
        ),
      );
      return true;
    }

    if (
      request.method === 'POST' &&
      path === '/api/work/memory-vectors/cleanup'
    ) {
      const body = await io.readJson(request);
      const olderThanDays =
        typeof body.olderThanDays === 'number'
          ? Math.floor(body.olderThanDays)
          : 30;
      io.json(response, 200, {
        deleted: workMemory.cleanupVectors({
          olderThanDays,
        }),
      });
      return true;
    }

    const memoryDiffMatch =
      /^\/api\/work\/memories\/([^/]+)\/versions\/([^/]+)\/diff$/.exec(
        path,
      );
    if (request.method === 'GET' && memoryDiffMatch) {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const memoryId = decodeURIComponent(memoryDiffMatch[1]!);
      const versionId = decodeURIComponent(memoryDiffMatch[2]!);
      const version = workMemory
        .listVersions(memoryId, projectId)
        .find((candidate) => candidate.id === versionId);
      const current = workMemory.getMemory(memoryId, projectId);
      if (!version || !current) {
        fail(404, 'E_WORK_MEMORY', '版本或记忆不存在');
        return true;
      }
      io.json(response, 200, {
        before: version.content,
        after: current.content,
        lines: diffLines(version.content, current.content),
      });
      return true;
    }

    const memoryRestoreMatch =
      /^\/api\/work\/memories\/([^/]+)\/versions\/([^/]+)\/restore$/.exec(
        path,
      );
    if (request.method === 'POST' && memoryRestoreMatch) {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const memory = workMemory.restoreVersion(
        decodeURIComponent(memoryRestoreMatch[1]!),
        decodeURIComponent(memoryRestoreMatch[2]!),
        projectId,
      );
      if (!memory) {
        fail(404, 'E_WORK_MEMORY', '版本不存在');
        return true;
      }
      io.json(response, 200, { memory });
      return true;
    }

    const memoryVersionsMatch =
      /^\/api\/work\/memories\/([^/]+)\/versions$/.exec(path);
    if (request.method === 'GET' && memoryVersionsMatch) {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      io.json(response, 200, {
        versions: workMemory.listVersions(
          decodeURIComponent(memoryVersionsMatch[1]!),
          projectId,
        ),
      });
      return true;
    }

    const memoryEditMatch = /^\/api\/work\/memories\/([^/]+)$/.exec(path);
    if (request.method === 'PATCH' && memoryEditMatch) {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      if (!projectId || !content) {
        fail(400, 'E_WORK_MEMORY', '需要 projectId 和 content');
        return true;
      }
      const memory = workMemory.getMemory(
        decodeURIComponent(memoryEditMatch[1]!),
        projectId,
      );
      if (!memory) {
        fail(404, 'E_WORK_MEMORY', '记忆不存在');
        return true;
      }
      const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === 'string'
          ? body.expectedUpdatedAt
          : '';
      if (expectedUpdatedAt && expectedUpdatedAt !== memory.updatedAt) {
        fail(409, 'E_WORK_MEMORY_CONFLICT', '记忆已被修改，请刷新后重试');
        return true;
      }
      const updated = workMemory.updateContent(
        memory.id,
        projectId,
        content,
      );
      if (!updated) {
        fail(404, 'E_WORK_MEMORY', '记忆不存在');
        return true;
      }
      io.json(response, 200, { memory: updated });
      return true;
    }

    if (
      request.method === 'POST' &&
      path === '/api/work/memory-versions/cleanup'
    ) {
      const body = await io.readJson(request);
      io.json(response, 200, {
        deleted: workMemory.cleanupVersions({
          olderThanDays:
            typeof body.olderThanDays === 'number'
              ? body.olderThanDays
              : undefined,
          keepPerMemory:
            typeof body.keepPerMemory === 'number'
              ? body.keepPerMemory
              : undefined,
        }),
      });
      return true;
    }

    if (request.method === 'POST' && path === '/api/work/memories/conflicts') {
      const body = await io.readJson(request);
      const projectId =
        typeof body.projectId === 'string' ? body.projectId.trim() : '';
      const scopeType =
        typeof body.scopeType === 'string' ? body.scopeType : '';
      const scopeId =
        typeof body.scopeId === 'string' ? body.scopeId.trim() : '';
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      if (
        !projectId ||
        !memoryScopes.has(scopeType) ||
        !scopeId ||
        !content
      ) {
        fail(400, 'E_WORK_MEMORY', '需要 projectId、scopeType、scopeId、content');
        return true;
      }
      io.json(response, 200, {
        conflicts: workMemory.findConflicts({
          projectId,
          scopeType: scopeType as never,
          scopeId,
          content,
        }),
      });
      return true;
    }

    const memoryMatch = /^\/api\/work\/memories\/([^/]+)$/.exec(path);
    if (request.method === 'DELETE' && memoryMatch) {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const deleted = workMemory.delete(
        decodeURIComponent(memoryMatch[1]!),
        projectId,
      );
      if (!deleted) {
        fail(404, 'E_WORK_MEMORY', '记忆不存在');
        return true;
      }
      io.json(response, 200, { deleted: true });
      return true;
    }

  return false;
}

