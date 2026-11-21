/**
 * 组合根：把 store、engine、适配器装成一个可用的 runtime。
 *
 * 这是唯一允许 import 具体适配器的地方。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, WorkflowSpec } from '@spec-agent/schema';
import {
  Engine,
  GitCli,
  ShellCli,
  Store,
  type AgentRuntime,
  type Planner,
  type ProviderConfig,
  type MemoryProvider,
} from '@spec-agent/core';
import { AppError, createIdFactory, createSystemClock, type IdFactory } from '@spec-agent/kernel';
import { loadSpecFile } from './spec.js';
import { createAgentConflictResolver } from './conflict-resolver.js';
import { loadAgents } from './agents.js';
import { loadSpecAgentSettings, type SpecAgentSettings } from './settings.js';
import { resolveProjectSkills } from './skills.js';
import { createKnowledgeIndex } from './knowledge.js';
import { createMemoryProvider, MemoryOutboxWorker } from './memory.js';
import { migrateLegacyProjectData, specAgentDataPath, SPEC_AGENT_DB_FILE } from './data-migration.js';

export type CreateRuntimeOptions = {
  /** 项目根目录，下面会有 .spec-agent/、repo/、worktrees/ */
  root: string;
  /** MemoryProvider 的 team 隔离 ID */
  projectId?: string;
  specPath?: string;
  /** 静态规划：按 assignee 选 spec；缺省回落到 defaultSpec */
  plans?: Record<string, WorkflowSpec>;
  defaultSpec?: WorkflowSpec;
  agentRuntime?: AgentRuntime;
  provider?: ProviderConfig;
  /** 可选 provider 注册表，用于模型能力路由 */
  providers?: ProviderConfig[];
  model?: string;
  workspaceRoot?: string;
  /** 显式仓库路径；缺省 <root>/repo，可指向现有仓库 */
  repoPath?: string;
  /** 合并冲突时是否让 agent 自动解决；默认 false */
  resolveConflicts?: boolean;
  /** 单任务成本上限，默认取项目 settings */
  maxUsdPerTask?: number;
  /** 显式项目设置；缺省从 .spec-agent/settings.json 加载 */
  settings?: SpecAgentSettings;
  /** 显式组织配置；缺省从 .spec-agent/agents.yaml 加载 */
  agents?: AgentConfig[];
  /** 任务终态后删除 worktree（分支保留） */
  cleanupWorktrees?: boolean;
  /** 同一个父任务同时最多跑几个子任务，默认 4 */
  maxConcurrentChildren?: number;
  /** 根任务的 llm 节点也各开子任务/worktree；默认读 SPEC_AGENT_ISOLATE_NODES */
  isolateNodes?: boolean;
  /** 冲突时最多合并几次，默认 2 */
  mergeAttempts?: number;
  /** 两次合并之间的等待，默认 250ms */
  mergeRetryDelayMs?: number;
  /** 长期记忆摘要读取；由组合根注入，engine 不直接依赖存储实现 */
  memory?: MemoryProvider;
  /** Tencent Memory 的凭证只从环境/启动配置传入，不落项目文件 */
  memoryApiKey?: string;
  memoryContext?: (agentId: string, task: string) => string[] | Promise<string[]>;
};

export type SpecAgentRuntime = {
  store: Store;
  engine: Engine;
  ids: IdFactory;
  settings: SpecAgentSettings;
  memory: MemoryProvider;
  memoryOutbox?: MemoryOutboxWorker;
  spec?: WorkflowSpec;
  readonly agents?: AgentConfig[];
  /** 保存新组织配置后热加载到 engine；新任务立即生效 */
  reloadAgents(agents: AgentConfig[]): void;
  /** 供应商/默认模型热更新 */
  setProvider(provider: ProviderConfig): void;
  setModel(model: string): void;
  /** 把崩溃遗留的 running 节点退回 ready 并继续跑；返回修复数量 */
  recover(): Promise<number>;
  /** 优雅停机：停止调度并 abort 外部调用 */
  shutdown(): void;
  close(): void;
};

const unavailableRuntime: AgentRuntime = {
  id: 'unavailable',
  async run() {
    throw new AppError(
      'E_AGENT_UNAVAILABLE',
      '没有配置 AgentRuntime：当前只能执行不含 llm 节点的工作流',
    );
  },
};

