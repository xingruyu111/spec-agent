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
import { errorStatus } from './errors.js';
import { cancelTask, streamChatReply, streamEvents } from './chat-routes.js';
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

function canAssign(
  agents: AgentConfig[],
  ownerId: string,
  targetId: string,
): boolean {
  if (ownerId === targetId) return true;
  let current = agents.find((agent) => agent.id === targetId);
  const seen = new Set<string>();
  while (current?.parent && !seen.has(current.id)) {
    if (current.parent === ownerId) return true;
    seen.add(current.id);
    current = agents.find((agent) => agent.id === current!.parent);
  }
  return false;
}

function addPlanEdge(
  spec: { edges: Array<{ from: string; to: string }> },
  from: string,
  to: string,
): void {
  if (from === to) return;
  if (spec.edges.some((edge) => edge.from === from && edge.to === to)) return;
  spec.edges.push({ from, to });
}

function assertPlanShape(spec: {
  nodes: Array<{ id: string; type: string; approval?: unknown }>;
  edges: Array<{ from: string; to: string }>;
}): string | null {
  const gate = spec.nodes.find((node) => node.id === PLAN_GATE_ID);
  if (!gate || gate.type !== 'shell' || !gate.approval) {
    return '计划必须保留确认工作流节点';
  }

  const roots = spec.nodes.filter(
    (node) => !spec.edges.some((edge) => edge.to === node.id),
  );
  if (roots.length !== 1 || roots[0]?.id !== PLAN_GATE_ID) {
    return '确认节点必须是唯一的根';
  }

  const outgoing = new Map<string, string[]>();
  for (const node of spec.nodes) outgoing.set(node.id, []);
  for (const edge of spec.edges) outgoing.get(edge.from)?.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const node of spec.nodes) {
    if (visit(node.id)) return '计划里有环';
  }

  const visitedNodes = new Set<string>();
  const queue = [PLAN_GATE_ID];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visitedNodes.has(id)) continue;
    visitedNodes.add(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }

  if (visitedNodes.size !== spec.nodes.length) {
    return '存在从确认节点不可达的节点';
  }
  if (spec.nodes.length < 2) return '计划至少需要一个执行节点';
  return null;
}

