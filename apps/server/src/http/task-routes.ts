/**
 * Hive HTTP server。
 *
 * 只做三件事：读任务/节点/闸门、审批、托管前端静态文件。
 * 没有 websocket；前端轮询。当前阶段够用，也少一层状态同步的坑。
 */

import { execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentConfig,
  AgentId,
  GateId,
  LlmNode,
  NodeId,
  TaskId,
  WorkflowSpec,
} from '@spec-agent/schema';
import { zWorkflowSpec } from '@spec-agent/schema';
import type { AgentRuntime, GateRow, ProviderConfig, TaskRow } from '@spec-agent/core';
import { GitCli, ShellCli, specHash, commitTrailer } from '@spec-agent/core';
import {
  agentsPath,
  assistText,
  createRuntime,
  loadAgents,
  parseAgents,
  planWorkflowWithUsage,
  PLAN_GATE_ID,
  saveAgents,
  type AiAssistKind,
  type SpecAgentRuntime,
  type PlannerLimits,
} from '@spec-agent/runtime';
import { ChatRepository, type ChatMode, type ChatPermissionMode } from '../chat/chat-store.js';
import { ChatService, type ChatTaskCreator, type PlannedTask } from '../chat/chat.js';
import { DshChatEngine, type ChatEngine } from '../dsh/dsh-chat.js';
import { ProjectPlanService } from '../chat/project-plans.js';
import type { ProjectPlanDetail } from '../chat/project-plans.js';
import { WorkStore, type WorkItemState } from '../work/work-store.js';
import { WorkService } from '../work/work-service.js';
import { WorkExecutor } from '../work/work-executor.js';
import { WorkTriage } from '../work/work-triage.js';
import { ContextAssembler } from '../infra/context-assembler.js';
import { WorkMemoryStore, WorkMemoryWriter } from '../work/work-memory.js';
import { PrivateAssistant } from '../assistant/private-assistant.js';
import { WorkPlanner } from '../work/work-planner.js';
import {
  OutboxWorker,
  createOutboxTransport,
} from '../work/outbox-worker.js';
import { handleWorkRequest } from './work-routes.js';
import type { TaskRouteIo } from './io.js';
import { handleAgentRoutes } from './agents-routes.js';
import { handleChatSessionRoutes } from './chat-session-routes.js';
import { handleAiRoutes } from './ai-routes.js';
import { handleTaskRoutes } from './task-query-routes.js';
import { cancelTask, streamChatReply, streamEvents } from './chat-routes.js';
import { createTask, handleProjectPlanRequest, updatePlan } from './task-plans.js';
import { errorStatus } from './errors.js';
import { blameFile, buildSessionTimeline, listCommits, showCommit, taskArtifact, taskFile, taskTimeline, toGate, toTask } from './task-files.js';
import { normalizeGitHubPayload } from '../integrations/github-source.js';
import { createEmbeddingProvider } from '../infra/embeddings.js';
import { MemoryJanitor } from '../work/memory-janitor.js';
import { diffLines } from '../infra/line-diff.js';
import {
  sourceSecret,
  verifySourceSignature,
} from '../integrations/source-signature.js';
import { AppError } from '@spec-agent/kernel';
import {
  createNotificationService,
  type NotificationOptions,
} from '../integrations/notifications.js';
import { handleLlmProxy } from '../infra/llm-proxy.js';
import {
  formatChecks,
  preflightRoot,
  validateServerConfig,
  type PreflightResult,
} from '../infra/preflight.js';
import {
  defaultProviderFile,
  loadProviderFile,
  providerFromEnvironment,
  publicProviderSettings,
  saveProviderFile,
  validateProviderInput,
  validateProviderRegistryInput,
  type ProviderFileData,
  type ProviderSettings,
} from '../infra/provider-config.js';
import {
  collectProjectMetrics,
  createHttpMetrics,
  recordHttp,
  renderPrometheus,
  type HttpMetrics,
} from '../infra/metrics.js';