export function createRuntime(options: CreateRuntimeOptions): SpecAgentRuntime {
  const root = options.root;
  migrateLegacyProjectData(root);
  const dataDir = specAgentDataPath(root);
  mkdirSync(dataDir, { recursive: true });
  const store = new Store({ path: join(dataDir, SPEC_AGENT_DB_FILE) });
  const settings = options.settings ?? loadSpecAgentSettings(root);
  const worktreeRoot = join(root, 'worktrees');
  mkdirSync(worktreeRoot, { recursive: true });

  const spec = options.specPath ? loadSpecFile(options.specPath) : options.defaultSpec;
  const plans = options.plans ?? {};
  let agents = options.agents ?? loadAgents(root);
  const clock = createSystemClock();
  const ids = createIdFactory({ clock });

  const planner: Planner = {
    async plan(task) {
      const boundId = store.getSpecIdForTask(task.id);
      if (boundId) {
        const bound = store.getSpec(boundId);
        if (bound) return { spec: bound };
      }
      const chosen = plans[task.assignee] ?? spec;
      if (!chosen) throw new AppError('E_SPEC_REQUIRED', '没有提供 spec');
      return { spec: chosen };
    },
  };

  const repoPath = options.repoPath ?? join(root, 'repo');
  const knowledge = createKnowledgeIndex(repoPath);
  const agentRuntime = options.agentRuntime ?? unavailableRuntime;
  const provider = options.provider ?? { id: 'none' };
  const model = options.model ?? 'none';
  const projectId = options.projectId ?? 'local';
  const memoryConfig = settings.capabilities.memory;
  const memoryApiKey =
    options.memoryApiKey ?? process.env.SPEC_AGENT_MEMORY_API_KEY;
  const memory = options.memory ?? createMemoryProvider({
    store,
    projectId,
    remote: memoryConfig.provider === 'tencent' && memoryConfig.baseUrl
      ? {
          baseUrl: memoryConfig.baseUrl,
          serviceId: memoryConfig.serviceId || 'spec-agent',
          userId: memoryConfig.userId || 'local-user',
          apiKey: memoryApiKey,
        }
      : undefined,
    hy: memoryConfig.provider === 'hy-memory' && memoryConfig.baseUrl
      ? {
          baseUrl: memoryConfig.baseUrl,
          userId: memoryConfig.userId || 'local-user',
          workspaceId: memoryConfig.workspaceId || projectId,
          branch: memoryConfig.branch || 'main',
          apiKey: memoryApiKey,
        }
      : undefined,
  });
  const memoryOutbox =
    memory.kind === 'local'
      ? undefined
      : new MemoryOutboxWorker(store, memory, projectId);
  memoryOutbox?.start();

  const conflictResolver = options.resolveConflicts
    ? createAgentConflictResolver({ runtime: agentRuntime, provider, model })
    : undefined;

  const engine = new Engine({
    store,
    planner,
    runtime: agentRuntime,
    shell: new ShellCli(),
    clock,
    ids,
    provider,
    providers: options.providers,
    model,
    workspaceRoot: options.workspaceRoot ?? repoPath,
    git: new GitCli(),
    repoPath,
    worktreeRoot,
    conflictResolver,
    maxUsdPerTask: options.maxUsdPerTask ?? settings.execution.maxUsdPerTask,
    maxUsdPerNode: settings.execution.maxUsdPerNode,
    maxTurns: settings.execution.maxTurns,
    executionMode: 'session',
    qaAgent: settings.execution.qaAgent,
    agents,
    cleanupWorktrees: options.cleanupWorktrees,
    maxConcurrentChildren:
      options.maxConcurrentChildren ?? settings.execution.maxConcurrentChildren,
    maxConcurrentTasks: settings.execution.maxConcurrentTasks,
    maxUsdPerProject: settings.execution.maxUsdPerProject,
    maxUsdPerDay: settings.execution.maxUsdPerDay,
    isolateNodes:
      options.isolateNodes ??
      (process.env.SPEC_AGENT_ISOLATE_NODES === '1' ? true : false),
    mergeAttempts: options.mergeAttempts,
    mergeRetryDelayMs: options.mergeRetryDelayMs,
    memoryContext: options.memoryContext ?? (async (agentId, task) => {
      const result = await memory.retrieve({ projectId, agentId, query: task });
      return result.memories;
    }),
    onNodeOutcome:
      memory.kind === 'local'
        ? undefined
        : (outcome) => {
            store.enqueueMemoryOutbox({
              projectId,
              taskId: outcome.taskId,
              nodeRunId: outcome.nodeRunId,
              kind: 'node_outcome',
              payload: JSON.stringify(outcome),
            });
          },
    knowledgeContext: (task) => knowledge.search(task),
    resolveSkills: (ids) => resolveProjectSkills(root, ids),
    mcpServers: settings.capabilities.mcpServers,
  });

  return {
    store,
    engine,
    ids,
    settings,
    memory,
    memoryOutbox,
    spec,
    get agents() {
      return agents;
    },
    reloadAgents(next) {
      agents = next;
      engine.setAgents(next);
    },
    setProvider(next) {
      engine.setProvider(next);
    },
    setModel(next) {
      engine.setModel(next);
    },
    async recover() {
      const fixed = engine.recover();
      if (fixed > 0) await engine.runUntilIdle();
      return fixed;
    },
    shutdown: () => engine.shutdown(),
    close: () => {
      memoryOutbox?.stop();
      engine.shutdown();
      store.close();
    },
  };
}
