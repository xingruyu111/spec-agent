/**
 * 引擎 v1：单进程、顺序执行、真 SQLite。
 *
 * 已支持：task 领取、run 启动、线性 DAG、llm / shell 节点、自动闸门、人审暂停与恢复、
 * 重试、崩溃恢复。delegate / subworkflow 留到 v2（需要任务来源字段与嵌套 run）。
 */

import type {
  AgentConfig,
  AgentId,
  ArtifactRef,
  Command,
  ConditionNode,
  DelegateNode,
  EventActor,
  FanoutNode,
  GateId,
  LlmNode,
  LoopNode,
  NodeId,
  NodeRunId,
  NodeSpec,
  RunId,
  ShellNode,
  SubworkflowNode,
  TaskId,
  Usage,
  VerifyNode,
  WorkflowSpec,
} from '@spec-agent/schema';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import type { Clock, IdFactory } from '@spec-agent/kernel';
import { AppError, toErrorInfo } from '@spec-agent/kernel';
import { EVENT_SCHEMA_VERSION } from '@spec-agent/schema';
import type { ConflictResolver, GitService } from '../ports/git.js';
import type {
  AgentRuntime,
  AgentToolEvent,
  ProviderConfig,
  SkillRef,
} from '../ports/agent-runtime.js';
import type { ShellRunner } from '../ports/shell.js';
import type { MemoryNodeOutcome } from '../ports/memory.js';
import { specHash } from '../spec/hash.js';
import { verifyArtifactContracts } from '../artifacts.js';
import { routeModel } from '../model-router.js';
import type { NodeRunRow, RunRow, Store, TaskRow } from '../store/store.js';
import type { NewEvent } from '../store/event-store.js';
import { CommandBus } from './bus.js';

export type Planner = {
  plan(task: TaskRow): Promise<{ spec: WorkflowSpec }>;
};

export type EngineOptions = {
  store: Store;
  planner: Planner;
  runtime: AgentRuntime;
  shell: ShellRunner;
  clock: Clock;
  ids: IdFactory;
  provider: ProviderConfig;
  /** 可用于能力路由的 provider 注册表 */
  providers?: ProviderConfig[];
  /** spec 节点写 'inherit' 时用这个 */
  model: string;
  /** shell 节点和 agent 的工作目录 */
  workspaceRoot: string;
  actor?: EventActor;
  maxTicks?: number;
  /** 单节点最大轮数，传给 AgentRuntime */
  maxTurns?: number;
  /** 提供 git 时，每个任务一个 worktree，并在节点成功后自动提交 */
  git?: GitService;
  repoPath?: string;
  worktreeRoot?: string;
  /** 提供时，合并冲突会先尝试自动解决；失败才让节点失败 */
  conflictResolver?: ConflictResolver;
  /** 单任务成本上限（USD）；超过后不再启动新节点 */
  maxUsdPerTask?: number;
  /** 单节点成本上限（USD），传给 AgentRuntime；默认 5 */
  maxUsdPerNode?: number;
  /** 组织配置；提供时启用委派约束和 agent 默认值 */
  agents?: AgentConfig[];
  /** 任务终态后删除 worktree（分支保留）；默认 false */
  cleanupWorktrees?: boolean;
  /** 同一个父任务同时最多跑几个子任务；默认 4 */
  maxConcurrentChildren?: number;
  /** 项目内同时执行的 root task 数；子任务不受 root 配额卡死 */
  maxConcurrentTasks?: number;
  /** 项目累计成本上限 */
  maxUsdPerProject?: number;
  /** 当日 root task 成本上限 */
  maxUsdPerDay?: number;
  /** 根任务的 llm 节点也各开子任务/worktree；默认 false */
  isolateNodes?: boolean;
  /** node：每个节点独立 agent；session：连续线性 LLM 节点复用同一 SDK 会话 */
  executionMode?: 'node' | 'session';
  /** 配置后自动在根工作流末尾追加一个独立 QA agent 节点 */
  qaAgent?: string;
  /** 冲突时最多合并几次；默认 2 */
  mergeAttempts?: number;
  /** 两次合并之间的等待，默认 250ms */
  mergeRetryDelayMs?: number;
  /** 返回与当前任务/agent 相关的长期记忆；只注入摘要，不注入原始 transcript */
  memoryContext?: (agentId: string, task: string) => string[] | Promise<string[]>;
  /** 节点成功后的结构化结果，供记忆 outbox 使用；不阻塞节点执行 */
  onNodeOutcome?: (outcome: MemoryNodeOutcome) => void;
  /** 项目 skills 解析 */
  resolveSkills?: (ids: string[]) => SkillRef[];
  /** 项目知识索引：按任务返回相关文件片段 */
  knowledgeContext?: (task: string) => string[];
  /** 项目显式 MCP 配置 */
  mcpServers?: Record<string, unknown>;
};

type ExecutionResult = {
  outputs: ArtifactRef[];
  usage?: Usage;
  transcriptRef?: string;
  text?: string;
  sessionKey?: string;
  sessionCumulativeUsd?: number;
};

type SessionLink = {
  transcriptRef: string;
  sessionKey: string;
  /** Claude SDK resumed session 的 total_cost_usd 是累计值 */
  cumulativeUsd?: number;
  /** 分支节点从共同前驱 fork，而不是继续同一 session */
  fork?: boolean;
  /** 当前 session 已经注入过哪些记忆，刷新时只补新增项 */
  memoryKeys?: string[];
};