const GIT = new GitCli();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
};


export async function api(
  runtime: SpecAgentRuntime,
  repo: string,
  projectRoot: string,
  planner: { agentRuntime?: AgentRuntime; provider: ProviderConfig; model: string },
  chat: ChatService,
  work: WorkService,
  workMemory: WorkMemoryStore,
  workExecutor: WorkExecutor | undefined,
  workTriage: WorkTriage | undefined,
  privateAssistant: PrivateAssistant | undefined,
  workPlanner: WorkPlanner | undefined,
  outboxWorker: OutboxWorker | undefined,
  plans: ProjectPlanService | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  io: TaskRouteIo,
): Promise<void> {
  if (request.method === 'GET' && path === '/api/events/stream') {
    streamEvents(runtime, request, response);
    return;
  }

  if (request.method === 'GET' && path === '/api/health') {
    io.json(response, 200, { ok: true, tasks: runtime.store.listTasks(1).length });
    return;
  }

  if (
    path === '/api/work' ||
    path.startsWith('/api/work/') ||
    path === '/api/github/webhook' ||
    path === '/api/github/status'
  ) {
    await handleWorkRequest(
      work,
      workMemory,
      workExecutor,
      workTriage,
      privateAssistant,
      workPlanner,
      outboxWorker,
      chat,
      request,
      response,
      path,
      url,
      io,
    );
    return;
  }

  if (await handleAiRoutes({ planner, request, response, path, io })) {
    return;
  }

  const chatError = (error: unknown): void => {
    if (error instanceof AppError) {
      const status =
        error.code === 'E_CHAT_NOT_FOUND' ||
        error.code === 'E_CHANGE_SET_NOT_FOUND' ||
        error.code === 'E_PROJECT_PLAN_DRAFT_NOT_FOUND' ||
        error.code === 'E_WORKFLOW_DRAFT_NOT_FOUND' ||
        error.code === 'E_MEMORY_NOT_FOUND'
          ? 404
          : error.code === 'E_EMPTY_MESSAGE' ||
              error.code === 'E_MESSAGE_TOO_LONG' ||
              error.code === 'E_CHAT_TITLE' ||
              error.code === 'E_CHAT_PROJECT' ||
              error.code === 'E_CHAT_PARTICIPANT' ||
              error.code === 'E_CHAT_PERMISSION'
            ? 400
            : error.code === 'E_CHANGE_SET_CLOSED' ||
                error.code === 'E_PROJECT_PLAN_DRAFT_CLOSED' ||
                error.code === 'E_WORKFLOW_DRAFT_CLOSED'
              ? 409
              : 422;
      io.json(response, status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  };

  if (await handleChatSessionRoutes({ chat, projectRoot, request, response, path, url, io, chatError })) {
    return;
  }

  const taskCostCache = new Map<string, number>();  const taskCost = (taskId: string): number => {
    const cached = taskCostCache.get(taskId);
    if (cached !== undefined) return cached;
    const task = runtime.store.getTask(taskId);
    if (!task) return 0;
    let total = task.costUsd;
    for (const child of runtime.store.listChildTasks(taskId)) {
      total += taskCost(child.id);
    }
    taskCostCache.set(taskId, total);
    return total;
  };

  if (await handleAgentRoutes({ runtime, repo, request, response, path, io })) {
    return;
  }

  if (path === '/api/project-plans' || path.startsWith('/api/project-plans/')) {
    if (!plans) {
      io.json(response, 503, {
        error: { code: 'E_PLANNER_UNAVAILABLE', message: '项目计划服务未启动' },
      });
      return;
    }
    await handleProjectPlanRequest(plans, chat, request, response, path, url, io);
    return;
  }

  if (await handleTaskRoutes({ runtime, repo, planner, request, response, path, url, io })) {
    return;
  }

  io.json(response, 404, { error: { code: 'E_NOT_FOUND', message: path } });
}




