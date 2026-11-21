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

import type { TaskRouteIo } from './io.js';

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


export async function listCommits(
  runtime: SpecAgentRuntime,
  repo: string,
  response: ServerResponse,
  taskId: string,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }

  try {
    const commits = await GIT.log(task.repoPath ?? repo, taskBranch(task), 50);
    io.json(response, 200, { commits });
  } catch {
    // 任务还没产生 worktree/分支
    io.json(response, 200, { commits: [] });
  }
}

export async function showCommit(
  runtime: SpecAgentRuntime,
  repo: string,
  response: ServerResponse,
  taskId: string,
  sha: string,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }

  const commits = await GIT.log(task.repoPath ?? repo, taskBranch(task), 200).catch(() => []);
  if (!commits.some((commit) => commit.hash.startsWith(sha))) {
    io.json(response, 404, {
      error: { code: 'E_COMMIT_NOT_FOUND', message: sha },
    });
    return;
  }

  const { patch, files } = await GIT.show(task.repoPath ?? repo, sha);
  io.json(response, 200, { commit: sha, patch, files });
}

export async function blameFile(
  runtime: SpecAgentRuntime,
  repo: string,
  response: ServerResponse,
  taskId: string,
  url: URL,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }

  const path = url.searchParams.get('path');
  if (!path) {
    io.json(response, 400, { error: { code: 'E_PATH_REQUIRED', message: 'path 必填' } });
    return;
  }
  const line = Math.max(1, Number(url.searchParams.get('line') ?? 1));

  try {
    const entry = await GIT.blame({
      dir: task.repoPath ?? repo,
      path,
      line,
      ref: taskBranch(task),
    });
    io.json(response, 200, entry);
  } catch (error) {
    if (error instanceof AppError) {
      io.json(response, 404, { error: { code: 'E_BLAME_FAILED', message: error.message } });
      return;
    }
    throw error;
  }
}