const TERMINAL_NODE = ['succeeded', 'failed', 'cancelled', 'skipped'] as const;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class Engine {
  private readonly bus: CommandBus;
  private readonly actor: EventActor;
  private agents?: Map<string, AgentConfig>;
  private readonly worktrees = new Map<string, string>();
  private readonly sessionLinks = new Map<string, SessionLink>();
  private readonly controllers = new Map<string, AbortController>();
  private stopping = false;
  private gitLock: Promise<void> = Promise.resolve();

  constructor(private readonly options: EngineOptions) {
    this.actor = options.actor ?? { type: 'runtime', id: 'engine' };
    this.bus = new CommandBus(options.store, options.ids, options.clock, this.actor);
    this.agents = options.agents
      ? new Map(options.agents.map((agent) => [agent.id, agent]))
      : undefined;
  }

  /** 对外暴露命令入口，UI / CLI 审批都走这里。 */
  dispatch(command: Command): void {
    if (
      command.type === 'task.create' &&
      this.agents &&
      !this.agents.has(command.assignee)
    ) {
      throw new AppError(
        'E_AGENT_NOT_FOUND',
        `任务的 assignee 不在组织配置里：${command.assignee}`,
      );
    }
    this.bus.dispatch(command);
  }

  /** 组织配置热加载；之后创建的节点/子任务使用新配置。 */
  setAgents(agents?: AgentConfig[]): void {
    this.agents = agents
      ? new Map(agents.map((agent) => [agent.id, agent]))
      : undefined;
  }

  /** 供应商/默认模型热更新；之后启动的节点使用新值。 */
  setProvider(provider: ProviderConfig): void {
    this.options.provider = provider;
  }

  setModel(model: string): void {
    this.options.model = model;
  }

  /**
   * 取消任务及其所有子任务：先关闸门，再取消节点和 run，最后取消任务。
   * 只改任务状态不清理子实体，会留下永远 running 的孤儿节点。
   */
  cancelTask(taskId: TaskId, reason: string): void {
    const root = this.options.store.getTask(taskId);
    if (!root) throw new AppError('E_TASK_NOT_FOUND', `任务不存在：${taskId}`);

    const terminal = ['succeeded', 'failed', 'cancelled'];
    if (terminal.includes(root.status)) {
      throw new AppError('E_TASK_TERMINAL', `任务已结束：${root.status}`);
    }

    const tasks: TaskRow[] = [];
    const queue: TaskRow[] = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const task = queue.shift()!;
      if (seen.has(task.id) || terminal.includes(task.status)) continue;
      seen.add(task.id);
      tasks.push(task);
      queue.push(...this.options.store.listChildTasks(task.id));
    }

    for (const task of tasks) {
      const gates = this.options.store
        .listPendingGates()
        .filter((gate) => gate.taskId === task.id);
      for (const gate of gates) {
        this.bus.dispatch({
          type: 'gate.cancel',
          gateId: gate.id as GateId,
          reason,
        });
      }

      const runs = this.options.store
        .listRuns(task.id)
        .filter((run) => run.status === 'running' || run.status === 'waiting');
      for (const run of runs) {
        for (const node of this.options.store.listNodeRuns(run.id)) {
          if (['succeeded', 'failed', 'cancelled', 'skipped'].includes(node.status)) {
            continue;
          }
          // 真中断在跑的 SDK / shell；只改状态会让模型继续烧钱
          this.controllers.get(node.id)?.abort();
          this.bus.dispatch({
            type: 'node.cancel',
            taskId: task.id as TaskId,
            runId: run.id as RunId,
            nodeRunId: node.id as NodeRunId,
            nodeId: node.nodeId as NodeId,
            reason,
          });
        }
        this.bus.dispatch({
          type: 'run.cancel',
          runId: run.id as RunId,
          reason,
        });
      }

      this.bus.dispatch({
        type: 'task.cancel',
        taskId: task.id as TaskId,
        reason,
      });

      void this.cleanupTaskWorktree(task.id);
    }
  }

  /** 优雅停机：停止调度并 abort 正在跑的外部调用；状态留给下次 recover。 */
  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  /** 取消单个节点及其下游；任务最终会以 failed 收口。 */
  async cancelNode(
    taskId: string,
    nodeRunId: string,
    reason = 'manual node cancel',
  ): Promise<void> {
    const task = this.options.store.getTask(taskId);
    if (!task) throw new AppError('E_TASK_NOT_FOUND', `任务不存在：${taskId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) {
      throw new AppError('E_TASK_TERMINAL', `任务已结束：${task.status}`);
    }

    const node = this.options.store.getNodeRun(nodeRunId);
    if (!node) throw new AppError('E_NODE_NOT_FOUND', `节点不存在：${nodeRunId}`);
    if (['succeeded', 'failed', 'cancelled', 'skipped'].includes(node.status)) {
      throw new AppError('E_NODE_TERMINAL', `节点已结束：${node.status}`);
    }

    const run = this.options.store.getRun(node.runId);
    if (!run) throw new AppError('E_RUN_NOT_FOUND', `run 不存在：${node.runId}`);
    const spec = this.options.store.getSpec(run.specId);
    const affected = new Set<string>([node.nodeId]);
    if (spec) {
      for (const id of this.descendantNodeIds(spec, node.nodeId)) affected.add(id);
    }

    const rows = this.options.store
      .listNodeRuns(run.id)
      .filter((candidate) => affected.has(candidate.nodeId));
    for (const row of rows) {
      if (['succeeded', 'failed', 'cancelled', 'skipped'].includes(row.status)) {
        continue;
      }
      this.controllers.get(row.id)?.abort();
      this.cancelNodeGates(row.id, reason);
      for (const child of this.options.store.listChildTasks(task.id)) {
        if (
          child.originNodeRunId === row.id &&
          !['succeeded', 'failed', 'cancelled'].includes(child.status)
        ) {
          this.cancelTask(child.id as TaskId, reason);
        }
      }
      this.bus.dispatch({
        type: 'node.cancel',
        taskId: task.id as TaskId,
        runId: run.id as RunId,
        nodeRunId: row.id as NodeRunId,
        nodeId: row.nodeId as NodeId,
        reason,
      });
    }

    for (const childRun of this.options.store
      .listRuns(task.id)
      .filter(
        (candidate) =>
          candidate.parentNodeRunId &&
          rows.some((row) => row.id === candidate.parentNodeRunId),
      )) {
      this.cancelRunTree(task, childRun, reason);
    }

    await this.runUntilIdle();
  }

  /**
   * 把节点 worktree 恢复到 checkpoint ref。
   * 只恢复文件状态；节点状态和重试由调用方显式处理。
   */
  async restoreNodeCheckpoint(
    taskId: string,
    nodeRunId: string,
    phase: 'before' | 'after' = 'before',
  ): Promise<{ ref: string; worktree: string }> {
    const task = this.options.store.getTask(taskId);
    if (!task) throw new AppError('E_TASK_NOT_FOUND', `任务不存在：${taskId}`);
    const node = this.options.store.getNodeRun(nodeRunId);
    if (!node) throw new AppError('E_NODE_NOT_FOUND', `节点不存在：${nodeRunId}`);
    const run = this.options.store.getRun(node.runId);
    if (!run || run.taskId !== taskId) {
      throw new AppError('E_CHECKPOINT_NOT_FOUND', '节点不属于当前任务');
    }
    const ref = phase === 'before' ? node.checkpointBefore : node.checkpointAfter;
    if (!ref) {
      throw new AppError('E_CHECKPOINT_NOT_FOUND', `节点没有 ${phase} checkpoint`);
    }
    const git = this.options.git;
    const worktree =
      this.worktrees.get(taskId) ??
      (this.options.worktreeRoot ? join(this.options.worktreeRoot, taskId) : undefined);
    if (!git || !worktree || !existsSync(worktree)) {
      throw new AppError('E_CHECKPOINT_NO_WORKTREE', 'checkpoint 对应的 worktree 不存在');
    }
    try {
      await git.resetHard(worktree, ref);
      await git.clean?.(worktree);
    } catch (error) {
      throw new AppError(
        'E_CHECKPOINT_RESTORE',
        `checkpoint 恢复失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (phase === 'before') {
      // 回滚到节点前时，旧 session 可能包含失败尝试；强制后续 retry 建新会话。
      this.options.store.clearNodeSession(node.id);
      for (const key of this.sessionLinks.keys()) {
        if (key.startsWith(`${run.id}:`)) this.sessionLinks.delete(key);
      }
    }
    return { ref, worktree };
  }

  /**
   * 请求下一次 session 节点执行时增量刷新记忆。
   * 下一次节点只注入尚未进入该 session 的新记忆，不重复旧记忆。
   */
  async requestMemoryRefresh(taskId: string): Promise<{ runId: string }> {
    if (this.options.executionMode !== 'session') {
      throw new AppError(
        'E_MEMORY_REFRESH_UNSUPPORTED',
        '只有 session 模式支持记忆刷新',
      );
    }
    const task = this.options.store.getTask(taskId);
    if (!task) throw new AppError('E_TASK_NOT_FOUND', `任务不存在：${taskId}`);
    const run = this.options.store
      .listRuns(task.id)
      .filter((candidate) => ['running', 'waiting'].includes(candidate.status))
      .at(-1);
    if (!run) {
      throw new AppError('E_TASK_NOT_RUNNING', '任务没有运行中的 session');
    }
    this.options.store.requestMemoryRefresh(run.id);
    return { runId: run.id };
  }

  /** 重试失败任务里的失败节点；下游失败/跳过节点一并重置。 */
  async retryNode(
    taskId: string,
    nodeRunId: string,
    reason = 'manual node retry',
  ): Promise<void> {
    const task = this.options.store.getTask(taskId);
    if (!task) throw new AppError('E_TASK_NOT_FOUND', `任务不存在：${taskId}`);
    if (task.status !== 'failed') {
      throw new AppError('E_TASK_NOT_FAILED', `任务不是 failed：${task.status}`);
    }

    const node = this.options.store.getNodeRun(nodeRunId);
    if (!node) throw new AppError('E_NODE_NOT_FOUND', `节点不存在：${nodeRunId}`);
    if (node.status !== 'failed') {
      throw new AppError('E_NODE_NOT_FAILED', `节点不是 failed：${node.status}`);
    }

    const run = this.options.store.getRun(node.runId);
    if (!run || run.status !== 'failed') {
      throw new AppError('E_RUN_NOT_FAILED', '只有失败的根 run 可以重试');
    }
    if (run.parentRunId) {
      throw new AppError('E_NODE_RETRY_SUBRUN', '暂不支持直接重试子流程内部节点');
    }

    const spec = this.options.store.getSpec(run.specId);
    if (!spec) throw new AppError('E_SPEC_MISSING', `找不到 spec：${run.specId}`);

    const affected = new Set<string>([
      node.nodeId,
      ...this.descendantNodeIds(spec, node.nodeId),
    ]);

    this.bus.dispatch({
      type: 'task.reopen',
      taskId: task.id as TaskId,
      reason,
    });
    this.bus.dispatch({
      type: 'run.reopen',
      runId: run.id as RunId,
      reason,
    });

    for (const row of this.options.store.listNodeRuns(run.id)) {
      if (!affected.has(row.nodeId)) continue;
      if (!['failed', 'skipped', 'cancelled'].includes(row.status)) continue;
      this.cancelNodeGates(row.id, reason);
      const merge = this.options.store.getMerge(row.id);
      if (merge?.status === 'failed') {
        this.options.store.markMergePending(row.id);
      }
      this.bus.dispatch({
        type: 'node.reset',
        taskId: task.id as TaskId,
        runId: run.id as RunId,
        nodeRunId: row.id as NodeRunId,
        nodeId: row.nodeId as NodeId,
        reason,
      });
    }

    await this.runUntilIdle();
  }

  private cancelNodeGates(nodeRunId: string, reason: string): void {
    for (const gate of this.options.store.listGatesByNodeRun(nodeRunId)) {
      if (gate.status === 'pending') {
        this.bus.dispatch({
          type: 'gate.cancel',
          gateId: gate.id as GateId,
          reason,
        });
      }
    }
  }

  private cancelRunTree(task: TaskRow, run: RunRow, reason: string): void {
    for (const node of this.options.store.listNodeRuns(run.id)) {
      if (['succeeded', 'failed', 'cancelled', 'skipped'].includes(node.status)) {
        continue;
      }
      this.controllers.get(node.id)?.abort();
      this.cancelNodeGates(node.id, reason);
      this.bus.dispatch({
        type: 'node.cancel',
        taskId: task.id as TaskId,
        runId: run.id as RunId,
        nodeRunId: node.id as NodeRunId,
        nodeId: node.nodeId as NodeId,
        reason,
      });
    }
    for (const child of this.options.store
      .listRuns(task.id)
      .filter((candidate) => candidate.parentRunId === run.id)) {
      this.cancelRunTree(task, child, reason);
    }
    this.bus.dispatch({
      type: 'run.cancel',
      runId: run.id as RunId,
      reason,
    });
  }

  private descendantNodeIds(spec: WorkflowSpec, start: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const edge of spec.edges) {
        if (edge.from !== id || seen.has(edge.to)) continue;
        seen.add(edge.to as string);
        result.push(edge.to as string);
        queue.push(edge.to as string);
      }
    }
    return result;
  }

  /**
   * 恢复上次进程留下的中间状态：
   * - running 的节点回到 ready 重跑；
   * - 已经有 pending 闸门的 verifying 节点重新挂到 waiting_gate。
   */
  recover(): number {
    let fixed = 0;
    for (const task of this.options.store.listTasks(500)) {
      for (const run of this.options.store.listRuns(task.id)) {
        const spec = this.options.store.getSpec(run.specId);
        for (const node of this.options.store.listNodeRuns(run.id)) {
          const specNode = spec?.nodes.find((n) => n.id === node.nodeId);
          // delegate / subworkflow 在等外部完成，不能当成中断重跑
          const waitsExternally =
            specNode?.type === 'delegate' ||
      specNode?.type === 'fanout' ||
      specNode?.type === 'subworkflow';
          const ctx = this.ctx(task.id, run.id, node);
          if (node.status === 'running' && !waitsExternally) {
            this.bus.dispatch({ type: 'node.interrupt', ...ctx, reason: 'shutdown' });
            fixed += 1;
          } else if (node.status === 'verifying') {
            let pendingGateId: string | undefined;
            for (const gate of this.options.store.listGatesByNodeRun(node.id)) {
              if (gate.status === 'pending') {
                pendingGateId = gate.id;
                break;
              }
            }
            if (pendingGateId) {
              this.bus.dispatch({
                type: 'node.wait_gate',
                ...ctx,
                gateId: pendingGateId as GateId,
              });
              fixed += 1;
            }
          }
        }
      }
    }
    return fixed;
  }

  /** 逐 tick 推进；shutdown 后不再启动新工作。 */
  async runUntilIdle(): Promise<void> {
    const maxTicks = this.options.maxTicks ?? 100;
    for (let i = 0; i < maxTicks; i += 1) {
      if (this.stopping) return;
      const didWork = await this.tick();
      if (this.stopping || !didWork) return;
    }
    throw new AppError('E_ENGINE_MAX_TICKS', `引擎在 ${maxTicks} 次 tick 内没有停下来`);
  }

  async tick(): Promise<boolean> {
    if (this.stopping) return false;
    const store = this.options.store;
    let didWork = false;

    let rootSlots = Math.max(
      0,
      (this.options.maxConcurrentTasks ?? Number.POSITIVE_INFINITY) -
        store.listTasks(500).filter(
          (task) => !task.parentId && task.status === 'running',
        ).length,
    );
    for (const task of store.listTasks(500).filter((t) => t.status === 'pending')) {
      if (!task.parentId && rootSlots <= 0) continue;
      this.bus.dispatch({
        type: 'task.claim',
        taskId: task.id as TaskId,
        leaseUntil: this.options.clock.iso(this.options.clock.now() + 60_000),
      });
      if (!task.parentId && Number.isFinite(rootSlots)) rootSlots -= 1;
      didWork = true;
    }

    for (const task of store.listTasks(500)) {
      if (!['running', 'waiting_gate', 'waiting_input'].includes(task.status)) continue;
      if (store.listRuns(task.id).length > 0) continue;
      await this.startRun(task);
      didWork = true;
    }

    const active = store
      .listTasks(500)
      .filter((task) => !['pending', 'cancelled', 'succeeded', 'failed'].includes(task.status));

    const results = await Promise.all(
      active.map(async (task) => {
        let worked = false;
        for (const run of store.listRuns(task.id)) {
          if (run.status !== 'running' && run.status !== 'waiting') continue;
          if (await this.stepRun(task, run)) worked = true;
        }
        return worked;
      }),
    );
    if (results.some(Boolean)) didWork = true;

    return didWork;
  }

  private withQaNode(spec: WorkflowSpec, qaAgent: string): WorkflowSpec {
    if (
      spec.nodes.some(
        (node) => node.type === 'llm' && node.agent === (qaAgent as AgentId),
      )
    ) {
      return spec;
    }
    const terminalIds = spec.nodes
      .filter((node) => !spec.edges.some((edge) => edge.from === node.id))
      .map((node) => node.id);
    if (terminalIds.length === 0) return spec;
    const qaNode: LlmNode = {
      id: 'qa_review' as NodeId,
      type: 'llm',
      description: '独立 QA 审查',
      inputs: [],
      outputs: [{ name: 'review', kind: 'text' }],
      tools: ['read_file'],
      agent: qaAgent as AgentId,
      systemPrompt:
        '你是独立 QA，只审查已完成节点的产物与说明；不要修改文件，不要重做实现。',
      instructions:
        '审查前序节点的产物是否满足任务目标，列出阻塞问题；没有问题时明确说明通过。',
    };
    return {
      ...spec,
      nodes: [...spec.nodes, qaNode],
      edges: [
        ...spec.edges,
        ...terminalIds.map((from) => ({ from, to: qaNode.id })),
      ],
    };
  }

  private async startRun(task: TaskRow): Promise<void> {
    let spec: WorkflowSpec;
    try {
      spec = (await this.options.planner.plan(task)).spec;
      if (!task.parentId && this.options.qaAgent) {
        spec = this.withQaNode(spec, this.options.qaAgent);
      }
    } catch (error) {
      this.bus.dispatch({
        type: 'task.fail',
        taskId: task.id as TaskId,
        error: toErrorInfo(error),
      });
      return;
    }

    const specId = specHash(spec);
    this.options.store.saveSpec(specId, spec);
    this.bus.dispatch({
      type: 'run.start',
      runId: this.options.ids.run(),
      taskId: task.id as TaskId,
      specId,
      params: {},
    });
  }

  private async stepRun(task: TaskRow, run: RunRow): Promise<boolean> {
    const store = this.options.store;
    const spec = store.getSpec(run.specId);
    if (!spec) {
      this.bus.dispatch({
        type: 'run.fail',
        runId: run.id as RunId,
        error: { code: 'E_SPEC_MISSING', message: `找不到 spec：${run.specId}` },
      });
      return true;
    }

    let acted = false;
    const worktree = await this.ensureWorktree(task);
    const materialized = this.materializeNodes(task, run, spec);
    if (materialized > 0) acted = true;

    for (const node of store.listNodeRuns(run.id)) {
      const specNode = spec.nodes.find((n) => n.id === node.nodeId);
      if (!specNode) continue;

      if (node.status === 'ready') {
        const branch = this.conditionBranchStatus(task, run, spec, node.nodeId as NodeId);
        if (branch === 'skip') {
          this.bus.dispatch({
            type: 'node.skip',
            ...this.ctx(task.id, run.id, node),
            reason: 'condition branch not selected',
          });
          acted = true;
          continue;
        }
        const predecessors = spec.edges
          .filter((edge) => edge.to === node.nodeId)
          .map((edge) =>
            store.listNodeRuns(run.id).find((row) => row.nodeId === edge.from),
          );
        if (
          predecessors.some(
            (row) =>
              row &&
              ['failed', 'cancelled', 'skipped'].includes(row.status),
          )
        ) {
          this.bus.dispatch({
            type: 'node.skip',
            ...this.ctx(task.id, run.id, node),
            reason: 'upstream failed',
          });
          acted = true;
          continue;
        }
        if (
          !predecessors.every((row) => row?.status === 'succeeded')
        ) {
          continue;
        }
        if (
          this.isDelegatedNode(task, specNode) &&
          this.activeChildCount(task.id) >= (this.options.maxConcurrentChildren ?? 4)
        ) {
          continue;
        }
        await this.executeNode(task, run, specNode, node, worktree);
        acted = true;
      } else if (node.status === 'running' && this.isDelegatedNode(task, specNode)) {
        if (specNode.type === 'delegate') {
          if (await this.pollDelegate(task, run, spec, specNode, node, worktree)) {
            acted = true;
          }
        } else if (specNode.type === 'fanout') {
          if (await this.pollFanout(task, run, specNode, node, worktree)) {
            acted = true;
          }
        } else if (
          await this.pollImplicitDelegate(
            task,
            run,
            spec,
            specNode as LlmNode | ShellNode,
            node,
            worktree,
          )
        ) {
          acted = true;
        }
      } else if (node.status === 'running' && specNode.type === 'subworkflow') {
        if (await this.pollSubworkflow(task, run, specNode, node, worktree)) {
          acted = true;
        }
      } else if (node.status === 'verifying') {
        await this.finishVerification(task, run, specNode, node, worktree);
        acted = true;
      } else if (node.status === 'waiting_gate') {
        if (this.resolveGate(task, run, specNode, node)) acted = true;
      }
    }

    if (this.completeRun(task, run, spec)) {
      acted = true;
      for (const key of this.sessionLinks.keys()) {
        if (key.startsWith(`${run.id}:`)) this.sessionLinks.delete(key);
      }
      await this.cleanupTaskWorktree(task.id);
    }
    return acted;
  }

  private async cleanupTaskWorktree(taskId: string): Promise<void> {
    if (!this.options.cleanupWorktrees) return;
    const git = this.options.git;
    const task = this.options.store.getTask(taskId);
    const repo = task?.repoPath ?? this.options.repoPath;
    if (!git || !repo) return;

    const worktree =
      this.worktrees.get(taskId) ??
      (this.options.worktreeRoot
        ? join(this.options.worktreeRoot, taskId)
        : undefined);
    if (!worktree) return;

    this.worktrees.delete(taskId);
    try {
      await git.removeWorktree({ repo, worktree, force: true });
    } catch {
      // 已经不存在或从未创建，忽略
    }
  }

  private materializeNodes(task: TaskRow, run: RunRow, spec: WorkflowSpec): number {
    const store = this.options.store;
    const nodes = store.listNodeRuns(run.id);
    const byNode = new Map(nodes.map((n) => [n.nodeId, n]));
    let created = 0;

    for (const specNode of spec.nodes) {
      if (byNode.has(specNode.id)) continue;

      const predecessors = spec.edges
        .filter((edge) => edge.to === specNode.id)
        .map((edge) => byNode.get(edge.from));

      const branch = this.conditionBranchStatus(task, run, spec, specNode.id);
      if (branch === 'wait') continue;
      if (branch === 'skip') {
        const nodeRunId = this.options.ids.nodeRun();
        const branchCtx = {
          taskId: task.id as TaskId,
          runId: run.id as RunId,
          nodeRunId,
          nodeId: specNode.id,
        };
        this.bus.dispatch({ type: 'node.ready', ...branchCtx });
        this.bus.dispatch({
          type: 'node.skip',
          ...branchCtx,
          reason: 'condition branch not selected',
        });
        created += 1;
        continue;
      }

      const blocked = predecessors.some(
        (p) => p && ['failed', 'cancelled', 'skipped'].includes(p.status),
      );
      if (blocked) {
        const nodeRunId = this.options.ids.nodeRun();
        const blockedCtx = {
          taskId: task.id as TaskId,
          runId: run.id as RunId,
          nodeRunId,
          nodeId: specNode.id,
        };
        // 先建节点行，再跳过；否则投影层找不到这个节点
        this.bus.dispatch({ type: 'node.ready', ...blockedCtx });
        this.bus.dispatch({ type: 'node.skip', ...blockedCtx, reason: 'upstream failed' });
        created += 1;
        continue;
      }

      const ready = predecessors.every((p) => p && p.status === 'succeeded');
      if (ready) {
        this.bus.dispatch({
          type: 'node.ready',
          taskId: task.id as TaskId,
          runId: run.id as RunId,
          nodeRunId: this.options.ids.nodeRun(),
          nodeId: specNode.id,
        });
        created += 1;
      }
    }
    return created;
  }

  private conditionBranchStatus(
    task: TaskRow,
    run: RunRow,
    spec: WorkflowSpec,
    nodeId: NodeId,
  ): 'wait' | 'skip' | undefined {
    const nodes = this.options.store.listNodeRuns(run.id);
    for (const candidate of spec.nodes) {
      if (candidate.type !== 'condition') continue;
      const inTrue = candidate.branches.whenTrue.includes(nodeId);
      const inFalse = candidate.branches.whenFalse.includes(nodeId);
      if (!inTrue && !inFalse) continue;
      const condition = nodes.find((row) => row.nodeId === candidate.id);
      if (!condition) return 'wait';
      if (['failed', 'cancelled', 'skipped'].includes(condition.status)) {
        return 'skip';
      }
      if (condition.status !== 'succeeded') return 'wait';
      const output = ((condition.outputs ?? []) as ArtifactRef[]).find(
        (artifact) => artifact.schema === 'hive/condition',
      );
      const value = isRecord(output?.data) && typeof output.data.value === 'boolean'
        ? output.data.value
        : undefined;
      if (value === undefined) {
        throw new AppError(
          'E_CONDITION_OUTPUT',
          `条件节点 ${candidate.id} 没有布尔决策输出`,
        );
      }
      const selected = value ? candidate.branches.whenTrue : candidate.branches.whenFalse;
      if (!selected.includes(nodeId)) return 'skip';
    }
    return undefined;
  }

  /* ---------------- node ---------------- */

  private async executeNode(
    task: TaskRow,
    run: RunRow,
    specNode: NodeSpec,
    node: NodeRunRow,
    worktree: string,
  ): Promise<void> {
    const ctx = this.ctx(task.id, run.id, node);
    this.bus.dispatch({ type: 'node.start', ...ctx });

    const budgetError = this.executionBudgetError(task);
    if (budgetError) {
      this.bus.dispatch({
        type: 'node.fail',
        ...ctx,
        error: budgetError,
      });
      return;
    }

    if (specNode.type === 'delegate') {
      try {
        await this.startDelegate(task, specNode, node);
      } catch (error) {
        this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      }
      return;
    }

    if (specNode.type === 'fanout') {
      try {
        await this.startFanout(task, run, specNode, node, worktree);
      } catch (error) {
        this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      }
      return;
    }

    if (this.shouldIsolateNode(task, specNode)) {
      try {
        if (specNode.type === 'llm') this.assertNodeAgent(task, specNode);
        await this.startImplicitDelegate(task, specNode, node);
      } catch (error) {
        this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      }
      return;
    }

    if (specNode.type === 'subworkflow') {
      try {
        await this.startSubworkflow(task, run, specNode, node);
      } catch (error) {
        this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      }
      return;
    }

    let result: ExecutionResult;
    const controller = new AbortController();
    this.controllers.set(node.id, controller);

    try {
      await this.checkpointNode(run, specNode, node, worktree, 'before');
      result = await this.executeByType(
        specNode,
        task,
        run,
        node,
        worktree,
        controller.signal,
      );
      if (this.isCancelled(node.id)) return;
      this.bus.dispatch({
        type: 'node.produced',
        ...ctx,
        outputs: result.outputs,
        transcriptRef: result.transcriptRef,
        ...(result.sessionKey ? { sessionKey: result.sessionKey } : {}),
        ...(result.sessionCumulativeUsd !== undefined
          ? { sessionCumulativeUsd: result.sessionCumulativeUsd }
          : {}),
        usage: result.usage,
      });
      await this.commitNode(task, run, specNode, worktree);
      await this.checkpointNode(run, specNode, node, worktree, 'after');
      try {
        this.options.onNodeOutcome?.({
          taskId: task.id,
          nodeRunId: node.id,
          nodeId: specNode.id,
          agentId: this.nodeAgent(task, specNode),
          title: specNode.description,
          status: 'succeeded',
          summary:
            result.text?.trim().slice(0, 4000) ||
            result.outputs
              .map((artifact) => `${artifact.name}:${artifact.path ?? ''}`)
              .join('\n'),
          outputs: result.outputs.map((artifact) => ({
            name: artifact.name,
            ...(artifact.path ? { path: artifact.path } : {}),
          })),
          usd: result.usage?.usd,
        });
      } catch {
        // 记忆写入是旁路，不能影响节点成功。
      }
    } catch (error) {
      if (this.stopping || this.isCancelled(node.id)) return;
      this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      return;
    } finally {
      this.controllers.delete(node.id);
    }

    const fresh = this.options.store.getNodeRun(node.id);
    if (fresh) await this.finishVerification(task, run, specNode, fresh, worktree);
  }

  private recordToolEvent(
    task: TaskRow,
    run: RunRow,
    node: NodeRunRow,
    executor: string,
    event: AgentToolEvent,
  ): void {
    const base = {
      id: this.options.ids.event(),
      ts: this.options.clock.iso(),
      v: EVENT_SCHEMA_VERSION,
      actor: { type: 'agent' as const, id: executor as AgentId },
      taskId: task.id as TaskId,
      runId: run.id as RunId,
      nodeRunId: node.id as NodeRunId,
      correlationId: task.id,
    };
    const payload =
      event.phase === 'call'
        ? {
            type: 'tool.called' as const,
            payload: {
              tool: event.tool,
              argsHash: createHash('sha1')
                .update(event.inputPreview ?? '')
                .digest('hex')
                .slice(0, 12),
              toolUseId: event.toolUseId,
              inputPreview: event.inputPreview,
              nodeId: node.nodeId as NodeId,
            },
          }
        : {
            type: 'tool.result' as const,
            payload: {
              tool: event.tool,
              ok: event.ok !== false,
              durationMs: event.durationMs ?? 0,
              toolUseId: event.toolUseId,
              outputPreview: event.outputPreview,
              ...(event.error
                ? {
                    error: {
                      code: 'E_TOOL_FAILED',
                      message: event.error,
                    },
                  }
                : {}),
              nodeId: node.nodeId as NodeId,
            },
          };
    try {
      this.bus.record([{ ...base, ...payload } as NewEvent]);
    } catch {
      // 工具观测不能影响节点执行
    }
  }

  private isCancelled(nodeRunId: string): boolean {
    return this.options.store.getNodeRun(nodeRunId)?.status === 'cancelled';
  }

  private findSessionSource(
    run: RunRow,
    specNode: NodeSpec,
    node: NodeRunRow,
  ): SessionLink | undefined {
    if (this.options.executionMode !== 'session' || node.transcriptRef) {
      return undefined;
    }
    const spec = this.options.store.getSpec(run.specId);
    if (!spec) return undefined;
    const incoming = spec.edges.filter((edge) => edge.to === specNode.id);
    if (incoming.length !== 1) return undefined;
    const priorId = incoming[0]!.from;
    const outgoing = spec.edges.filter((edge) => edge.from === priorId);
    const fork = outgoing.length > 1;
    const priorSpec = spec.nodes.find((candidate) => candidate.id === priorId);
    if (!priorSpec || priorSpec.type !== 'llm') return undefined;
    const priorRun = this.options.store
      .listNodeRuns(run.id)
      .find((candidate) => candidate.nodeId === priorId);
    if (!priorRun || priorRun.status !== 'succeeded') return undefined;
    const inMemory = this.sessionLinks.get(`${run.id}:${priorId}`);
    if (inMemory) return { ...inMemory, fork };
    if (!priorRun.transcriptRef || !priorRun.sessionKey) return undefined;
    return {
      transcriptRef: priorRun.transcriptRef,
      sessionKey: priorRun.sessionKey,
      cumulativeUsd: priorRun.sessionCumulativeUsd,
      memoryKeys: priorRun.sessionMemoryKeys,
      fork,
    };
  }

  private sessionIdentity(input: {
    agentId: string;
    providerId: string;
    model: string;
    tools: string[];
    skills: string[];
    mcpServers?: Record<string, unknown>;
    cwd: string;
    systemPrompt: string;
  }): string {
    return JSON.stringify({
      agentId: input.agentId,
      providerId: input.providerId,
      model: input.model,
      tools: [...input.tools].sort(),
      skills: [...input.skills].sort(),
      mcpServers: input.mcpServers ?? {},
      cwd: input.cwd,
      systemPrompt: input.systemPrompt,
    });
  }

  private async executeByType(
    specNode: NodeSpec,
    task: TaskRow,
    run: RunRow,
    node: NodeRunRow,
    worktree: string,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (specNode.type === 'llm') {
      this.assertNodeAgent(task, specNode);

      const agentId = this.nodeAgent(task, specNode);
      const agent = this.agents?.get(agentId);
      if (this.agents && !agent) {
        throw new AppError('E_AGENT_NOT_FOUND', `未知 agent：${agentId}`);
      }

      const agentTools = agent?.tools.allow ?? [];
      const requestedTools = specNode.tools.length > 0 ? specNode.tools : agentTools;
      if (
        agent &&
        specNode.tools.length > 0 &&
        !requestedTools.every((tool) => agentTools.includes(tool))
      ) {
        throw new AppError('E_AGENT_TOOL_DENIED', `agent ${agent.id} 不允许工具`, {
          details: { requested: specNode.tools, allowed: agentTools },
        });
      }

      let model = this.options.model;
      if (specNode.model && specNode.model !== 'inherit') {
        model = specNode.model.model;
      } else if (agent?.model && agent.model.model !== 'inherit') {
        model = agent.model.model;
      }
      const route = routeModel({
        node: specNode,
        agent,
        defaultProvider: this.options.provider,
        defaultModel: model,
        providers: this.options.providers,
      });
      model = route.model;

      const baseSystemPrompt =
        [agent?.systemPrompt ?? agent?.role].filter((part): part is string => Boolean(part)).join('\n\n') ||
        '你是工作流里的一个执行节点，只完成交给你的这一件事。';
      const nodeSystemPrompt = specNode.systemPrompt?.trim();
      const sessionMode = this.options.executionMode === 'session';
      const resolvedSkills = this.options.resolveSkills?.(agent?.skills ?? []) ?? [];
      const sessionSource = this.findSessionSource(run, specNode, node);
      const sessionKeyForSession = sessionMode
        ? this.sessionIdentity({
            agentId,
            providerId: route.provider.id,
            model,
            tools: requestedTools,
            skills: resolvedSkills.map((skill) => skill.name),
            mcpServers: this.options.mcpServers,
            cwd: worktree,
            // session 模式 system prompt 不包含节点级记忆/知识，先算稳定指纹。
            systemPrompt: baseSystemPrompt,
          })
        : undefined;
      const ownResumeSessionId = node.transcriptRef?.startsWith('sdk://')
        ? node.transcriptRef.slice('sdk://'.length)
        : undefined;
      const sourceResumeSessionId =
        sessionKeyForSession &&
        sessionSource?.sessionKey === sessionKeyForSession &&
        sessionSource.transcriptRef.startsWith('sdk://')
          ? sessionSource.transcriptRef.slice('sdk://'.length)
          : undefined;
      const resumingSession = Boolean(ownResumeSessionId || sourceResumeSessionId);
      const knownMemoryKeys = new Set(
        (sessionSource?.memoryKeys ?? []).map((memory) => memory.trim()).filter(Boolean),
      );
      const refreshRequested = sessionMode
        ? this.options.store.consumeMemoryRefresh(run.id)
        : false;
      // 同一个 session 默认只检索一次；refresh 时只注入新增记忆，避免重复污染。
      let memories: string[] = [];
      let memoryKeys = [...knownMemoryKeys];
      if (!sessionMode) {
        memories = await (this.options.memoryContext?.(
          agentId,
          specNode.instructions ?? specNode.description,
        ) ?? []);
      } else if (!resumingSession) {
        memories = await (this.options.memoryContext?.(
          agentId,
          specNode.instructions ?? specNode.description,
        ) ?? []);
        memoryKeys = [
          ...new Set(memories.map((memory) => memory.trim()).filter(Boolean)),
        ];
      } else if (refreshRequested) {
        const fresh = await (this.options.memoryContext?.(
          agentId,
          specNode.instructions ?? specNode.description,
        ) ?? []);
        memories = fresh.filter((memory) => {
          const key = memory.trim();
          return key.length > 0 && !knownMemoryKeys.has(key);
        });
        memoryKeys = [
          ...new Set([
            ...knownMemoryKeys,
            ...memories.map((memory) => memory.trim()).filter(Boolean),
          ]),
        ];
      }
      const memoryBlock =
        memories.length > 0
          ? `长期记忆（仅作参考，不要泄露给用户）：\n${memories
              .map((memory) => `- ${memory}`)
              .join('\n')}`
          : '';
      const knowledge = this.options.knowledgeContext?.(
        specNode.instructions ?? specNode.description,
      ) ?? [];
      const knowledgeBlock =
        knowledge.length > 0
          ? `项目知识（按任务检索；以文件内容为准）：\n${knowledge
              .map((chunk) => `---\n${chunk}`)
              .join('\n')}`
          : '';
      const systemPrompt = sessionMode
        ? baseSystemPrompt
        : [baseSystemPrompt, nodeSystemPrompt, memoryBlock, knowledgeBlock]
            .filter((part): part is string => Boolean(part))
            .join('\n\n');
      const taskParts = [
        specNode.instructions ?? specNode.description,
        `任务：${task.title}`,
      ];
      if (sessionMode) {
        // 节点特有内容放在消息里，避免每个节点重写 system prompt / 破坏前缀缓存。
        if (nodeSystemPrompt) taskParts.push(`节点要求：\n${nodeSystemPrompt}`);
        if (memoryBlock) taskParts.push(memoryBlock);
        if (knowledgeBlock) taskParts.push(knowledgeBlock);
      }
      const sessionKey =
        sessionKeyForSession ??
        this.sessionIdentity({
          agentId,
          providerId: route.provider.id,
          model,
          tools: requestedTools,
          skills: resolvedSkills.map((skill) => skill.name),
          mcpServers: this.options.mcpServers,
          cwd: worktree,
          systemPrompt,
        });

      const output = await this.options.runtime.run({
        systemPrompt,
        task: taskParts.join('\n\n'),
        cwd: worktree,
        allowedTools: requestedTools,
        skills: resolvedSkills,
        mcpServers: this.options.mcpServers,
        provider: route.provider,
        model,
        resumeSessionId: ownResumeSessionId ?? sourceResumeSessionId,
        ...(ownResumeSessionId === undefined &&
        sourceResumeSessionId &&
        sessionSource?.fork
          ? { forkSession: true }
          : {}),
        modelContext: route.provider.models?.[model],
        budget: {
          maxTurns: specNode.maxTurns ?? this.options.maxTurns ?? 60,
          maxUsd: this.options.maxUsdPerNode ?? 5,
        },
        signal,
        onToolEvent: (event) =>
          this.recordToolEvent(task, run, node, agentId, event),
      });

      if (output.stopReason === 'aborted') {
        throw new AppError('E_ABORTED', '节点已取消');
      }
      if (output.stopReason !== 'finished') {
        throw new AppError('E_AGENT_FAILED', `执行器返回 ${output.stopReason}`, {
          details: {
            ...(output.error ?? {}),
            ...(output.transcriptRef ? { transcriptRef: output.transcriptRef } : {}),
          },
        });
      }
      if (sessionMode && output.transcriptRef) {
        this.sessionLinks.set(`${run.id}:${specNode.id}`, {
          transcriptRef: output.transcriptRef,
          sessionKey,
          cumulativeUsd: output.usage.usd,
          memoryKeys,
        });
        this.options.store.setNodeMemoryKeys(node.id, memoryKeys);
      }
      const resumedFromSource =
        sourceResumeSessionId !== undefined && ownResumeSessionId === undefined;
      const normalizedUsage =
        sessionMode &&
        resumedFromSource &&
        sessionSource?.cumulativeUsd !== undefined
          ? {
              ...output.usage,
              // 只记录本节点的增量，避免 resume session 的累计成本被重复相加。
              usd: Math.max(0, output.usage.usd - sessionSource.cumulativeUsd),
            }
          : output.usage;
      return {
        outputs: output.outputs,
        usage: normalizedUsage,
        transcriptRef: output.transcriptRef,
        text: output.text,
        ...(sessionMode ? { sessionKey } : {}),
        ...(sessionMode ? { sessionCumulativeUsd: output.usage.usd } : {}),
      };
    }

    if (specNode.type === 'shell' || specNode.type === 'verify') {
      const result = await this.runShellCommand(specNode, worktree, signal);
      if (result.exitCode !== 0) {
        throw new AppError('E_SHELL_EXIT', `命令退出码 ${result.exitCode}`, {
          details: { stderr: result.stderr.slice(0, 2000) },
        });
      }
      return { outputs: [] };
    }

    if (specNode.type === 'condition') {
      const result = await this.runShellCommand(specNode, worktree, signal);
      return {
        outputs: [{
          name: 'condition',
          kind: 'json',
          schema: 'hive/condition',
          data: {
            value: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(-2000),
            stderr: result.stderr.slice(-2000),
          },
        }],
      };
    }

    if (specNode.type === 'loop') {
      let lastExit = 1;
      let lastError = '';
      for (let iteration = 1; iteration <= specNode.maxIterations; iteration += 1) {
        const result = await this.runShellCommand(specNode, worktree, signal);
        lastExit = result.exitCode;
        lastError = result.stderr.slice(-2000);
        if (result.exitCode === 0) {
          return {
            outputs: [{
              name: 'loop',
              kind: 'json',
              schema: 'hive/loop',
              data: { iterations: iteration, maxIterations: specNode.maxIterations },
            }],
          };
        }
        if (iteration < specNode.maxIterations && (specNode.intervalMs ?? 0) > 0) {
          await delay(specNode.intervalMs!, signal);
        }
      }
      throw new AppError(
        'E_LOOP_EXHAUSTED',
        `循环节点 ${specNode.id} 在 ${specNode.maxIterations} 次后仍未满足条件`,
        { details: { exitCode: lastExit, stderr: lastError } },
      );
    }

    throw new AppError('E_NODE_UNSUPPORTED', `engine 暂不支持 ${specNode.type} 节点`);
  }

  private async runShellCommand(
    specNode: ShellNode | VerifyNode | ConditionNode | LoopNode,
    worktree: string,
    signal: AbortSignal,
  ) {
    const shell = specNode.shell ?? 'bash';
    return this.options.shell.run({
      command:
        shell === 'pwsh'
          ? `pwsh -NoProfile -Command ${JSON.stringify(specNode.run)}`
          : specNode.run,
      cwd: worktree,
      timeoutMs: durationToMs(specNode.timeout) ?? DEFAULT_TIMEOUT_MS,
      env: specNode.type === 'shell' || specNode.type === 'verify'
        ? specNode.env
        : undefined,
      signal,
    });
  }

  private async finishVerification(
    task: TaskRow,
    run: RunRow,
    specNode: NodeSpec,
    node: NodeRunRow,
    worktree: string,
  ): Promise<void> {
    if (this.isCancelled(node.id)) return;

    const verifiers = specNode.verify ?? (specNode.type === 'shell' ? [{ kind: 'exit_code' as const }] : []);

    try {
      verifyArtifactContracts(
        specNode,
        worktree,
        (node.outputs ?? []) as ArtifactRef[],
      );
    } catch (error) {
      this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      return;
    }

    for (const verifier of verifiers) {
      if (verifier.kind === 'exit_code') continue;
      if (verifier.kind === 'judge') {
        const result = await this.judgeDelivery(task, specNode, node, worktree, verifier.rubric, verifier.threshold ?? 0.8);
        if (result !== true && !verifier.advisory) {
          this.handleFailure(task, run, specNode, node, {
            code: 'E_VERIFY_JUDGE',
            message: typeof result === 'string' ? result : '交付物未通过 doneCriteria',
          });
          return;
        }
        continue;
      }
      const result = await this.options.shell.run({
        command: verifier.run,
        cwd: worktree,
        timeoutMs: durationToMs(verifier.timeout) ?? DEFAULT_TIMEOUT_MS,
      });
      if (this.isCancelled(node.id)) return;
      if (result.exitCode !== 0 && !verifier.advisory) {
        this.handleFailure(task, run, specNode, node, {
          code: 'E_VERIFY_FAILED',
          message: `验证器失败：${verifier.run}`,
          detail: { stderr: result.stderr.slice(0, 2000) },
        });
        return;
      }
    }

    if (specNode.approval) {
      this.openGate(task, run, specNode, node);
      return;
    }

    this.bus.dispatch({ type: 'node.complete', ...this.ctx(task.id, run.id, node) });
  }

  private async judgeDelivery(
    task: TaskRow,
    specNode: NodeSpec,
    node: NodeRunRow,
    worktree: string,
    rubric: string,
    threshold: number,
  ): Promise<true | string> {
    const agentId = specNode.type === 'llm' && specNode.agent
      ? specNode.agent
      : (task.assignee as AgentId);
    const agent = this.agents?.get(agentId);
    let model = this.options.model;
    if (specNode.type === 'llm' && specNode.model && specNode.model !== 'inherit') {
      model = specNode.model.model;
    } else if (agent && agent.model.model !== 'inherit') {
      model = agent.model.model;
    }
    const controller = new AbortController();
    this.controllers.set(node.id, controller);
    try {
      const result = await this.options.runtime.run({
        systemPrompt: [
          '你是独立的交付物验证器，不负责修改文件。',
          '使用 Read/Glob 检查声明的产物；只输出 JSON：{"pass":true,"score":0..1,"reason":"证据"}。',
          '没有证据、文件缺失或不符合完成标准时 pass=false，不要猜测。',
        ].join('\n'),
        task: [
          `节点：${specNode.description}`,
          `完成标准：${rubric}`,
          `声明产物：${JSON.stringify(specNode.outputs)}`,
          `实际产物：${JSON.stringify(node.outputs ?? [])}`,
        ].join('\n\n'),
        cwd: worktree,
        allowedTools: ['Read', 'Glob'],
        skills: [],
        provider: this.options.provider,
        model,
        budget: {
          maxTurns: 6,
          maxUsd: Math.min(this.options.maxUsdPerNode ?? 5, 0.5),
        },
        signal: controller.signal,
      });
      if (result.stopReason !== 'finished') return `judge 执行器返回 ${result.stopReason}`;
      const match = /\{[\s\S]*\}/.exec(result.text ?? '');
      if (!match) return 'judge 没有返回 JSON';
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return 'judge 返回的不是合法 JSON';
      }
      if (!isRecord(parsed) || typeof parsed.pass !== 'boolean') {
        return 'judge 缺少布尔 pass';
      }
      const score = typeof parsed.score === 'number' ? parsed.score : parsed.pass ? 1 : 0;
      if (parsed.pass && score >= threshold) return true;
      return typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason
        : `judge 分数 ${score} 低于 ${threshold}`;
    } finally {
      this.controllers.delete(node.id);
    }
  }

  private openGate(task: TaskRow, run: RunRow, specNode: NodeSpec, node: NodeRunRow): void {
    const gateId = this.options.ids.gate();
    this.bus.dispatch({
      type: 'gate.request',
      gateId,
      taskId: task.id as TaskId,
      nodeRunId: node.id as NodeRunId,
      kind: 'human',
      ask: 'approve',
      attempt: node.attempt,
      payload: {
        title: specNode.description,
        summary: `节点 ${specNode.id} 已完成，等待审批`,
        artifacts: (node.outputs ?? []) as ArtifactRef[],
        meta: { costUsd: node.costUsd, attempts: node.attempt },
      },
    });
    this.bus.dispatch({
      type: 'node.wait_gate',
      ...this.ctx(task.id, run.id, node),
      gateId,
    });

    const freshTask = this.options.store.getTask(task.id);
    if (freshTask?.status === 'running') {
      this.bus.dispatch({
        type: 'task.wait',
        taskId: task.id as TaskId,
        reason: 'gate',
        refId: gateId,
      });
    }
  }

  private resolveGate(
    task: TaskRow,
    run: RunRow,
    specNode: NodeSpec,
    node: NodeRunRow,
  ): boolean {
    const gates = this.options.store.listGatesByNodeRun(node.id);
    const gate = gates.at(-1);
    if (!gate || gate.status === 'pending') return false;

    const freshTask = this.options.store.getTask(task.id);
    if (freshTask?.status === 'waiting_gate') {
      this.bus.dispatch({ type: 'task.resume', taskId: task.id as TaskId, reason: 'gate decided' });
    }

    if (gate.status === 'passed') {
      this.bus.dispatch({ type: 'node.complete', ...this.ctx(task.id, run.id, node) });
      return true;
    }

    if (gate.status === 'failed') {
      this.handleFailure(task, run, specNode, node, {
        code: 'E_GATE_REJECTED',
        message: gate.result ? JSON.stringify(gate.result) : '人审打回',
      });
      return true;
    }

    return false;
  }

  private handleFailure(
    task: TaskRow,
    run: RunRow,
    specNode: NodeSpec,
    node: NodeRunRow,
    error: { code: string; message: string; detail?: unknown },
  ): void {
    const current = this.options.store.getNodeRun(node.id);
    // 取消已经落库后，不要再补一条 retry/fail
    if (!current || current.status === 'cancelled') return;    const freshTask = this.options.store.getTask(task.id);
    if (freshTask?.status === 'cancelled') return;

    const transcriptRef = isRecord(error.detail) && typeof error.detail.transcriptRef === 'string'
      ? error.detail.transcriptRef
      : undefined;
    if (transcriptRef && current.status === 'running') {
      this.bus.dispatch({
        type: 'node.produced',
        ...this.ctx(task.id, run.id, node),
        outputs: [],
        transcriptRef,
      });
    }

    const maxRetries = specNode.retries ?? 0;
    const canRetry = node.attempt <= maxRetries && specNode.retryPolicy !== 'never';

    if (canRetry) {
      this.bus.dispatch({
        type: 'node.retry',
        ...this.ctx(task.id, run.id, node),
        reason: 'auto',
      });
      return;
    }

    this.bus.dispatch({
      type: 'node.fail',
      ...this.ctx(task.id, run.id, node),
      error,
    });
  }

  /* ---------------- worktree / commit ---------------- */

  private async ensureWorktree(task: TaskRow): Promise<string> {
    const git = this.options.git;
    const repoPath = task.repoPath ?? this.options.repoPath;
    if (!git || !repoPath || !this.options.worktreeRoot) {
      return task.repoPath ?? this.options.workspaceRoot;
    }

    const cached = this.worktrees.get(task.id);
    if (cached) return cached;

    let base: string | undefined;
    if (task.parentId) {
      const parent = this.options.store.getTask(task.parentId);
      if (parent) {
        base = await git.head(await this.ensureWorktree(parent));
      }
    }

    return this.withGitLock(async () => {
      const again = this.worktrees.get(task.id);
      if (again) return again;

      const worktree = join(this.options.worktreeRoot!, task.id);
      if (existsSync(worktree)) {
        this.worktrees.set(task.id, worktree);
        return worktree;
      }

      const handle = await git.createWorktree({
        repo: repoPath,
        worktree,
        branch: `agent/${task.assignee}/${task.id}`,
        base,
      });
      this.worktrees.set(task.id, handle.path);
      return handle.path;
    });
  }

  /** git worktree add 对同一个仓库不能并发，用一把串行锁。 */
  private async withGitLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.gitLock;
    let release!: () => void;
    this.gitLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async checkpointNode(
    run: RunRow,
    specNode: NodeSpec,
    node: NodeRunRow,
    worktree: string,
    phase: 'before' | 'after',
  ): Promise<void> {
    if (
      this.options.executionMode !== 'session' ||
      !this.options.git ||
      specNode.type !== 'llm' ||
      specNode.autoCommit === false
    ) {
      return;
    }
    const ref = `refs/spec-agent/checkpoints/${run.id}/${node.id}/${node.attempt}/${phase}`;
    try {
      await this.options.git.checkpoint(worktree, ref);
      this.options.store.setNodeCheckpoint(node.id, phase, ref);
    } catch {
      // checkpoint 是恢复辅助，不应阻断节点执行；Git 不可用时保持无 checkpoint。
    }
  }

  private async commitNode(
    task: TaskRow,
    run: RunRow,
    specNode: LlmNode | ShellNode | VerifyNode | ConditionNode | LoopNode,
    worktree: string,
  ): Promise<void> {
    const git = this.options.git;
    if (!git) return;
    if (specNode.autoCommit === false) return;

    const executor = this.nodeAgent(task, specNode);

    try {
      await git.commit({
        worktree,
        message: `${specNode.id}: ${specNode.description}`,
        scope: this.writeScopeFor(task, specNode),
        trailers: {
          'Spec-Agent': executor,
          ...(executor !== task.assignee
            ? { 'Spec-Agent-Task-Agent': task.assignee }
            : {}),
          ...(task.caller ? { 'Spec-Agent-Parent-Agent': task.caller } : {}),
          'Spec-Agent-Task': task.id,
          'Spec-Agent-Run': run.id,
          'Spec-Agent-Node': specNode.id,
        },
        author: { name: executor, email: `${executor}@spec-agent.local` },
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'E_GIT_NOTHING') return;
      throw error;
    }
  }

  private async mergeDelegate(
    task: TaskRow,
    run: RunRow,
    node: NodeRunRow,
    child: TaskRow,
    worktree: string,
  ): Promise<void> {
    const git = this.options.git;
    if (!git) return;
    const store = this.options.store;

    const queued = store.ensureMerge(task.id, node.id, child.id);
    if (queued.status === 'failed') {
      store.markMergePending(node.id);
    }

    const maxAttempts = Math.max(1, this.options.mergeAttempts ?? 2);
    const delay = this.options.mergeRetryDelayMs ?? 250;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await git.merge({
          worktree,
          branch: `agent/${child.assignee}/${child.id}`,
          message: `Merge ${child.assignee} (${child.id}) into ${task.assignee}`,
          trailers: {
            'Spec-Agent': task.assignee,
            'Spec-Agent-Task': task.id,
            'Spec-Agent-Run': run.id,
            'Spec-Agent-Node': node.nodeId,
            'Spec-Agent-Merged-Task': child.id,
            'Spec-Agent-Merged-Agent': child.assignee,
          },
          author: {
            name: task.assignee,
            email: `${task.assignee}@spec-agent.local`,
          },
          resolveConflicts: this.options.conflictResolver,
          attempt,
        });
        store.markMergeMerged(node.id);
        return;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const retryable =
          error instanceof AppError && error.code === 'E_GIT_MERGE_CONFLICT';
        store.markMergeAttempt(node.id, message);
        if (!retryable || attempt >= maxAttempts) {
          store.markMergeFailed(node.id, message);
          throw error;
        }
        if (delay > 0) await this.options.clock.sleep(delay);
      }
    }
  }

  /**
   * 合并顺序固定为 spec 里的委派/隔离节点顺序，而不是完成顺序。
   * 这样同一份 spec 每次产生相同的合并历史。
   */
  private earlierMergeState(
    task: TaskRow,
    spec: WorkflowSpec,
    specNode: NodeSpec,
    run: RunRow,
  ): 'ready' | 'wait' | 'failed' {
    const mergeNodes = spec.nodes.filter(
      (candidate) =>
        candidate.type === 'delegate' ||
        this.shouldIsolateNode(task, candidate),
    );
    const index = mergeNodes.findIndex((candidate) => candidate.id === specNode.id);
    if (index <= 0) return 'ready';

    const nodes = this.options.store.listNodeRuns(run.id);
    for (const earlier of mergeNodes.slice(0, index)) {
      const status = nodes.find((node) => node.nodeId === earlier.id)?.status;
      if (status === 'failed' || status === 'cancelled' || status === 'skipped') {
        return 'failed';
      }
      if (status !== 'succeeded') return 'wait';
    }
    return 'ready';
  }

  /* ---------------- delegate / subworkflow ---------------- */

  private activeChildCount(taskId: string): number {
    let count = 0;
    for (const child of this.options.store.listChildTasks(taskId)) {
      if (!['succeeded', 'failed', 'cancelled'].includes(child.status)) count += 1;
    }
    return count;
  }

  private shouldIsolateNode(
    task: TaskRow,
    specNode: NodeSpec,
  ): specNode is LlmNode | ShellNode {
    // 子任务本身必须就地执行，否则会无限委派
    if (task.parentId) return false;

    if (this.options.executionMode === 'session') {
      // session 模式用 task 级 worktree；显式跨 agent 节点仍隔离为子任务。
      if (
        specNode.type === 'llm' &&
        (!specNode.agent || specNode.agent === task.assignee)
      ) {
        return false;
      }
      if (specNode.type === 'shell' && !specNode.approval) {
        return false;
      }
    }

    if (specNode.type === 'llm') {
      if (specNode.agent && specNode.agent !== task.assignee) return true;
      return this.options.isolateNodes === true;
    }

    if (specNode.type === 'shell') {
      // 计划闸门/人工审批留在父任务，避免为纯闸门再开子任务
      if (specNode.approval) return false;
      return this.options.isolateNodes === true;
    }

    return false;
  }

  private isDelegatedNode(task: TaskRow, specNode: NodeSpec): boolean {
    return (
      specNode.type === 'delegate' ||
      specNode.type === 'fanout' ||
      this.shouldIsolateNode(task, specNode)
    );
  }

  private async startImplicitDelegate(
    task: TaskRow,
    specNode: LlmNode | ShellNode,
    node: NodeRunRow,
  ): Promise<boolean> {
    const children = this.options.store
      .listChildTasks(task.id)
      .filter((child) => child.originNodeRunId === node.id);
    let active = false;
    for (const child of children) {
      if (!['failed', 'cancelled'].includes(child.status)) {
        active = true;
        break;
      }
    }
    if (active) return false;

    const childSpec: WorkflowSpec = {
      name: `node-${specNode.id}`,
      version: 1,
      params: [],
      nodes: [specNode],
      edges: [],
    };
    const specId = specHash(childSpec);
    this.options.store.saveSpec(specId, childSpec);

    const childTaskId = this.options.ids.task();
    this.options.store.bindSpec(childTaskId, specId);

    this.bus.dispatch({
      type: 'task.create',
      taskId: childTaskId,
      assignee:
        (specNode.type === 'llm' ? specNode.agent : undefined) ??
        (task.assignee as AgentId),
      caller: task.assignee as AgentId,
      parentTaskId: task.id as TaskId,
      originNodeRunId: node.id as NodeRunId,
      repoPath: task.repoPath ?? undefined,
      title: specNode.description,
      brief:
        specNode.type === 'llm'
          ? specNode.instructions ?? specNode.description
          : specNode.description,
      inputs: [],
    });
    return true;
  }

  private async pollImplicitDelegate(
    task: TaskRow,
    run: RunRow,
    spec: WorkflowSpec,
    specNode: LlmNode | ShellNode,
    node: NodeRunRow,
    worktree: string,
  ): Promise<boolean> {
    let child: TaskRow | undefined;
    for (const candidate of this.options.store.listChildTasks(task.id)) {
      if (candidate.originNodeRunId === node.id) child = candidate;
    }
    if (!child) return this.startImplicitDelegate(task, specNode, node);

    if (child.status === 'succeeded') {
      const earlier = this.earlierMergeState(task, spec, specNode, run);
      if (earlier === 'wait') return false;
      if (earlier === 'failed') {
        this.handleFailure(task, run, specNode, node, {
          code: 'E_MERGE_ORDER_BLOCKED',
          message: `前序合并节点失败，${specNode.id} 不再合并`,
        });
        return true;
      }

      try {
        await this.mergeDelegate(task, run, node, child, worktree);
      } catch (error) {
        this.handleFailure(task, run, specNode, node, toErrorInfo(error));
        return true;
      }

      this.bus.dispatch({
        type: 'node.produced',
        ...this.ctx(task.id, run.id, node),
        outputs: (child.result?.artifacts ?? []) as ArtifactRef[],
        usage: child.result?.usage,
      });
      const fresh = this.options.store.getNodeRun(node.id);
      if (fresh) await this.finishVerification(task, run, specNode, fresh, worktree);
      return true;
    }

    if (child.status === 'failed' || child.status === 'cancelled') {
      this.handleFailure(task, run, specNode, node, {
        code: 'E_DELEGATE_FAILED',
        message: `子任务 ${child.id} ${child.status}`,
      });
      return true;
    }

    return false;
  }

  private assertDelegation(task: TaskRow, target: AgentId): void {
    if (!this.agents) return;

    const parent = this.agents.get(task.assignee);
    if (!parent) {
      throw new AppError('E_AGENT_NOT_FOUND', `未知 agent：${task.assignee}`);
    }
    if (!this.agents.has(target)) {
      throw new AppError('E_AGENT_NOT_FOUND', `未知 agent：${target}`);
    }

    let allowed = parent.canDelegateTo;
    if (!allowed) {
      allowed = [];
      for (const agent of this.agents.values()) {
        if (agent.parent === parent.id) allowed.push(agent.id);
      }
    }

    if (!allowed.includes(target)) {
      throw new AppError(
        'E_DELEGATION_FORBIDDEN',
        `${parent.id} 不能委派给 ${target}`,
        { details: { allowed } },
      );
    }
  }

  private async startFanout(
    task: TaskRow,
    run: RunRow,
    specNode: FanoutNode,
    node: NodeRunRow,
    worktree: string,
  ): Promise<number> {
    const items = readFanoutItems(worktree, specNode.itemsPath);
    const children = this.options.store
      .listChildTasks(task.id)
      .filter((child) => child.originNodeRunId === node.id);
    const existing = new Set(
      children
        .map((child) => /^fanout:(\d+):/.exec(child.title)?.[1])
        .filter((value): value is string => Boolean(value))
        .map(Number),
    );
    const active = children.filter(
      (child) => !['succeeded', 'failed', 'cancelled'].includes(child.status),
    ).length;
    const nodeLimit = specNode.maxConcurrency ?? 4;
    const globalLimit = this.options.maxConcurrentChildren ?? 4;
    let slots = Math.max(
      0,
      Math.min(nodeLimit, globalLimit) -
        Math.max(active, this.activeChildCount(task.id)),
    );
    if (slots === 0) return 0;

    const assignee = specNode.agent ?? (task.assignee as AgentId);
    if (assignee !== task.assignee) this.assertDelegation(task, assignee);
    let created = 0;
    for (const [index, item] of items.entries()) {
      if (existing.has(index) || slots <= 0) continue;
      const childTaskId = this.options.ids.task();
      const childSpec: WorkflowSpec = {
        name: `fanout-${specNode.id}-${index}`,
        version: 1,
        params: [],
        nodes: [{
          id: 'item' as NodeId,
          type: 'shell',
          description: fanoutItemTitle(item),
          inputs: [],
          outputs: [],
          run: renderFanoutBrief(specNode.run, item, index),
          shell: specNode.shell,
          autoCommit: true,
        }],
        edges: [],
      };
      const childSpecId = specHash(childSpec);
      this.options.store.saveSpec(childSpecId, childSpec);
      this.options.store.bindSpec(childTaskId, childSpecId);
      this.bus.dispatch({
        type: 'task.create',
        taskId: childTaskId,
        assignee,
        caller: task.assignee as AgentId,
        parentTaskId: task.id as TaskId,
        originNodeRunId: node.id as NodeRunId,
        repoPath: task.repoPath ?? undefined,
        title: `fanout:${index}: ${specNode.description} / ${fanoutItemTitle(item)}`,
        brief: renderFanoutBrief(specNode.brief, item, index),
        inputs: [],
      });
      existing.add(index);
      slots -= 1;
      created += 1;
    }
    return created;
  }

  private async pollFanout(
    task: TaskRow,
    run: RunRow,
    specNode: FanoutNode,
    node: NodeRunRow,
    worktree: string,
  ): Promise<boolean> {
    const created = await this.startFanout(task, run, specNode, node, worktree);
    if (created > 0) return true;

    const items = readFanoutItems(worktree, specNode.itemsPath);
    const children = this.options.store
      .listChildTasks(task.id)
      .filter((child) => child.originNodeRunId === node.id);
    if (children.length < items.length) return false;
    if (children.some((child) => ['failed', 'cancelled'].includes(child.status))) {
      this.handleFailure(task, run, specNode, node, {
        code: 'E_FANOUT_FAILED',
        message: `fanout ${specNode.id} 有子任务失败或取消`,
      });
      return true;
    }
    if (!children.every((child) => child.status === 'succeeded')) return false;

    try {
      if (this.options.git) {
        for (const child of children.sort((a, b) => a.id.localeCompare(b.id))) {
          const branch = child.branch ?? `agent/${child.assignee}/${child.id}`;
          await this.withGitLock(() =>
            this.options.git!.merge({
              worktree,
              branch,
              message: `Merge fanout ${specNode.id} / ${child.title}`,
              trailers: {
                'Spec-Agent': child.assignee,
                'Spec-Agent-Task': task.id,
                'Spec-Agent-Node': specNode.id,
                'Spec-Agent-Fanout-Task': child.id,
              },
              author: { name: child.assignee, email: `${child.assignee}@spec-agent.local` },
            }),
          );
        }
      }
    } catch (error) {
      this.handleFailure(task, run, specNode, node, toErrorInfo(error));
      return true;
    }

    const outputs = children.flatMap(
      (child) => (child.result?.artifacts ?? []) as ArtifactRef[],
    );
    outputs.push({
      name: 'fanout',
      kind: 'json',
      schema: 'hive/fanout',
      data: {
        items: items.length,
        tasks: children.map((child) => child.id),
        maxConcurrency: specNode.maxConcurrency ?? 4,
      },
    });
    this.bus.dispatch({
      type: 'node.produced',
      ...this.ctx(task.id, run.id, node),
      outputs,
      usage: {
        usd: children.reduce(
          (sum, child) => sum + (child.result?.usage?.usd ?? 0),
          0,
        ),
      },
    });
    const fresh = this.options.store.getNodeRun(node.id);
    if (fresh) await this.finishVerification(task, run, specNode, fresh, worktree);
    return true;
  }

  private async startDelegate(
    task: TaskRow,
    specNode: DelegateNode,
    node: NodeRunRow,
  ): Promise<boolean> {
    this.assertDelegation(task, specNode.agent);

    const children = this.options.store
      .listChildTasks(task.id)
      .filter((child) => child.originNodeRunId === node.id);
    let active = false;
    for (const child of children) {
      if (!['failed', 'cancelled'].includes(child.status)) {
        active = true;
        break;
      }
    }
    if (active) return false;

    this.bus.dispatch({
      type: 'task.create',
      taskId: this.options.ids.task(),
      assignee: specNode.agent,
      caller: task.assignee as AgentId,
      parentTaskId: task.id as TaskId,
      originNodeRunId: node.id as NodeRunId,
      repoPath: task.repoPath ?? undefined,
      title: specNode.description,
      brief: specNode.brief,
      inputs: [],
    });
    return true;
  }

  private async pollDelegate(
    task: TaskRow,
    run: RunRow,
    spec: WorkflowSpec,
    specNode: DelegateNode,
    node: NodeRunRow,
    worktree: string,
  ): Promise<boolean> {
    const children = this.options.store
      .listChildTasks(task.id)
      .filter((child) => child.originNodeRunId === node.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const child = children.at(-1);
    if (!child) return this.startDelegate(task, specNode, node);

    if (child.status === 'succeeded') {
      const earlier = this.earlierMergeState(task, spec, specNode, run);
      if (earlier === 'wait') return false;
      if (earlier === 'failed') {
        this.handleFailure(task, run, specNode, node, {
          code: 'E_DELEGATE_ORDER_BLOCKED',
          message: `前序委派失败，节点 ${specNode.id} 不再合并`,
        });
        return true;
      }

      try {
        await this.mergeDelegate(task, run, node, child, worktree);
      } catch (error) {
        this.handleFailure(task, run, specNode, node, toErrorInfo(error));
        return true;
      }

      const outputs = (child.result?.artifacts ?? []) as ArtifactRef[];
      this.bus.dispatch({
        type: 'node.produced',
        ...this.ctx(task.id, run.id, node),
        outputs,
        usage: child.result?.usage,
      });
      const fresh = this.options.store.getNodeRun(node.id);
      if (fresh) await this.finishVerification(task, run, specNode, fresh, worktree);
      return true;
    }

    if (child.status === 'failed' || child.status === 'cancelled') {
      this.handleFailure(task, run, specNode, node, {
        code: 'E_DELEGATE_FAILED',
        message: `子任务 ${child.id} ${child.status}`,
      });
      return true;
    }

    return false;
  }

  private async startSubworkflow(
    task: TaskRow,
    run: RunRow,
    specNode: SubworkflowNode,
    node: NodeRunRow,
  ): Promise<boolean> {
    const existing = this.options.store
      .listRuns(task.id)
      .find((childRun) => childRun.parentNodeRunId === node.id);
    if (existing) return false;

    if (this.runDepth(run) >= 3) {
      throw new AppError('E_SUBWORKFLOW_DEPTH', 'subworkflow 嵌套超过 3 层');
    }

    const childSpec = this.options.store.getSpecByRef(specNode.workflow);
    if (!childSpec) {
      throw new AppError('E_SUBWORKFLOW_NOT_FOUND', `找不到子流程：${specNode.workflow}`);
    }

    const specId = specHash(childSpec);
    this.options.store.saveSpec(specId, childSpec);
    this.bus.dispatch({
      type: 'run.start',
      runId: this.options.ids.run(),
      taskId: task.id as TaskId,
      specId,
      params: {},
      parentRunId: run.id as RunId,
      parentNodeRunId: node.id as NodeRunId,
    });
    return true;
  }

  private async pollSubworkflow(
    task: TaskRow,
    run: RunRow,
    specNode: SubworkflowNode,
    node: NodeRunRow,
    worktree: string,
  ): Promise<boolean> {
    const childRun = this.options.store
      .listRuns(task.id)
      .find((candidate) => candidate.parentNodeRunId === node.id);
    if (!childRun) return this.startSubworkflow(task, run, specNode, node);

    if (childRun.status === 'succeeded') {
      const outputs = this.options.store
        .listNodeRuns(childRun.id)
        .flatMap((inner) => (inner.outputs ?? []) as ArtifactRef[]);
      this.bus.dispatch({
        type: 'node.produced',
        ...this.ctx(task.id, run.id, node),
        outputs,
        usage: { usd: childRun.costUsd },
      });
      const fresh = this.options.store.getNodeRun(node.id);
      if (fresh) await this.finishVerification(task, run, specNode, fresh, worktree);
      return true;
    }

    if (childRun.status === 'failed' || childRun.status === 'cancelled') {
      this.handleFailure(task, run, specNode, node, {
        code: 'E_SUBWORKFLOW_FAILED',
        message: `子流程 ${childRun.id} ${childRun.status}`,
      });
      return true;
    }

    return false;
  }

  private runDepth(run: RunRow): number {
    let depth = 0;
    let current: RunRow | undefined = run;
    while (current?.parentRunId && depth < 10) {
      depth += 1;
      current = this.options.store.getRun(current.parentRunId);
    }
    return depth;
  }

  /* ---------------- completion ---------------- */

  private completeRun(task: TaskRow, run: RunRow, spec: WorkflowSpec): boolean {
    const freshRun = this.options.store.getRun(run.id);
    if (
      !freshRun ||
      ['cancelled', 'failed', 'succeeded'].includes(freshRun.status)
    ) {
      return false;
    }
    const freshTask = this.options.store.getTask(task.id);
    if (freshTask?.status === 'cancelled') return false;

    const nodes = this.options.store.listNodeRuns(run.id);
    if (nodes.length < spec.nodes.length) return false;
    if (!nodes.every((n) => (TERMINAL_NODE as readonly string[]).includes(n.status))) return false;

    const succeeded = nodes.filter((n) => n.status === 'succeeded');
    const costUsd = nodes.reduce((sum, n) => sum + n.costUsd, 0);
    const artifacts = nodes.flatMap((n) => ((n.outputs ?? []) as ArtifactRef[]));
    const ok = nodes.every((node) =>
      ['succeeded', 'skipped'].includes(node.status),
    );

    this.bus.dispatch({
      type: 'run.finish',
      runId: run.id as RunId,
      status: ok ? 'succeeded' : 'failed',
      costUsd,
    });

    // 子 run 只结束自己；任务由根 run 收口
    if (run.parentRunId) return true;

    const current = this.options.store.getTask(task.id);
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return true;

    if (ok) {
      this.bus.dispatch({
        type: 'task.finish',
        taskId: task.id as TaskId,
        result: {
          status: 'ok',
          summary: `${nodes.length} 个节点全部完成`,
          artifacts,
          usage: { usd: costUsd },
        },
      });
    } else {
      this.bus.dispatch({
        type: 'task.fail',
        taskId: task.id as TaskId,
        error: {
          code: 'E_NODE_FAILED',
          message: `${nodes.length - succeeded.length} 个节点失败`,
        },
        partial: { status: 'failed', summary: '部分节点失败', artifacts },
      });
    }
    return true;
  }

  private assertNodeAgent(task: TaskRow, specNode: LlmNode): void {
    if (!this.agents || !specNode.agent) return;

    const owner = this.agents.get(task.assignee);
    const target = this.agents.get(specNode.agent);
    if (!owner || !target) {
      throw new AppError(
        'E_AGENT_NOT_FOUND',
        `未知 agent：${!owner ? task.assignee : specNode.agent}`,
      );
    }
    if (specNode.agent === task.assignee) return;

    if (!this.isDescendant(task.assignee, specNode.agent)) {
      throw new AppError(
        'E_AGENT_ASSIGNMENT_FORBIDDEN',
        `${task.assignee} 不能把节点分配给 ${specNode.agent}`,
      );
    }
  }

  private isDescendant(ancestor: string, id: string): boolean {
    let current = this.agents?.get(id);
    while (current?.parent) {
      if (current.parent === ancestor) return true;
      current = this.agents?.get(current.parent);
    }
    return false;
  }

  private nodeAgent(task: TaskRow, specNode: NodeSpec): string {
    if (specNode.type === 'llm' && specNode.agent) return specNode.agent;
    return task.assignee;
  }

  private writeScopeFor(
    task: TaskRow,
    specNode: LlmNode | ShellNode | VerifyNode | ConditionNode | LoopNode,
  ): string[] {
    if (specNode.type !== 'llm') return ['.'];
    if (specNode.writeScope) return specNode.writeScope;
    const agent = this.agents?.get(this.nodeAgent(task, specNode));
    return agent?.workspace?.writeScope ?? ['.'];
  }

  private executionBudgetError(task: TaskRow): { code: string; message: string } | undefined {
    const taskBudget = this.options.maxUsdPerTask ?? 10;
    const spent = this.taskCost(task.id);
    if (spent >= taskBudget) {
      return {
        code: 'E_BUDGET_EXCEEDED',
        message: `任务成本 $${spent.toFixed(4)} 已达到上限 $${taskBudget.toFixed(2)}`,
      };
    }

    const rootTasks = this.options.store.listTasks(500).filter((entry) => !entry.parentId);
    const projectSpent = rootTasks.reduce(
      (sum, entry) => sum + this.taskCost(entry.id),
      0,
    );
    if (
      this.options.maxUsdPerProject !== undefined &&
      projectSpent >= this.options.maxUsdPerProject
    ) {
      return {
        code: 'E_PROJECT_BUDGET_EXCEEDED',
        message: `项目累计成本 $${projectSpent.toFixed(4)} 已达到上限 $${this.options.maxUsdPerProject.toFixed(2)}`,
      };
    }

    if (this.options.maxUsdPerDay !== undefined) {
      const day = new Date(this.options.clock.now());
      day.setHours(0, 0, 0, 0);
      const daySpent = rootTasks
        .filter((entry) => {
          const at = Date.parse(entry.finishedAt ?? entry.createdAt);
          return at >= day.getTime();
        })
        .reduce((sum, entry) => sum + this.taskCost(entry.id), 0);
      if (daySpent >= this.options.maxUsdPerDay) {
        return {
          code: 'E_DAY_BUDGET_EXCEEDED',
          message: `当日成本 $${daySpent.toFixed(4)} 已达到上限 $${this.options.maxUsdPerDay.toFixed(2)}`,
        };
      }
    }
    return undefined;
  }

  private taskCost(taskId: string): number {
    const plan = this.options.store.getTask(taskId)?.planCostUsd ?? 0;
    return (
      plan +
      this.options.store
        .listRuns(taskId)
        .flatMap((run) => this.options.store.listNodeRuns(run.id))
        .reduce((sum, node) => sum + node.costUsd, 0)
    );
  }

  private ctx(
    taskId: string,
    runId: string,
    node: Pick<NodeRunRow, 'id' | 'nodeId'>,
  ): { taskId: TaskId; runId: RunId; nodeRunId: NodeRunId; nodeId: NodeId } {
    return {
      taskId: taskId as TaskId,
      runId: runId as RunId,
      nodeRunId: node.id as NodeRunId,
      nodeId: node.nodeId as NodeId,
    };
  }
}

