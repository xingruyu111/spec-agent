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

export async function cancelTask(
  runtime: SpecAgentRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  taskId: string,
  io: TaskRouteIo,
): Promise<void> {
  const body = await io.readJson(request);
  const reason =
    typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : '用户取消';

  try {
    runtime.engine.cancelTask(taskId as TaskId, reason);
  } catch (error) {
    if (error instanceof AppError) {
      const status =
        error.code === 'E_TASK_NOT_FOUND'
          ? 404
          : error.code === 'E_TASK_TERMINAL'
            ? 409
            : 400;
      io.json(response, status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }

  const task = runtime.store.getTask(taskId);
  io.json(response, 200, { task: task ? toTask(task) : null });
}

export async function streamChatReply(
  chat: ChatService,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
  io: TaskRouteIo,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await io.readJson(request);
  } catch (error) {
    io.json(response, 400, {
      error: {
        code: 'E_CHAT_BODY',
        message: error instanceof Error ? error.message : '请求体不合法',
      },
    });
    return;
  }
  const content = typeof body.content === 'string' ? body.content : '';
  const mentions = Array.isArray(body.mentions)
    ? body.mentions.filter((item): item is string => typeof item === 'string')
    : [];
  const parallel = body.parallel === true;
  const mode: ChatMode | undefined =
    body.mode === 'task' ? 'task' : body.mode === 'qa' ? 'qa' : undefined;
  if (!mode) {
    io.json(response, 400, {
      error: { code: 'E_CHAT_MODE', message: 'mode 只能是 qa 或 task' },
    });
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
  response.write('retry: 3000\n\n');
  let closed = false;
  request.on('close', () => {
    closed = true;
  });
  const send = (event: string, data: unknown): void => {
    if (closed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let liveText = false;
    let liveReasoning = '';
    send('status', { status: mode === 'qa' ? '正在连接 DSH…' : '正在派发任务…' });
    const detail = await chat.sendMessage(sessionId, content, mode, {
      mentions,
      parallel,
      onStatus: (status) => send('status', { status }),
      onDelta: (delta) => {
        if (delta.kind === 'text') {
          liveText = true;
          send('delta', { text: delta.text });
        } else {
          liveReasoning += delta.text;
          send('reasoning', { text: liveReasoning });
        }
      },
    });
    const assistant = [...detail.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (!liveReasoning && assistant?.reasoning) {
      send('reasoning', { text: assistant.reasoning });
    }
    if (!liveText && assistant?.content) {
      const chars = Array.from(assistant.content);
      const chunkSize = Math.max(4, Math.ceil(chars.length / 70));
      for (let index = 0; index < chars.length; index += chunkSize) {
        send('delta', { text: chars.slice(index, index + chunkSize).join('') });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    }
    send('done', { detail });
  } catch (error) {
    send('error', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!response.writableEnded) response.end();
  }
}

export function streamEvents(
  runtime: SpecAgentRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  response.write(': connected\n\n');

  let last = runtime.store.events.lastSeq();
  const poll = setInterval(() => {
    if (response.writableEnded) return;
    try {
      const events = runtime.store.events.read({ afterSeq: last, limit: 200 });
      for (const event of events) {
        last = event.seq;
        response.write(
          `data: ${JSON.stringify({
            seq: event.seq,
            type: event.type,
            taskId: event.taskId ?? null,
          })}\n\n`,
        );
      }
    } catch {
      // 事件表暂时不可读时保持连接，下一轮再试
    }
  }, 500);

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(': ping\n\n');
  }, 15_000);

  const cleanup = (): void => {
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  request.on('close', cleanup);
  response.on('close', cleanup);
}