type SessionTimelineNode = {
  id: string;
  runId: string;
  nodeId: string;
  status: string;
  costUsd: number;
  transcriptRef: string | null;
  sessionKey: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export function buildSessionTimeline(nodes: SessionTimelineNode[]) {
  const groups = new Map<
    string,
    {
      id: string;
      runId: string;
      nodeRunIds: string[];
      nodeIds: string[];
      startedAt: string;
      endedAt: string | null;
      costUsd: number;
      nodes: Array<{ id: string; nodeId: string; status: string; costUsd: number }>;
    }
  >();
  for (const node of nodes) {
    if (!node.transcriptRef) continue;
    const id = node.transcriptRef.startsWith('sdk://')
      ? node.transcriptRef.slice('sdk://'.length)
      : node.transcriptRef;
    const group = groups.get(id) ?? {
      id,
      runId: node.runId,
      nodeRunIds: [],
      nodeIds: [],
      startedAt: node.createdAt,
      endedAt: node.finishedAt,
      costUsd: 0,
      nodes: [],
    };
    group.nodeRunIds.push(node.id);
    group.nodeIds.push(node.nodeId);
    group.costUsd += node.costUsd;
    group.endedAt = node.finishedAt ?? group.endedAt;
    if (node.createdAt < group.startedAt) group.startedAt = node.createdAt;
    group.nodes.push({
      id: node.id,
      nodeId: node.nodeId,
      status: node.status,
      costUsd: node.costUsd,
    });
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function taskBranch(task: TaskRow): string {
  return `agent/${task.assignee}/${task.id}`;
}

export function toTask(task: TaskRow, costUsd = task.costUsd) {
  return {
    id: task.id,
    parentId: task.parentId,
    assignee: task.assignee,
    caller: task.caller,
    title: task.title,
    status: task.status,
    costUsd,
    planCostUsd: task.planCostUsd,
    originNodeRunId: task.originNodeRunId,
    repoPath: task.repoPath,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
  };
}

export async function taskArtifact(
  runtime: SpecAgentRuntime,
  repo: string,
  response: ServerResponse,
  taskId: string,
  url: URL,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }
  const rawPath = url.searchParams.get('path') ?? '';
  const artifactPath = normalize(rawPath).replace(/\\/g, '/');
  if (
    !artifactPath ||
    artifactPath.startsWith('/') ||
    artifactPath.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    io.json(response, 400, { error: { code: 'E_PATH_INVALID', message: rawPath } });
    return;
  }
  const branch = taskBranch(task);
  const taskRepo = task.repoPath ?? repo;
  const ref = url.searchParams.get('ref') || branch;
  if (ref !== branch) {
    if (!/^[0-9a-f]{7,40}$/.test(ref)) {
      io.json(response, 400, { error: { code: 'E_REF_INVALID', message: ref } });
      return;
    }
    const commits = await GIT.log(taskRepo, branch, 200).catch(() => []);
    if (!commits.some((commit) => commit.hash.startsWith(ref))) {
      io.json(response, 404, { error: { code: 'E_COMMIT_NOT_FOUND', message: ref } });
      return;
    }
  }
  try {
    const content = await GIT.fileBufferAt(taskRepo, ref, artifactPath);
    response.writeHead(200, {
      'content-type': MIME[extname(artifactPath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': content.length,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(artifactPath.split('/').at(-1) ?? 'artifact')}`,
    });
    response.end(content);
  } catch {
    io.json(response, 404, {
      error: { code: 'E_ARTIFACT_NOT_FOUND', message: artifactPath },
    });
  }
}

export async function taskFile(
  runtime: SpecAgentRuntime,
  repo: string,
  response: ServerResponse,
  taskId: string,
  url: URL,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }

  const branch = taskBranch(task);
  const taskRepo = task.repoPath ?? repo;
  const rawPath = url.searchParams.get('path');
  if (!rawPath) {
    io.json(response, 400, { error: { code: 'E_PATH_REQUIRED', message: 'path 必填' } });
    return;
  }

  const path = normalize(rawPath).replace(/\\/g, '/');
  if (
    !path ||
    path.startsWith('/') ||
    path.startsWith('../') ||
    path.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    io.json(response, 400, { error: { code: 'E_PATH_INVALID', message: rawPath } });
    return;
  }

  const requestedRef = url.searchParams.get('ref') || branch;
  if (requestedRef !== branch) {
    if (!/^[0-9a-f]{7,40}$/.test(requestedRef)) {
      io.json(response, 400, { error: { code: 'E_REF_INVALID', message: requestedRef } });
      return;
    }
    const commits = await GIT.log(taskRepo, branch, 200).catch(() => []);
    if (!commits.some((commit) => commit.hash.startsWith(requestedRef))) {
      io.json(response, 404, {
        error: { code: 'E_COMMIT_NOT_FOUND', message: requestedRef },
      });
      return;
    }
  }

  try {
    const content = await GIT.fileAt(taskRepo, requestedRef, path);
    const blame = await GIT.blameAll({
      dir: taskRepo,
      path,
      ref: requestedRef,
    });
    const commits = await GIT.log(taskRepo, branch, 200).catch(() => []);
    const byHash = new Map(commits.map((commit) => [commit.hash, commit]));

    io.json(response, 200, {
      path,
      ref: requestedRef,
      content,
      lines: blame.map((line) => ({
        ...line,
        trailers: byHash.get(line.commit)?.trailers ?? {},
      })),
    });
  } catch (error) {
    if (error instanceof AppError) {
      io.json(response, 404, { error: { code: 'E_FILE_NOT_FOUND', message: error.message } });
      return;
    }
    throw error;
  }
}

export async function taskTimeline(
  runtime: SpecAgentRuntime,
  repo: string,
  response: ServerResponse,
  taskId: string,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }

  // 从任意子任务回溯到根，保证选子任务也能看到整棵树
  let root = task;
  const ancestors = new Set<string>();
  while (root.parentId && !ancestors.has(root.id)) {
    ancestors.add(root.id);
    const parent = runtime.store.getTask(root.parentId);
    if (!parent) break;
    root = parent;
  }

  const tasks: TaskRow[] = [];
  const seen = new Set<string>();
  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const current = runtime.store.getTask(id);
    if (!current) continue;
    tasks.push(current);
    for (const child of runtime.store.listChildTasks(id)) queue.push(child.id);
  }
  tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const nodes: Array<{
    id: string;
    taskId: string;
    runId: string;
    nodeId: string;
    status: string;
    attempt: number;
    costUsd: number;
    createdAt: string;
    finishedAt: string | null;
    commits: Array<{
      hash: string;
      subject: string;
      author: string;
      date: string;
    }>;
  }> = [];

  for (const current of tasks) {
    let commits: Awaited<ReturnType<typeof GIT.log>> = [];
    try {
      commits = await GIT.log(
        repo,
        `agent/${current.assignee}/${current.id}`,
        200,
      );
    } catch {
      // 任务还没有分支
    }

    for (const run of runtime.store.listRuns(current.id)) {
      for (const node of runtime.store.listNodeRuns(run.id)) {
        nodes.push({
          id: node.id,
          taskId: current.id,
          runId: node.runId,
          nodeId: node.nodeId,
          status: node.status,
          attempt: node.attempt,
          costUsd: node.costUsd,
          createdAt: node.createdAt,
          finishedAt: node.finishedAt,
          commits: commits
            .filter(
              (commit) =>
                commitTrailer(commit.trailers, 'Spec-Agent-Task') === current.id &&
                commitTrailer(commit.trailers, 'Spec-Agent-Node') === node.nodeId,
            )
            .map((commit) => ({
              hash: commit.hash,
              subject: commit.subject,
              author: commit.author,
              date: commit.date,
            })),
        });
      }
    }
  }
  nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  io.json(response, 200, {
    rootId: root.id,
    tasks: tasks.map(toTask),
    nodes,
  });
}

export function toGate(gate: GateRow) {
  const payload = (gate.payload ?? {}) as Record<string, unknown>;
  return {
    id: gate.id,
    kind: gate.kind,
    ask: gate.ask,
    status: gate.status,
    taskId: gate.taskId,
    nodeRunId: gate.nodeRunId,
    title: String(payload.title ?? ''),
    summary: String(payload.summary ?? ''),
    payload,
    requestedAt: gate.requestedAt,
    decidedAt: gate.decidedAt,
  };
}