function durationToMs(value?: string): number | undefined {
  if (!value) return undefined;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+)(ms|s|m|h)/g)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += unit === 'ms' ? amount : unit === 's' ? amount * 1000 : unit === 'm' ? amount * 60_000 : amount * 3_600_000;
  }
  return matched ? total : undefined;
}

function readFanoutItems(worktree: string, itemsPath: string): unknown[] {
  const path = resolve(worktree, itemsPath);
  const rel = relative(resolve(worktree), path);
  if (!rel || rel.startsWith('..') || resolve(worktree, rel) !== path) {
    throw new AppError('E_FANOUT_INPUT', `fanout 清单必须位于 worktree 内：${itemsPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new AppError('E_FANOUT_INPUT', `无法读取 fanout JSON 清单：${itemsPath}`, {
      cause,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new AppError('E_FANOUT_INPUT', 'fanout 清单必须是 JSON 数组');
  }
  if (parsed.length > 1000) {
    throw new AppError('E_FANOUT_INPUT', 'fanout 单次最多 1000 项');
  }
  return parsed;
}

function renderFanoutBrief(template: string, item: unknown, index: number): string {
  const itemText = typeof item === 'string' ? item : JSON.stringify(item);
  let rendered = template
    .replaceAll('{{item}}', itemText)
    .replaceAll('{{index}}', String(index));
  if (isRecord(item)) {
    rendered = rendered.replace(/\{\{item\.([A-Za-z0-9_-]+)\}\}/g, (_, key: string) => {
      const value = item[key];
      return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    });
  }
  return rendered;
}

function fanoutItemTitle(item: unknown): string {
  if (typeof item === 'string') return item.slice(0, 80);
  if (isRecord(item) && typeof item.title === 'string') return item.title.slice(0, 80);
  return JSON.stringify(item).slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    const abort = () => {
      clearTimeout(timer);
      rejectDelay(new AppError('E_ABORTED', '节点已取消'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

