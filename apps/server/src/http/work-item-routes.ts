import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkExecutor } from '../work/work-executor.js';
import type { WorkPlanner } from '../work/work-planner.js';
import type { WorkItemState } from '../work/work-store.js';
import type { WorkService } from '../work/work-service.js';

type WorkItemRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};

type WorkItemRouteContext = {
  work: WorkService;
  workExecutor: WorkExecutor | undefined;
  workPlanner: WorkPlanner | undefined;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: WorkItemRouteIo;
  fail: (status: number, code: string, message: string) => void;
};

export async function handleWorkItemRoutes(
  ctx: WorkItemRouteContext,
): Promise<boolean> {
  const { work, workExecutor, workPlanner, request, response, path, url, io, fail } = ctx;

    if (request.method === 'GET' && path === '/api/work/dead-letters') {
      const projectId = url.searchParams.get('projectId') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      io.json(response, 200, { deadLetters: work.deadLetters(projectId) });
      return true;
    }

    if (request.method === 'GET' && path === '/api/work/items') {
      const projectId = url.searchParams.get('projectId') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (!projectId) {
        fail(400, 'E_WORK_PROJECT', '需要 projectId');
        return true;
      }
      const validStates = new Set<WorkItemState>([
        'inbox', 'triaged', 'ready', 'running', 'waiting_human',
        'blocked', 'reviewing', 'done', 'failed', 'cancelled',
      ]);
      io.json(response, 200, {
        items: work.listWorkItems(
          projectId,
          validStates.has(state as WorkItemState)
            ? (state as WorkItemState)
            : undefined,
        ),
      });
      return true;
    }

    if (request.method === 'POST' && path === '/api/work/items') {
      const body = await io.readJson(request);
      const groupId =
        typeof body.groupId === 'string' ? body.groupId.trim() : '';
      const eventId =
        typeof body.eventId === 'string' ? body.eventId.trim() : '';
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!groupId || !eventId || !title) {
        fail(400, 'E_WORK_ITEM', '需要 groupId、eventId 和 title');
        return true;
      }
      const group = work.getGroup(groupId);
      if (!group) {
        fail(404, 'E_WORK_GROUP', `群聊不存在：${groupId}`);
        return true;
      }
      const requestedByType =
        body.requestedByType === 'agent' ? 'agent' : 'user';
      io.json(
        response,
        201,
        work.openWorkItem({
          groupId,
          eventId,
          requestedBy: {
            type: requestedByType,
            id:
              typeof body.requestedById === 'string'
                ? body.requestedById
                : 'local-user',
          },
          title,
          intent: typeof body.intent === 'string' ? body.intent : null,
          ...(typeof body.assignee === 'string'
            ? { assignee: body.assignee }
            : {}),
        }),
      );
      return true;
    }

    const commentMatch =
      /^\/api\/work\/items\/([^/]+)\/comments\/([^/]+)$/.exec(path);
    if (commentMatch && request.method === 'PATCH') {
      const body = await io.readJson(request);
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        fail(400, 'E_WORK_COMMENT', '评论不能为空');
        return true;
      }
      io.json(
        response,
        200,
        work.editWorkItemComment({
          workItemId: decodeURIComponent(commentMatch[1]!),
          commentId: decodeURIComponent(commentMatch[2]!),
          content,
        }),
      );
      return true;
    }
    if (commentMatch && request.method === 'DELETE') {
      io.json(response, 200, {
        deleted: work.deleteWorkItemComment(
          decodeURIComponent(commentMatch[1]!),
          decodeURIComponent(commentMatch[2]!),
        ),
      });
      return true;
    }

    const commentsMatch =
      /^\/api\/work\/items\/([^/]+)\/comments$/.exec(path);
    if (commentsMatch && request.method === 'GET') {
      io.json(response, 200, {
        comments: work.listWorkItemComments(
          decodeURIComponent(commentsMatch[1]!),
        ),
      });
      return true;
    }
    if (commentsMatch && request.method === 'POST') {
      const body = await io.readJson(request);
      const content =
        typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        fail(400, 'E_WORK_COMMENT', '评论不能为空');
        return true;
      }
      if (body.agentId || /@[A-Za-z0-9_-]+/.test(content)) {
        const mention = /@([A-Za-z0-9_-]+)/.exec(content)?.[1];
        const agentId =
          typeof body.agentId === 'string' && body.agentId
            ? body.agentId
            : mention;
        if (!agentId) {
          fail(400, 'E_WORK_COMMENT', '无法解析 @Agent');
          return true;
        }
        const result = work.commentAndAssign({
          workItemId: decodeURIComponent(commentsMatch[1]!),
          authorType: 'user',
          authorId:
            typeof body.authorId === 'string' && body.authorId
              ? body.authorId
              : 'local-user',
          content,
          agentId,
        });
        workExecutor?.startReady(result.assignment.workItemId);
        io.json(response, 201, result);
        return true;
      }
      io.json(
        response,
        201,
        work.addWorkItemComment({
          workItemId: decodeURIComponent(commentsMatch[1]!),
          authorType: 'user',
          authorId:
            typeof body.authorId === 'string' && body.authorId
              ? body.authorId
              : 'local-user',
          content,
        }),
      );
      return true;
    }

    const itemMatch = /^\/api\/work\/items\/([^/]+)(?:\/(assign|state|plan))?$/.exec(
      path,
    );
    if (request.method === 'PATCH' && itemMatch && !itemMatch[2]) {
      const body = await io.readJson(request);
      const priority = Number(body.priority);
      if (!Number.isInteger(priority)) {
        fail(400, 'E_WORK_ITEM', 'priority 必须是整数');
        return true;
      }
      io.json(
        response,
        200,
        work.setWorkItemPriority(
          decodeURIComponent(itemMatch[1]!),
          priority,
        ),
      );
      return true;
    }
    if (request.method === 'GET' && itemMatch && !itemMatch[2]) {
      const detail = work.getWorkItemDetail(decodeURIComponent(itemMatch[1]!));
      if (!detail) {
        fail(404, 'E_WORK_ITEM', '工作项不存在');
        return true;
      }
      io.json(response, 200, detail);
      return true;
    }
    const planStageMatch =
      /^\/api\/work\/items\/([^/]+)\/plan\/(preview|apply)$/.exec(path);
    if (request.method === 'POST' && planStageMatch) {
      if (!workPlanner) {
        fail(503, 'E_WORK_PLANNER', '没有配置可用的 AgentRuntime');
        return true;
      }
      const itemId = decodeURIComponent(planStageMatch[1]!);
      if (planStageMatch[2] === 'preview') {
        io.json(response, 200, await workPlanner.propose(itemId));
        return true;
      }
      const body = await io.readJson(request);
      const planned = Array.isArray(body.planned)
        ? body.planned
            .filter(
              (value): value is { agentId: string; dependsOn?: unknown } =>
                typeof value === 'object' &&
                value !== null &&
                typeof (value as { agentId?: unknown }).agentId === 'string',
            )
            .map((value) => ({
              agentId: value.agentId,
              dependsOn: Array.isArray(value.dependsOn)
                ? value.dependsOn.filter(
                    (dependency): dependency is number =>
                      typeof dependency === 'number' &&
                      Number.isInteger(dependency),
                  )
                : [],
            }))
        : [];
      const applied = workPlanner.apply(itemId, planned);
      const started = workExecutor ? workExecutor.startReady(itemId) : [];
      io.json(response, 201, { ...applied, started });
      return true;
    }
    if (request.method === 'POST' && itemMatch?.[2] === 'plan') {
      if (!workPlanner) {
        fail(503, 'E_WORK_PLANNER', '没有配置可用的 AgentRuntime');
        return true;
      }
      io.json(
        response,
        201,
        await workPlanner.plan(decodeURIComponent(itemMatch[1]!)),
      );
      return true;
    }
    if (request.method === 'POST' && itemMatch?.[2] === 'assign') {
      const body = await io.readJson(request);
      const agentId =
        typeof body.agentId === 'string' ? body.agentId.trim() : '';
      if (!agentId) {
        fail(400, 'E_WORK_ASSIGN', '需要 agentId');
        return true;
      }
      io.json(
        response,
        200,
        work.assignWorkItem(
          decodeURIComponent(itemMatch[1]!),
          agentId,
          Array.isArray(body.dependsOn)
            ? body.dependsOn.filter(
                (id): id is string => typeof id === 'string',
              )
            : [],
        ),
      );
      return true;
    }
    if (request.method === 'POST' && itemMatch?.[2] === 'state') {
      const body = await io.readJson(request);
      const states = new Set<WorkItemState>([
        'inbox', 'triaged', 'ready', 'running', 'waiting_human',
        'blocked', 'reviewing', 'done', 'failed', 'cancelled',
      ]);
      if (!states.has(body.state as WorkItemState)) {
        fail(400, 'E_WORK_STATE', '无效的 Work Item 状态');
        return true;
      }
      io.json(response, 200, {
        item: work.setWorkItemState(
          decodeURIComponent(itemMatch[1]!),
          body.state as WorkItemState,
        ),
      });
      return true;
    }

    const assignmentMatch =
      /^\/api\/work\/assignments\/([^/]+)\/(start|report|execute|cancel|retry|requeue)$/.exec(
        path,
      );
    if (request.method === 'POST' && assignmentMatch) {
      const assignmentId = decodeURIComponent(assignmentMatch[1]!);
      const action = assignmentMatch[2];
      const body = await io.readJson(request);
      if (action === 'requeue') {
        io.json(response, 200, {
          assignment: work.requeueDeadLetter(assignmentId, {
            ...(typeof body.maxAttempts === 'number'
              ? { maxAttempts: body.maxAttempts }
              : {}),
          }),
        });
        return true;
      }
      if (action === 'cancel') {
        io.json(response, 200, {
          assignment: workExecutor
            ? workExecutor.cancel(assignmentId)
            : work.cancelAssignment(assignmentId),
        });
        return true;
      }
      if (action === 'retry') {
        io.json(response, 200, {
          assignment: workExecutor
            ? workExecutor.retry(assignmentId)
            : work.retryAssignment(assignmentId),
        });
        return true;
      }
      if (action === 'execute') {
        if (!workExecutor) {
          fail(503, 'E_WORK_EXECUTOR', '没有配置可用的 AgentRuntime');
          return true;
        }
        const dependencies = work.dependenciesSatisfied(assignmentId);
        if (!dependencies.ready) {
          fail(
            409,
            'E_WORK_DEPENDENCY',
            `依赖未完成：${dependencies.pending.join(', ')}`,
          );
          return true;
        }
        io.json(response, 202, {
          assignment: workExecutor.execute(assignmentId),
          started: true,
        });
        return true;
      }
      if (action === 'start') {
        io.json(response, 200, {
          assignment: work.startAssignment(
            assignmentId,
            typeof body.runId === 'string' ? body.runId : undefined,
          ),
        });
        return true;
      }
      const kind =
        body.kind === 'blocked' ||
        body.kind === 'question' ||
        body.kind === 'review' ||
        body.kind === 'progress'
          ? body.kind
          : 'done';
      io.json(
        response,
        200,
        work.reportAssignment({
          assignmentId,
          kind,
          summary:
            typeof body.summary === 'string' && body.summary.trim()
              ? body.summary.trim()
              : '已完成',
          artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
        }),
      );
      return true;
    }

  return false;
}