export async function updatePlan(
  runtime: SpecAgentRuntime,
  request: IncomingMessage,
  response: ServerResponse,
  taskId: string,
  io: TaskRouteIo,
): Promise<void> {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskId } });
    return;
  }
  if (task.status !== 'waiting_gate') {
    io.json(response, 409, {
      error: { code: 'E_PLAN_LOCKED', message: `任务状态是 ${task.status}，计划已锁定` },
    });
    return;
  }

  const runs = runtime.store.listRuns(task.id);
  const run = runs.find((candidate) => !candidate.parentRunId) ?? runs[0];
  if (!run) {
    io.json(response, 409, { error: { code: 'E_RUN_NOT_FOUND', message: '没有可编辑的 run' } });
    return;
  }

  const specId = runtime.store.getSpecIdForTask(task.id) ?? run.specId;
  const spec = specId ? runtime.store.getSpec(specId) : undefined;
  if (!spec) {
    io.json(response, 404, { error: { code: 'E_SPEC_NOT_FOUND', message: specId ?? '' } });
    return;
  }

  const body = await io.readJson(request);
  if (body.nodes !== undefined && !Array.isArray(body.nodes)) {
    io.json(response, 400, { error: { code: 'E_PLAN_PATCH', message: 'nodes 必须是数组' } });
    return;
  }

  const agents = runtime.agents ?? [];
  const byId = new Map(spec.nodes.map((node) => [node.id, node]));

  for (const entry of (body.nodes as unknown[] | undefined) ?? []) {
    const patch = entry as Record<string, unknown>;
    const id = String(patch.id ?? '');
    const node = byId.get(id as never);
    if (!node) {
      io.json(response, 400, { error: { code: 'E_PLAN_PATCH', message: `未知节点：${id}` } });
      return;
    }
    if (node.type !== 'llm') continue;

    if (typeof patch.agent === 'string') {
      const target = agents.find((agent) => agent.id === patch.agent);
      if (!target) {
        io.json(response, 400, {
          error: { code: 'E_AGENT_NOT_FOUND', message: `未知 agent：${patch.agent}` },
        });
        return;
      }
      if (!canAssign(agents, task.assignee, target.id)) {
        io.json(response, 400, {
          error: {
            code: 'E_AGENT_ASSIGNMENT_FORBIDDEN',
            message: `${task.assignee} 不能把节点分配给 ${target.id}`,
          },
        });
        return;
      }
      node.agent = target.id;
    }

    if (typeof patch.approval === 'boolean') {
      if (patch.approval) {
        node.approval = { approvers: ['human'] };
      } else {
        delete node.approval;
      }
    }

    if (typeof patch.instructions === 'string') {
      const instructions = patch.instructions.trim();
      if (instructions.length > 4000) {
        io.json(response, 400, {
          error: { code: 'E_PLAN_PATCH', message: 'instructions 最多 4000 字' },
        });
        return;
      }
      node.instructions = instructions;
    }
  }

  const removeIds = new Set(
    (Array.isArray(body.removeNodes) ? body.removeNodes : []).map((id) => String(id)),
  );
  if (removeIds.has(PLAN_GATE_ID)) {
    io.json(response, 400, {
      error: { code: 'E_PLAN_SHAPE', message: '不能删除确认工作流节点' },
    });
    return;
  }

  if (removeIds.size > 0) {
    const removable = spec.nodes.filter((node) => removeIds.has(node.id));
    if (removable.some((node) => node.type !== 'llm')) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: '只能删除 llm 节点' },
      });
      return;
    }

    for (const node of removable) {
      const preds = spec.edges
        .filter((edge) => edge.to === node.id && !removeIds.has(edge.from))
        .map((edge) => edge.from);
      const succs = spec.edges
        .filter((edge) => edge.from === node.id && !removeIds.has(edge.to))
        .map((edge) => edge.to);
      for (const from of preds) {
        for (const to of succs) {
          if (from !== to) addPlanEdge(spec, from, to);
        }
      }
    }

    spec.nodes = spec.nodes.filter((node) => !removeIds.has(node.id));
    spec.edges = spec.edges.filter(
      (edge) => !removeIds.has(edge.from) && !removeIds.has(edge.to),
    );
    for (const id of removeIds) byId.delete(id as never);
  }

  for (const entry of (Array.isArray(body.addNodes) ? body.addNodes : [])) {
    const patch = entry as Record<string, unknown>;
    const id = String(patch.id ?? '');
    if (!/^[a-z][a-z0-9-]*$/.test(id) || id === PLAN_GATE_ID || byId.has(id as never)) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: `节点 id 不合法或重复：${id}` },
      });
      return;
    }

    const description = String(patch.description ?? '').trim();
    if (!description) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: `节点 ${id} 缺少 description` },
      });
      return;
    }
    const instructions = String(patch.instructions ?? description).trim().slice(0, 4000);

    const afterId = String(patch.after ?? PLAN_GATE_ID);
    if (!byId.has(afterId as never)) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: `after 节点不存在：${afterId}` },
      });
      return;
    }

    let agentId: string | undefined;
    if (agents.length > 0) {
      agentId =
        typeof patch.agent === 'string' && patch.agent.trim()
          ? patch.agent.trim()
          : task.assignee;
      if (!agents.some((agent) => agent.id === agentId)) {
        io.json(response, 400, {
          error: { code: 'E_AGENT_NOT_FOUND', message: `未知 agent：${agentId}` },
        });
        return;
      }
      if (!canAssign(agents, task.assignee, agentId)) {
        io.json(response, 400, {
          error: {
            code: 'E_AGENT_ASSIGNMENT_FORBIDDEN',
            message: `${task.assignee} 不能把节点分配给 ${agentId}`,
          },
        });
        return;
      }
    }

    const node: LlmNode = {
      id: id as NodeId,
      type: 'llm',
      ...(agentId ? { agent: agentId as AgentId } : {}),
      description,
      instructions,
      inputs: [],
      outputs: [],
      tools: agentId ? [] : ['Read', 'Write', 'Edit'],
      ...(agentId ? {} : { writeScope: ['.'] }),
      autoCommit: true,
    };

    spec.nodes.push(node);
    byId.set(id as never, node);
    addPlanEdge(spec, afterId, id);
  }

  if (
    body.addEdges !== undefined &&
    !Array.isArray(body.addEdges)
  ) {
    io.json(response, 400, { error: { code: 'E_PLAN_PATCH', message: 'addEdges 必须是数组' } });
    return;
  }
  if (
    body.removeEdges !== undefined &&
    !Array.isArray(body.removeEdges)
  ) {
    io.json(response, 400, {
      error: { code: 'E_PLAN_PATCH', message: 'removeEdges 必须是数组' },
    });
    return;
  }

  for (const entry of (Array.isArray(body.removeEdges) ? body.removeEdges : [])) {
    const edge = entry as Record<string, unknown>;
    const from = String(edge.from ?? '');
    const to = String(edge.to ?? '');
    const index = spec.edges.findIndex(
      (candidate) => candidate.from === from && candidate.to === to,
    );
    if (index < 0) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: `依赖不存在：${from} → ${to}` },
      });
      return;
    }
    spec.edges.splice(index, 1);
  }

  for (const entry of (Array.isArray(body.addEdges) ? body.addEdges : [])) {
    const edge = entry as Record<string, unknown>;
    const from = String(edge.from ?? '');
    const to = String(edge.to ?? '');
    if (!byId.has(from as never) || !byId.has(to as never)) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: `依赖节点不存在：${from} → ${to}` },
      });
      return;
    }
    if (from === to) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: '节点不能依赖自己' },
      });
      return;
    }
    if (spec.edges.some((candidate) => candidate.from === from && candidate.to === to)) {
      io.json(response, 400, {
        error: { code: 'E_PLAN_PATCH', message: `依赖已存在：${from} → ${to}` },
      });
      return;
    }
    spec.edges.push({ from: from as NodeId, to: to as NodeId });
  }

  const shapeError = assertPlanShape(spec);
  if (shapeError) {
    io.json(response, 400, { error: { code: 'E_PLAN_SHAPE', message: shapeError } });
    return;
  }

  const parsed = zWorkflowSpec.safeParse(spec);
  if (!parsed.success) {
    io.json(response, 400, {
      error: {
        code: 'E_PLAN_SHAPE',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      },
    });
    return;
  }

  const nextSpec = parsed.data;
  const nextSpecId = specHash(nextSpec);
  runtime.store.saveSpec(nextSpecId, nextSpec);
  runtime.store.bindSpec(task.id, nextSpecId);
  runtime.engine.dispatch({
    type: 'run.replan',
    runId: run.id as never,
    specId: nextSpecId,
    reason: 'plan edited',
  });

  const updated = runtime.store.getTask(task.id);
  io.json(response, 200, {
    task: updated ? toTask(updated) : null,
    spec: nextSpec,
  });
}

