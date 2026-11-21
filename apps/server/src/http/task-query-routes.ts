import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GateId, TaskId } from '@spec-agent/schema';
import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import type { SpecAgentRuntime } from '@spec-agent/runtime';
import { createTask, updatePlan } from './task-plans.js';
import { blameFile, buildSessionTimeline, listCommits, showCommit, taskArtifact, taskFile, taskTimeline, toGate, toTask } from './task-files.js';
import { AppError } from '@spec-agent/kernel';
import { errorStatus } from './errors.js';
import { cancelTask } from './chat-routes.js';

type TaskQueryIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  readRawBody: (request: IncomingMessage) => Promise<string>;
};

type TaskQueryContext = {
  runtime: SpecAgentRuntime;
  repo: string;
  planner: { agentRuntime?: AgentRuntime; provider: ProviderConfig; model: string };
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  url: URL;
  io: TaskQueryIo;
};

export async function handleTaskRoutes(ctx: TaskQueryContext): Promise<boolean> {
  const { runtime, repo, planner, request, response, path, url, io } = ctx;
  const taskCostCache = new Map<string, number>();
  const taskCost = (taskId: string): number => {
    const cached = taskCostCache.get(taskId);
    if (cached !== undefined) return cached;
    const task = runtime.store.getTask(taskId);
    if (!task) return 0;
    let total = task.costUsd;
    for (const child of runtime.store.listChildTasks(taskId)) total += taskCost(child.id);
    taskCostCache.set(taskId, total);
    return total;
  };

  if (request.method === 'POST' && path === '/api/tasks') {
    await createTask(runtime, planner, request, response, io);
    return true;
  }

  if (request.method === 'GET' && path === '/api/tasks') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    io.json(response, 200, {
      tasks: runtime.store
        .listTasks(limit)
        .map((task) => toTask(task, taskCost(task.id))),
      gates: runtime.store.listPendingGates().map(toGate),
    });
    return true;
  }

  const commitShowMatch = /^\/api\/tasks\/([^/]+)\/commits\/([0-9a-f]{7,40})$/.exec(path);
  if (request.method === 'GET' && commitShowMatch) {
    await showCommit(
      runtime,
      repo,
      response,
      decodeURIComponent(commitShowMatch[1]!),
      commitShowMatch[2]!, io
    );
    return true;
  }

  const commitsMatch = /^\/api\/tasks\/([^/]+)\/commits$/.exec(path);
  if (request.method === 'GET' && commitsMatch) {
    await listCommits(
      runtime,
      repo,
      response,
      decodeURIComponent(commitsMatch[1]!), io
    );
    return true;
  }

  const blameMatch = /^\/api\/tasks\/([^/]+)\/blame$/.exec(path);
  if (request.method === 'GET' && blameMatch) {
    await blameFile(
      runtime,
      repo,
      response,
      decodeURIComponent(blameMatch[1]!),
      url, io
    );
    return true;
  }

  const artifactMatch = /^\/api\/tasks\/([^/]+)\/artifact$/.exec(path);
  if (request.method === 'GET' && artifactMatch) {
    await taskArtifact(
      runtime,
      repo,
      response,
      decodeURIComponent(artifactMatch[1]!),
      url, io
    );
    return true;
  }

  const fileMatch = /^\/api\/tasks\/([^/]+)\/file$/.exec(path);
  if (request.method === 'GET' && fileMatch) {
    await taskFile(
      runtime,
      repo,
      response,
      decodeURIComponent(fileMatch[1]!),
      url, io
    );
    return true;
  }

  const timelineMatch = /^\/api\/tasks\/([^/]+)\/timeline$/.exec(path);
  if (request.method === 'GET' && timelineMatch) {
    await taskTimeline(
      runtime,
      repo,
      response,
      decodeURIComponent(timelineMatch[1]!), io
    );
    return true;
  }

  const retryNodeMatch = /^\/api\/tasks\/([^/]+)\/nodes\/([^/]+)\/retry$/.exec(path);
  if (request.method === 'POST' && retryNodeMatch) {
    const body = await io.readJson(request);
    try {
      await runtime.engine.retryNode(
        decodeURIComponent(retryNodeMatch[1]!),
        decodeURIComponent(retryNodeMatch[2]!),
        typeof body.reason === 'string' ? body.reason : 'manual node retry',
      );
      const task = runtime.store.getTask(
        decodeURIComponent(retryNodeMatch[1]!),
      );
      io.json(response, 200, { task: task ? toTask(task) : null });
    } catch (error) {
      if (error instanceof AppError) {
        io.json(response, errorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  const memoryRefreshMatch = /^\/api\/tasks\/([^/]+)\/memory\/refresh$/.exec(path);
  if (request.method === 'POST' && memoryRefreshMatch) {
    try {
      const result = await runtime.engine.requestMemoryRefresh(
        decodeURIComponent(memoryRefreshMatch[1]!),
      );
      io.json(response, 200, { ...result, requested: true });
    } catch (error) {
      if (error instanceof AppError) {
        io.json(response, errorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  const restoreCheckpointMatch =
    /^\/api\/tasks\/([^/]+)\/nodes\/([^/]+)\/checkpoint\/restore$/.exec(path);
  if (request.method === 'POST' && restoreCheckpointMatch) {
    const body = await io.readJson(request);
    const phase = body.phase === 'after' ? 'after' : 'before';
    try {
      const checkpoint = await runtime.engine.restoreNodeCheckpoint(
        decodeURIComponent(restoreCheckpointMatch[1]!),
        decodeURIComponent(restoreCheckpointMatch[2]!),
        phase,
      );
      io.json(response, 200, { checkpoint });
    } catch (error) {
      if (error instanceof AppError) {
        io.json(response, errorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  const cancelNodeMatch = /^\/api\/tasks\/([^/]+)\/nodes\/([^/]+)\/cancel$/.exec(path);
  if (request.method === 'POST' && cancelNodeMatch) {
    const body = await io.readJson(request);
    try {
      await runtime.engine.cancelNode(
        decodeURIComponent(cancelNodeMatch[1]!),
        decodeURIComponent(cancelNodeMatch[2]!),
        typeof body.reason === 'string' ? body.reason : 'manual node cancel',
      );
      const task = runtime.store.getTask(
        decodeURIComponent(cancelNodeMatch[1]!),
      );
      io.json(response, 200, { task: task ? toTask(task) : null });
    } catch (error) {
      if (error instanceof AppError) {
        io.json(response, errorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && taskMatch) {
    const task = runtime.store.getTask(decodeURIComponent(taskMatch[1]!));
    if (!task) {
      io.json(response, 404, { error: { code: 'E_TASK_NOT_FOUND', message: taskMatch[1] } });
      return true;
    }
    const runs = runtime.store.listRuns(task.id);
    const specId = runtime.store.getSpecIdForTask(task.id) ?? runs[0]?.specId;
    const spec = specId ? runtime.store.getSpec(specId) : undefined;
    const nodes = runs.flatMap((run) =>
      runtime.store.listNodeRuns(run.id).map((node) => ({
        id: node.id,
        runId: node.runId,
        nodeId: node.nodeId,
        status: node.status,
        attempt: node.attempt,
        costUsd: node.costUsd,
        outputs: node.outputs ?? [],
        transcriptRef: node.transcriptRef,
        sessionKey: node.sessionKey,
        sessionCumulativeUsd: node.sessionCumulativeUsd,
        checkpointBefore: node.checkpointBefore,
        checkpointAfter: node.checkpointAfter,
        createdAt: node.createdAt,
        finishedAt: node.finishedAt,
      })),
    );
    io.json(response, 200, {
      task: toTask(task, taskCost(task.id)),
      spec,
      runs: runs.map((run) => ({
        id: run.id,
        specId: run.specId,
        status: run.status,
        parentRunId: run.parentRunId,
        parentNodeRunId: run.parentNodeRunId,
        costUsd: run.costUsd,
      })),
      nodes,
      sessions: buildSessionTimeline(nodes),
      children: runtime.store
        .listChildTasks(task.id)
        .map((child) => toTask(child, taskCost(child.id))),
      merges: runtime.store.listMerges(task.id).map((merge) => ({
        id: merge.id,
        nodeRunId: merge.nodeRunId,
        childTaskId: merge.childTaskId,
        status: merge.status,
        attempts: merge.attempts,
        lastError: merge.lastError,
        updatedAt: merge.updatedAt,
      })),
      gates: runtime.store
        .listTasks(200)
        .flatMap((candidate) => runtime.store.listRuns(candidate.id))
        .flatMap((run) => runtime.store.listNodeRuns(run.id))
        .flatMap((node) => runtime.store.listGatesByNodeRun(node.id))
        .filter((gate) => gate.taskId === task.id)
        .map(toGate),
      events: runtime.store.events.read({ taskId: task.id }).slice(-200).map((event) => ({
        seq: event.seq,
        type: event.type,
        ts: event.ts,
        actor: event.actor,
        taskId: event.taskId ?? null,
        runId: event.runId ?? null,
        nodeRunId: event.nodeRunId ?? null,
        payload: event.payload,
      })),
    });
    return true;
  }

  if (request.method === 'GET' && path === '/api/gates') {
    io.json(response, 200, { gates: runtime.store.listPendingGates().map(toGate) });
    return true;
  }

  const planMatch = /^\/api\/tasks\/([^/]+)\/plan$/.exec(path);
  if (request.method === 'PATCH' && planMatch) {
    await updatePlan(
      runtime,
      request,
      response,
      decodeURIComponent(planMatch[1]!), io
    );
    return true;
  }

  const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(path);
  if (request.method === 'POST' && cancelMatch) {
    await cancelTask(
      runtime,
      request,
      response,
      decodeURIComponent(cancelMatch[1]!), io
    );
    return true;
  }

  const decideMatch = /^\/api\/gates\/([^/]+)\/decide$/.exec(path);
  if (request.method === 'POST' && decideMatch) {
    const gateId = decodeURIComponent(decideMatch[1]!);
    const gate = runtime.store.getGate(gateId);
    if (!gate) {
      io.json(response, 404, { error: { code: 'E_GATE_NOT_FOUND', message: gateId } });
      return true;
    }
    if (gate.status !== 'pending') {
      io.json(response, 409, { error: { code: 'E_GATE_CLOSED', message: gate.status } });
      return true;
    }

    const body = await io.readJson(request);
    const action = body.action;
    if (action !== 'approve' && action !== 'reject') {
      io.json(response, 400, { error: { code: 'E_GATE_ACTION', message: 'action 必须是 approve/reject' } });
      return true;
    }
    const comment = typeof body.comment === 'string' ? body.comment : undefined;
    if (action === 'reject' && !comment) {
      io.json(response, 400, { error: { code: 'E_GATE_REASON', message: 'reject 需要 comment' } });
      return true;
    }

    runtime.engine.dispatch({
      type: 'gate.decide',
      gateId: gateId as GateId,
      action,
      by: typeof body.by === 'string' ? body.by : 'web-user',
      comment,
    });
    await runtime.engine.runUntilIdle();

    const updated = runtime.store.getGate(gateId);
    io.json(response, 200, { gate: updated ? toGate(updated) : null });
    return true;
  }

  return false;
}