type CreatedTask = {
  task: TaskRow;
  spec: WorkflowSpec;
  gates: GateRow[];
};

type PlannerConfig = {
  agentRuntime?: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  limits?: PlannerLimits;
};

export async function planTaskForGoal(
  runtime: SpecAgentRuntime,
  planner: PlannerConfig,
  goal: string,
  assignee?: string,
  repoPath?: string,
): Promise<PlannedTask> {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) {
    throw new AppError('E_GOAL_REQUIRED', 'goal 不能为空');
  }
  if (trimmedGoal.length > 2000) {
    throw new AppError('E_GOAL_TOO_LONG', 'goal 最多 2000 字');
  }
  const agents = runtime.agents ?? [];
  if (agents.length === 0) {
    throw new AppError(
      'E_ORG_REQUIRED',
      '请先在组织配置中添加至少一个 agent，再创建任务',
    );
  }
  const defaultAgent = agents.find((agent) => agent.parent === null)?.id;
  const requestedAssignee = assignee?.trim() || defaultAgent || agents[0]!.id;
  if (!agents.some((agent) => agent.id === requestedAssignee)) {
    throw new AppError(
      'E_AGENT_NOT_FOUND',
      `任务的 assignee 不在组织配置里：${requestedAssignee}`,
    );
  }
  if (!planner.agentRuntime) {
    throw new AppError('E_PLANNER_UNAVAILABLE', '没有配置 AgentRuntime，无法生成工作流');
  }
  const taskRepoPath = repoPath ? resolve(repoPath) : undefined;
  if (repoPath && !isAbsolute(repoPath)) {
    throw new AppError('E_REPOSITORY_INVALID', `仓库路径必须是绝对路径：${repoPath}`);
  }
  if (taskRepoPath && !existsSync(join(taskRepoPath, '.git'))) {
    throw new AppError('E_REPOSITORY_INVALID', `仓库必须是已有 Git 目录：${taskRepoPath}`);
  }

  const planned = await planWorkflowWithUsage({
    goal: trimmedGoal,
    agentRuntime: planner.agentRuntime,
    provider: planner.provider,
    model: planner.model,
    agents,
    defaultAgent: requestedAssignee,
    limits: planner.limits,
  });
  return {
    goal: trimmedGoal,
    title: trimmedGoal.slice(0, 80),
    assignee: requestedAssignee,
    spec: planned.spec,
    planUsage: planned.usage,
    ...(taskRepoPath ? { repoPath: taskRepoPath } : {}),
  };
}

export async function executePlannedTask(
  runtime: SpecAgentRuntime,
  plan: PlannedTask,
): Promise<CreatedTask> {
  const specId = specHash(plan.spec);
  runtime.store.saveSpec(specId, plan.spec);
  const taskId = runtime.ids.task();
  runtime.store.bindSpec(taskId, specId);
  runtime.engine.dispatch({
    type: 'task.create',
    taskId,
    assignee: plan.assignee as AgentId,
    caller: null,
    title: plan.title,
    brief: plan.goal,
    ...(plan.repoPath ? { repoPath: plan.repoPath } : {}),
    planUsage: plan.planUsage as never,
  });
  await runtime.engine.runUntilIdle();
  const task = runtime.store.getTask(taskId);
  if (!task) throw new AppError('E_TASK_NOT_FOUND', `任务创建后不存在：${taskId}`);
  return {
    task,
    spec: plan.spec,
    gates: runtime.store
      .listPendingGates()
      .filter((gate) => gate.taskId === taskId),
  };
}

export async function createTaskForGoal(
  runtime: SpecAgentRuntime,
  planner: PlannerConfig,
  goal: string,
  assignee?: string,
  repoPath?: string,
): Promise<CreatedTask> {
  const plan = await planTaskForGoal(runtime, planner, goal, assignee, repoPath);
  return executePlannedTask(runtime, plan);
}

export async function createTask(
  runtime: SpecAgentRuntime,
  planner: { agentRuntime?: AgentRuntime; provider: ProviderConfig; model: string },
  request: IncomingMessage,
  response: ServerResponse,
  io: TaskRouteIo,
): Promise<void> {  const body = await io.readJson(request);
  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  const assignee =
    typeof body.assignee === 'string' && body.assignee.trim()
      ? body.assignee.trim()
      : undefined;
  const repoPath = typeof body.repoPath === 'string' && body.repoPath.trim()
    ? body.repoPath.trim()
    : undefined;
  try {
    const result = await createTaskForGoal(runtime, planner, goal, assignee, repoPath);
    io.json(response, 201, {
      task: toTask(result.task),
      spec: result.spec,
      gates: result.gates.map(toGate),
    });
  } catch (error) {
    if (error instanceof AppError) {
      const status =
        error.code === 'E_PLANNER_UNAVAILABLE'
          ? 503
          : error.code.startsWith('E_PLAN')
            ? 422
            : 400;
      io.json(response, status, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }
}


function planJson(detail: ProjectPlanDetail): Record<string, unknown> {
  return {
    plan: detail.plan,
    items: detail.items.map((item) => ({
      ...item,
      task: item.task ? toTask(item.task) : null,
    })),
  };
}

export async function handleProjectPlanRequest(
  plans: ProjectPlanService,
  chat: ChatService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  io: TaskRouteIo,
): Promise<void> {
  try {
    if (request.method === 'GET' && path === '/api/project-plans') {
      const projectId = url.searchParams.get('projectId');
      io.json(response, 200, { plans: plans.list(30, projectId) });
      return;
    }
    if (request.method === 'POST' && path === '/api/project-plans') {
      const body = await io.readJson(request);
      const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
      const verifyCommand =
        typeof body.verifyCommand === 'string' ? body.verifyCommand : null;
      const projectId =
        typeof body.projectId === 'string' ? body.projectId : null;
      const project = projectId ? chat.getProject(projectId) : undefined;
      if (projectId && !project) {
        io.json(response, 400, {
          error: { code: 'E_CHAT_PROJECT', message: '项目不存在' },
        });
        return;
      }
      const detail = await plans.create({
        goal,
        verifyCommand,
        projectId,
        repoPath: project?.repoPath ?? null,
      });
      io.json(response, 201, planJson(detail));
      return;
    }

    const match = /^\/api\/project-plans\/([^/]+)(?:\/(start|cancel|verify))?$/.exec(
      path,
    );
    if (!match) return;
    const planId = decodeURIComponent(match[1]!);
    const action = match[2];
    if (request.method === 'GET' && !action) {
      const projectId = url.searchParams.get('projectId');
      io.json(response, 200, planJson(plans.get(planId, projectId)));
      return;
    }
    if (request.method === 'POST' && action === 'start') {
      io.json(response, 200, planJson(await plans.start(planId)));
      return;
    }
    if (request.method === 'POST' && action === 'cancel') {
      const body = await io.readJson(request).catch(
        () => ({}) as Record<string, unknown>,
      );
      io.json(
        response,
        200,
        planJson(
          await plans.cancel(
            planId,
            typeof body.reason === 'string' ? body.reason : 'user cancelled plan',
          ),
        ),
      );
      return;
    }
    if (request.method === 'POST' && action === 'verify') {
      const body = await io.readJson(request);
      const command =
        typeof body.command === 'string' && body.command.trim()
          ? body.command
          : null;
      io.json(response, 200, planJson(plans.setVerifyCommand(planId, command)));
      return;
    }
  } catch (error) {
    if (error instanceof AppError) {
      io.json(response, error.code === 'E_PLANNER_UNAVAILABLE' ? 503 : 400, {
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }
}


