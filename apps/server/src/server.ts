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
import { ChatRepository, type ChatMode, type ChatPermissionMode } from './chat/chat-store.js';
import { ChatService, type ChatTaskCreator, type PlannedTask } from './chat/chat.js';
import { DshChatEngine, type ChatEngine } from './dsh/dsh-chat.js';
import { ProjectPlanService } from './chat/project-plans.js';
import type { ProjectPlanDetail } from './chat/project-plans.js';
import { WorkStore, type WorkItemState } from './work/work-store.js';
import { WorkService } from './work/work-service.js';
import { WorkExecutor } from './work/work-executor.js';
import { WorkTriage } from './work/work-triage.js';
import { ContextAssembler } from './infra/context-assembler.js';
import { WorkMemoryStore, WorkMemoryWriter } from './work/work-memory.js';
import { PrivateAssistant } from './assistant/private-assistant.js';
import { WorkPlanner } from './work/work-planner.js';
import {
  OutboxWorker,
  createOutboxTransport,
} from './work/outbox-worker.js';
import { api } from './http/task-routes.js';
import { createTaskForGoal, executePlannedTask, planTaskForGoal } from './http/task-plans.js';
import { normalizeGitHubPayload } from './integrations/github-source.js';
import { createEmbeddingProvider } from './infra/embeddings.js';
import { MemoryJanitor } from './work/memory-janitor.js';
import { diffLines } from './infra/line-diff.js';
import {
  sourceSecret,
  verifySourceSignature,
} from './integrations/source-signature.js';
import { AppError } from '@spec-agent/kernel';
import {
  createNotificationService,
  type NotificationOptions,
} from './integrations/notifications.js';
import { handleLlmProxy } from './infra/llm-proxy.js';
import {
  formatChecks,
  preflightRoot,
  validateServerConfig,
  type PreflightResult,
} from './infra/preflight.js';
type ProviderRuntime = {
  get(includeSecrets?: boolean): ProviderSettings;
  update(input: Record<string, unknown>): Promise<ProviderSettings>;
  list(): ProviderConfig[];
  defaultProvider(): ProviderConfig;
};

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
} from './infra/provider-config.js';
import {
  collectProjectMetrics,
  createHttpMetrics,
  recordHttp,
  renderPrometheus,
  type HttpMetrics,
} from './infra/metrics.js';

export { SmtpMailer, parseSmtpUrl } from './integrations/smtp.js';
export type { ImportedFile } from './http/io.js';
import { json, readJson, readRawBody, serveStatic, applySecurityHeaders, cors, nativePickFolder, readMultipart, safeImportPath, writeImportedFiles } from './http/io.js';
import type { ImportedFile } from './http/io.js';
export type { ProjectConfig } from './projects/types.js';
import { assertProjects, loadProjectsFile, projectErrorStatus, saveProjectsFile } from './projects/registry.js';
import type { ProjectConfig } from './projects/types.js';

export type ServerOptions = {
  /** 单项目模式；与 projects 二选一 */
  root?: string;
  projects?: ProjectConfig[];
  /** 设置后所有 /api（health 除外）都要 Bearer token */
  token?: string;
  port?: number;
  host?: string;
  /** 构建后的前端目录；不传则只提供 API */
  webDist?: string;
  /** 规划与 llm 节点共用；不传则只能查看/审批已有任务 */
  agentRuntime?: AgentRuntime;
  provider?: ProviderConfig;
  /** 额外 provider 注册表，用于模型能力路由 */
  providers?: ProviderConfig[];
  model?: string;
  maxUsdPerTask?: number;
  agents?: AgentConfig[];
  cleanupWorktrees?: boolean;
  maxConcurrentChildren?: number;
  isolateNodes?: boolean;
  /** 项目注册表 JSON；设置后才能创建/归档项目 */
  projectsFile?: string;
  /** 新建项目未指定 root 时的父目录 */
  projectsHome?: string;
  /** 审批通知；不传则关闭 */
  notifications?: NotificationOptions;
  mergeAttempts?: number;
  mergeRetryDelayMs?: number;
  /** 合并冲突时让 agent 自动解决 */
  resolveConflicts?: boolean;
  /** 优雅关闭时等待在途请求的毫秒数；默认 5000 */
  shutdownTimeoutMs?: number;
  /** 仅测试用：覆盖系统文件夹选择器 */
  folderPicker?: () => Promise<string | null>;
  /** provider 配置文件；默认 ~/.spec-agent/provider.json，可用 SPEC_AGENT_PROVIDER_FILE 覆盖 */
  providerFile?: string;
  /** 测试或自定义宿主可替换 DSH chat engine */
  chatEngine?: ChatEngine;
  /** 是否在任务结束后自动提取记忆；默认 true */
  autoMemory?: boolean;
};

export type RunningServer = {
  port: number;
  url: string;
  close(): Promise<void>;
};


type ProjectContext = {
  config: ProjectConfig;
  runtime: SpecAgentRuntime;
  repo: string;
  planner: {
    agentRuntime?: AgentRuntime;
    provider: ProviderConfig;
    model: string;
    limits?: PlannerLimits;
  };
  chat: ChatService;
  work: WorkService;
  workMemory: WorkMemoryStore;
  workExecutor?: WorkExecutor;
  workTriage?: WorkTriage;
  privateAssistant?: PrivateAssistant;
  workPlanner?: WorkPlanner;
  outboxWorker?: OutboxWorker;
  memoryJanitor?: MemoryJanitor;
  plans?: ProjectPlanService;
  preflight?: PreflightResult;
};

type ProjectManager = {
  manageable: boolean;
  list(): ProjectConfig[];
  defaultId(): string;
  create(input: Record<string, unknown>): Promise<ProjectConfig>;
  importFolder(input: {
    name: string;
    files: Array<{ path: string; data: Buffer }>;
  }): Promise<ProjectConfig>;
  archive(id: string, force: boolean): Promise<void>;
};


const GIT = new GitCli();

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  validateServerConfig(options);

  const providerFile = resolve(
    options.providerFile ?? defaultProviderFile(),
  );
  const storedProvider = loadProviderFile(providerFile);
  const environmentProvider = providerFromEnvironment();
  const storedSameProvider = storedProvider?.providers?.find(
    (entry) => entry.id === (options.provider?.id ?? 'anthropic'),
  );
  let provider: ProviderConfig = {
    id: options.provider?.id ?? 'anthropic',
    name: options.provider?.name ?? storedSameProvider?.name,
    protocol: options.provider?.protocol ?? storedSameProvider?.protocol ?? 'anthropic',
    baseUrl:
      storedSameProvider?.baseUrl ??
      storedProvider?.baseUrl ??
      options.provider?.baseUrl ??
      environmentProvider.baseUrl,
    authToken:
      storedSameProvider?.authToken ??
      storedProvider?.authToken ??
      options.provider?.authToken ??
      environmentProvider.authToken,
    modelAliases:
      storedSameProvider?.modelAliases ?? storedProvider?.modelAliases ?? options.provider?.modelAliases,
    models: options.provider?.models ?? storedSameProvider?.models,
  };
  const providers = Array.from(
    new Map(
      [...(options.providers ?? []), ...(storedProvider?.providers ?? []), provider]
        .map((entry) => [entry.id, entry]),
    ).values(),
  );
  let defaultProviderId = storedProvider?.defaultProviderId ?? provider.id;
  provider = providers.find((entry) => entry.id === defaultProviderId) ?? provider;
  defaultProviderId = provider.id;
  let defaultModel =
    storedProvider?.model ??
    options.model ??
    'claude-sonnet-4-5';
  const explicitModel = storedProvider?.model ?? options.model;
  if (!explicitModel && !provider.models?.[defaultModel]) {
    defaultModel = Object.keys(provider.models ?? {})[0] ?? defaultModel;
  }
  let availableModels = Array.from(
    new Set(
      [...(storedProvider?.models ?? []), ...Object.keys(provider.models ?? {}), defaultModel]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  provider.models = Object.fromEntries(
    availableModels.map((model) => [model, provider.models?.[model] ?? {}]),
  );

  const saveProvider = async (): Promise<void> => {
    const data: ProviderFileData = {
      version: 2,
      defaultProviderId,
      baseUrl: provider.baseUrl,
      authToken: provider.authToken,
      model: defaultModel,
      models: availableModels,
      modelAliases: provider.modelAliases,
      providers,
    };
    saveProviderFile(providerFile, data);
  };

  const providerRuntime: ProviderRuntime = {
    get: (includeSecrets = false) =>
      publicProviderSettings(
        provider,
        defaultModel,
        availableModels,
        providerFile,
        providers,
        defaultProviderId,
        includeSecrets,
      ),
    list: () => providers,
    defaultProvider: () => provider,
    update: async (input) => {
      if (Array.isArray(input.providers)) {
        const validated = validateProviderRegistryInput(input, providers);
        providers.splice(0, providers.length, ...validated.providers);
        defaultProviderId = validated.defaultProviderId;
        defaultModel = validated.model;
        provider = providers.find((entry) => entry.id === defaultProviderId)!;
        availableModels = Object.keys(provider.models ?? {});
      } else {
        const validated = validateProviderInput(input);
        if (validated.baseUrl !== undefined) provider.baseUrl = validated.baseUrl || undefined;
        if (typeof input.authToken === 'string' && input.authToken.trim()) {
          provider.authToken = input.authToken.trim();
        }
        if (input.clearToken === true) provider.authToken = '';
        if (validated.models !== undefined) {
          availableModels = validated.models;
          provider.models = Object.fromEntries(
        availableModels.map((model) => [model, provider.models?.[model] ?? {}]),
      );
        }
        if (validated.model !== undefined) defaultModel = validated.model;
        if (typeof input.defaultProviderId === 'string' && input.defaultProviderId !== provider.id) {
          const selected = providers.find((entry) => entry.id === input.defaultProviderId);
          if (!selected) throw new AppError('E_PROVIDER_INVALID', '默认供应商不存在');
          provider = selected;
          defaultProviderId = selected.id;
          availableModels = Object.keys(selected.models ?? {});
        }
      }
      if (!availableModels.includes(defaultModel)) {
        availableModels = [defaultModel, ...availableModels];
      }
      provider.models = Object.fromEntries(
        availableModels.map((model) => [model, provider.models?.[model] ?? {}]),
      );
      for (const context of contexts.values()) {
        context.planner.provider = provider;
        context.planner.model = defaultModel;
        context.runtime.setProvider(provider);
        context.runtime.setModel(defaultModel);
      }
      await saveProvider();
      return providerRuntime.get();
    },
  };

  const projectsFile = options.projectsFile
    ? resolve(options.projectsFile)
    : undefined;
  const projectsHome = resolve(
    options.projectsHome ?? join(homedir(), 'SpecAgentProjects'),
  );

  const initialConfigs: ProjectConfig[] = options.projects?.length
    ? options.projects
    : options.root
      ? [{ id: 'default', name: '默认组织', root: options.root }]
      : [];

  const loaded = projectsFile ? loadProjectsFile(projectsFile) : null;
  if (!loaded && initialConfigs.length === 0 && !projectsFile) {
    throw new Error('startServer 需要 root、projects 或 projectsFile');
  }

  let configs = (loaded ?? initialConfigs).map((config) => ({
    ...config,
    root: resolve(config.root),
  }));
  if (projectsFile && !loaded) {
    saveProjectsFile(projectsFile, configs);
  }
  assertProjects(configs);

  const contexts = new Map<string, ProjectContext>();
  const httpMetrics = createHttpMetrics();
  const sharedAgents =
    options.projects?.length || projectsFile ? undefined : options.agents;

  const addContext = (config: ProjectConfig): ProjectContext => {
    if (
      (projectsFile || options.projects?.length) &&
      !existsSync(agentsPath(config.root))
    ) {
      mkdirSync(join(config.root, '.spec-agent'), { recursive: true });
      saveAgents(config.root, [
        {
          id: 'assistant' as AgentConfig['id'],
          name: '助理',
          parent: null,
          role: '项目助理：回答问题、整理需求、协助拆解任务',
          systemPrompt:
            '你是这个组织的项目助理。优先澄清目标、范围和验收标准；需要执行时建议切换到任务模式。',
          model: { provider: 'inherit', model: 'inherit' },
          skills: [],
          nodes: [],
          tools: { allow: ['Read'], shell: 'readonly' },
          canDelegateTo: [],
          workspace: { writeScope: ['.'] },
        },
      ]);
    }
    const runtime = createRuntime({
      root: config.root,
      projectId: config.id,
      repoPath: config.repoPath,
      agentRuntime: options.agentRuntime,
      provider,
      providers,
      model: defaultModel,
      maxUsdPerTask: options.maxUsdPerTask,
      // 多项目时每个项目自己从 .spec-agent/agents.yaml 加载
      agents: sharedAgents,
      cleanupWorktrees: options.cleanupWorktrees,
      maxConcurrentChildren: options.maxConcurrentChildren,
      isolateNodes: options.isolateNodes,
      mergeAttempts: options.mergeAttempts,
      mergeRetryDelayMs: options.mergeRetryDelayMs,
      resolveConflicts: options.resolveConflicts,
    });
    const planner = {
      agentRuntime: options.agentRuntime,
      provider,
      model: defaultModel,
      limits: runtime.settings.planner,
    };
    const chatRepo = new ChatRepository(runtime.store.db, runtime.store.clock);
    const chatEngine =
      options.chatEngine ??
      new DshChatEngine({
        provider: (providerId) =>
          providers.find((entry) => entry.id === providerId) ?? provider,
        model: () => defaultModel,
      });
    let context!: ProjectContext;
    let plans!: ProjectPlanService;
    const createTaskFromChat: ChatTaskCreator = async (
      goal,
      assignee,
      repoPath,
    ) => {
      const result = await createTaskForGoal(
        runtime,
        planner,
        goal,
        assignee,
        repoPath,
      );
      return { taskId: result.task.id, title: result.task.title };
    };
    const chat = new ChatService({
      root: config.root,
      projectName: config.name,
      projectId: config.id,
      memory: runtime.memory,
      store: runtime.store,
      repo: chatRepo,
      engine: chatEngine,
      agentRuntime: options.agentRuntime,
      provider,
      agents: () => runtime.agents ?? [],
      createTask: createTaskFromChat,
      planTask: (goal, assignee, repoPath) =>
        planTaskForGoal(runtime, planner, goal, assignee, repoPath),
      confirmTask: async (plan) => {
        const result = await executePlannedTask(runtime, plan);
        return { taskId: result.task.id, title: result.task.title };
      },
      reloadAgents: (next) => runtime.reloadAgents(next),
      autoMemory: options.autoMemory !== false,
      model: () => defaultModel,
      providers: () => providers,
      defaultRoute: () => ({ providerId: defaultProviderId, model: defaultModel }),
      maxWorkstreams: runtime.settings.planner.maxWorkstreams,
      createProjectPlan: async (draft, context) => {
        const detail = plans.createFromDraft({
          ...draft,
          ...(context?.projectId ? { projectId: context.projectId } : {}),
          ...(context?.repoPath ? { repoPath: context.repoPath } : {}),
        });
        return { id: detail.plan.id };
      },
    });
    plans = new ProjectPlanService({
      root: config.root,
      repoPath: config.repoPath ?? join(config.root, 'repo'),
      store: runtime.store,
      git: new GitCli(),
      shell: new ShellCli(),
      planner,
      agents: () => runtime.agents ?? [],
      createTask: async (goal, assignee, repoPath) => {
        const result = await createTaskForGoal(
          runtime,
          planner,
          goal,
          assignee,
          repoPath,
        );
        return { task: result.task };
      },
      cancelTask: async (taskId, reason) => {
        runtime.engine.cancelTask(taskId as never, reason);
      },
      maxWorkstreams: runtime.settings.planner.maxWorkstreams,
    });
    const work = new WorkService(
      new WorkStore(runtime.store.db, runtime.store.clock),
    );
    const workMemory = new WorkMemoryStore(
      runtime.store.db,
      runtime.store.clock,
      { embeddingProvider: createEmbeddingProvider() },
    );
    const workMemoryWriter = new WorkMemoryWriter(workMemory);
    const memoryJanitor = new MemoryJanitor({
      memories: workMemory,
      work,
      intervalMs: Number(process.env.SPEC_AGENT_MEMORY_JANITOR_MS ?? 3_600_000),
      vectorDays: Number(process.env.SPEC_AGENT_VECTOR_CLEANUP_DAYS ?? 30),
      versionDays: Number(process.env.SPEC_AGENT_MEMORY_VERSION_DAYS ?? 90),
      keepVersions: Number(process.env.SPEC_AGENT_MEMORY_VERSIONS_KEEP ?? 10),
      outboxAuditDays: Number(process.env.SPEC_AGENT_OUTBOX_AUDIT_DAYS ?? 180),
      runOnStart: true,
    });
    memoryJanitor.start();
    const outboxTransport = createOutboxTransport();
    const outboxWorker = outboxTransport
      ? new OutboxWorker({ work, transport: outboxTransport })
      : undefined;
    outboxWorker?.start();
    const workExecutor = planner.agentRuntime
      ? new WorkExecutor({
          work,
          runtime: planner.agentRuntime,
          provider: planner.provider,
          model: planner.model,
          cwd: config.repoPath ?? join(config.root, 'repo'),
          resolveAgent: (agentId) =>
            runtime.agents?.find((agent) => agent.id === agentId),
          assembler: new ContextAssembler({
            work,
            store: runtime.store,
            projectId: config.id,
            memories: workMemory,
          }),
          memoryWriter: workMemoryWriter,
        })
      : undefined;
    const recovered = work.recoverRunning();
    if (workExecutor) {
      for (const workItemId of recovered.workItemIds) {
        workExecutor.startReady(workItemId);
      }
    }
    if (recovered.count > 0) {
      console.info(
        `[work-recovery] ${config.id}: requeued ${recovered.count} running assignments`,
      );
    }
    const workTriage = planner.agentRuntime
      ? new WorkTriage({
          work,
          runtime: planner.agentRuntime,
          provider: planner.provider,
          model: planner.model,
          cwd:
            config.repoPath && existsSync(config.repoPath)
              ? config.repoPath
              : config.root,
          root: config.root,
          resolveAgent: (agentId) =>
            runtime.agents?.find((agent) => agent.id === agentId),
          listAgents: () =>
            (runtime.agents ?? []).map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
            })),
        })
      : undefined;
    const privateAssistant = planner.agentRuntime
      ? new PrivateAssistant({
          work,
          runtime: planner.agentRuntime,
          chatEngine,
          root: config.root,
          provider: planner.provider,
          model: planner.model,
          cwd: config.repoPath ?? join(config.root, 'repo'),
          resolveAgent: (agentId) =>
            runtime.agents?.find((agent) => agent.id === agentId),
          memories: workMemory,
        })
      : undefined;
    const workPlanner = planner.agentRuntime
      ? new WorkPlanner({
          work,
          runtime: planner.agentRuntime,
          provider: planner.provider,
          model: planner.model,
          cwd: config.repoPath ?? join(config.root, 'repo'),
          listAgents: () =>
            (runtime.agents ?? []).map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
            })),
        })
      : undefined;
    context = {
      config,
      runtime,
      repo: config.repoPath ?? join(config.root, 'repo'),
      planner,
      chat,
      work,
      workMemory,
      workExecutor,
      workTriage,
      privateAssistant,
      workPlanner,
      outboxWorker,
      memoryJanitor,
      plans,
    };

    const preflight = preflightRoot(config.root, {
      repoPath: config.repoPath,
      webDist: options.webDist ? resolve(options.webDist) : undefined,
      hasToken: Boolean(options.token),
    });
    if (!preflight.ok) {
      disposeContext(context);
      throw new AppError(
        'E_PREFLIGHT',
        `项目 ${config.id} 启动自检失败：\n${formatChecks(preflight)}`,
      );
    }
    if (formatChecks(preflight)) {
      console.warn(`preflight (${config.id}):\n${formatChecks(preflight)}`);
    }
    context.preflight = preflight;

    contexts.set(config.id, context);

    void runtime.recover().catch((error: unknown) => {
      console.error(
        `recover failed (${config.id}):`,
        error instanceof Error ? error.message : error,
      );
    });
    return context;
  };

  const disposeContext = (context: ProjectContext): void => {
    // ChatService 与 Store 共用 SQLite；先停定时器，再关库。
    void context.chat.close().catch((error: unknown) => {
      console.warn(
        `chat close failed (${context.config.id}):`,
        error instanceof Error ? error.message : error,
      );
    });
    context.plans?.close();
    context.outboxWorker?.stop();
    context.memoryJanitor?.stop();
    context.runtime.close();
  };

  try {
    for (const config of configs) addContext(config);
  } catch (error) {
    for (const context of contexts.values()) disposeContext(context);
    throw error;
  }

  let projectLock: Promise<unknown> = Promise.resolve();
  const withProjectLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = projectLock.then(fn, fn);
    projectLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const manager: ProjectManager = {
    manageable: Boolean(projectsFile),
    list: () => configs.map((config) => ({ ...config })),
    defaultId: () => configs[0]?.id ?? '',
    create: (input) =>
      withProjectLock(async () => {
        if (!projectsFile) {
          throw new AppError(
            'E_PROJECTS_READONLY',
            '项目由 SPEC_AGENT_PROJECTS 静态配置，设置 SPEC_AGENT_PROJECTS_FILE 后才能创建',
          );
        }

        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > 80) {
          throw new AppError('E_PROJECT_INVALID', '项目名必填，且最多 80 字');
        }

        const requestedId =
          typeof input.id === 'string' ? input.id.trim() : '';
        const id =
          requestedId ||
          `p-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(id)) {
          throw new AppError(
            'E_PROJECT_INVALID',
            '项目 id 只能是小写字母开头，包含小写字母、数字、短横线',
          );
        }
        if (configs.some((config) => config.id === id)) {
          throw new AppError('E_PROJECT_EXISTS', `项目 id 已存在：${id}`);
        }

        let root: string;
        if (typeof input.root === 'string' && input.root.trim()) {
          if (!isAbsolute(input.root.trim())) {
            throw new AppError('E_PROJECT_INVALID', '项目 root 必须是绝对路径');
          }
          root = resolve(input.root.trim());
        } else {
          root = join(projectsHome, id);
        }

        if (
          configs.some(
            (config) => config.root.toLowerCase() === root.toLowerCase(),
          )
        ) {
          throw new AppError('E_PROJECT_EXISTS', `项目目录已注册：${root}`);
        }
        if (existsSync(root) && !statSync(root).isDirectory()) {
          throw new AppError('E_PROJECT_INVALID', `项目 root 不是目录：${root}`);
        }

        mkdirSync(root, { recursive: true });
        const repoPath = existsSync(join(root, '.git'))
          ? root
          : join(root, 'repo');
        if (repoPath !== root) await GIT.initRepo(repoPath);

        const config: ProjectConfig = { id, name, root, repoPath };
        try {
          addContext(config);
          configs.push(config);
          saveProjectsFile(projectsFile, configs);
        } catch (error) {
          const context = contexts.get(id);
          contexts.delete(id);
          if (context) disposeContext(context);
          configs = configs.filter((candidate) => candidate.id !== id);
          throw error;
        }
        return config;
      }),

    importFolder: (input) =>
      withProjectLock(async () => {
        if (!projectsFile) {
          throw new AppError(
            'E_PROJECTS_READONLY',
            '项目由 SPEC_AGENT_PROJECTS 静态配置，设置 SPEC_AGENT_PROJECTS_FILE 后才能创建',
          );
        }

        const name = input.name.trim();
        if (!name || name.length > 80) {
          throw new AppError('E_PROJECT_INVALID', '项目名必填，且最多 80 字');
        }

        let id: string;
        do {
          id = `p-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
        } while (configs.some((candidate) => candidate.id === id));

        const root = join(projectsHome, id);
        if (existsSync(root)) {
          throw new AppError('E_PROJECT_EXISTS', `项目目录已存在：${root}`);
        }
        if (configs.some((candidate) => candidate.root.toLowerCase() === root.toLowerCase())) {
          throw new AppError('E_PROJECT_EXISTS', `项目目录已注册：${root}`);
        }

        const repo = join(root, 'repo');
        try {
          mkdirSync(repo, { recursive: true });
          writeImportedFiles(repo, input.files);
          await GIT.initRepo(repo);

          const config: ProjectConfig = { id, name, root };
          addContext(config);
          configs.push(config);
          saveProjectsFile(projectsFile, configs);
          return config;
        } catch (error) {
          const context = contexts.get(id);
          contexts.delete(id);
          if (context) disposeContext(context);
          configs = configs.filter((candidate) => candidate.id !== id);
          rmSync(root, { recursive: true, force: true });
          throw error;
        }
      }),

    archive: (id, force) =>
      withProjectLock(async () => {
        if (!projectsFile) {
          throw new AppError(
            'E_PROJECTS_READONLY',
            '项目由 SPEC_AGENT_PROJECTS 静态配置，设置 SPEC_AGENT_PROJECTS_FILE 后才能归档',
          );
        }
        const context = contexts.get(id);
        if (!context) {
          throw new AppError('E_PROJECT_NOT_FOUND', `项目不存在：${id}`);
        }
        if (configs.length <= 1) {
          throw new AppError('E_PROJECT_LAST', '至少保留一个项目');
        }

        const busy = context.runtime.store
          .listTasks(200)
          .filter(
            (task) =>
              !['succeeded', 'failed', 'cancelled'].includes(task.status),
          );
        if (busy.length > 0 && !force) {
          throw new AppError(
            'E_PROJECT_BUSY',
            `项目还有 ${busy.length} 个未结束任务；带 force=1 可强制归档`,
          );
        }

        const previous = configs;
        configs = configs.filter((config) => config.id !== id);
        try {
          saveProjectsFile(projectsFile, configs);
        } catch (error) {
          configs = previous;
          throw error;
        }

        contexts.delete(id);
        disposeContext(context);
      }),
  };

  const webDist = options.webDist ? resolve(options.webDist) : undefined;
  const folderPicker = options.folderPicker ?? nativePickFolder;

  const server = createServer((request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    response.once('finish', () => {
      const durationMs = Date.now() - started;
      recordHttp(httpMetrics, response.statusCode, durationMs);
      if (process.env.SPEC_AGENT_LOG_REQUESTS === '1') {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            requestId,
            method: request.method,
            path: (request.url ?? '/').split('?')[0],
            status: response.statusCode,
            durationMs,
          }),
        );
      }
    });

    handle(
      contexts,
      manager,
      options.token,
      webDist,
      request,
      response,
      httpMetrics,
      folderPicker,
      providerRuntime,
    ).catch((error: unknown) => {
      if (!response.headersSent) {
        const code = error instanceof AppError ? error.code : 'E_SERVER';
        const status =
          code === 'E_BODY_TOO_LARGE'
            ? 413
            : code === 'E_BAD_JSON'
              ? 400
              : 500;
        json(response, status, {
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } else {
        response.end();
      }
      if (process.env.SPEC_AGENT_LOG_REQUESTS === '1') {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  }).catch((error: unknown) => {
    for (const context of contexts.values()) disposeContext(context);
    throw error;
  });

  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const host = options.host ?? '127.0.0.1';
  const publicUrl =
    options.notifications?.publicUrl ?? `http://${host}:${port}`;

  const notifications = options.notifications
    ? createNotificationService({
        projects: () =>
          [...contexts.values()].map((context) => ({
            id: context.config.id,
            name: context.config.name,
            runtime: context.runtime,
          })),
        options: { ...options.notifications, publicUrl },
      })
    : undefined;
  notifications?.start();

  let closing: Promise<void> | undefined;
  const timeoutMs = options.shutdownTimeoutMs ?? 5_000;

  return {
    port,
    url: `http://${host}:${port}`,
    close: () => {      closing ??= (async () => {
        notifications?.stop();
        for (const context of contexts.values()) context.runtime.shutdown();
        await Promise.all(
          [...contexts.values()].map((context) =>
            context.chat.close().catch((error: unknown) => {
              console.error(
                `chat close failed (${context.config.id}):`,
                error instanceof Error ? error.message : error,
              );
            }),
          ),
        );
        const closable = options.agentRuntime as
          | (AgentRuntime & { close?: () => Promise<void> })
          | undefined;
        await closable?.close?.().catch((error: unknown) => {
          console.error(
            'agent runtime close failed:',
            error instanceof Error ? error.message : error,
          );
        });

        await new Promise<void>((resolveClose) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveClose();
          };
          const timer = setTimeout(() => {
            server.closeAllConnections();
            finish();
          }, timeoutMs);
          timer.unref();
          server.close(() => finish());
          server.closeIdleConnections();
        });

        for (const context of contexts.values()) {
      context.plans?.close();
      context.runtime.close();
    }
      })();
      return closing;
    },
  };
}

async function handle(
  contexts: Map<string, ProjectContext>,
  manager: ProjectManager,
  token: string | undefined,
  webDist: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  httpMetrics: HttpMetrics,
  folderPicker: () => Promise<string | null>,
  providerRuntime: ProviderRuntime,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  applySecurityHeaders(response, path);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors());
    response.end();
    return;
  }

  if (path === '/api/health') {
    json(response, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      projects: contexts.size,
    });
    return;
  }

  if (path === '/api/ready') {
    const checks = [...contexts.values()].map((context) => {
      try {
        context.runtime.store.events.lastSeq();
        context.runtime.store.listTasks(1);
        const preflight = context.preflight;
        return {
          id: context.config.id,
          ok: true,
          migration: context.runtime.store.migration.currentVersion,
          git:
            preflight?.checks.find((check) => check.name === 'repo')?.level ===
            'ok',
          warnings:
            preflight?.checks
              .filter((check) => check.level === 'warn')
              .map((check) => check.name) ?? [],
        };
      } catch (error) {
        return {
          id: context.config.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const ready = checks.every((check) => check.ok);
    json(response, ready ? 200 : 503, { ok: ready, projects: checks });
    return;
  }

  if (path.startsWith('/api/')) {
    response.setHeader('Access-Control-Allow-Origin', '*');

    if (!authorized(request, token)) {
      json(response, 401, {
        error: { code: 'E_UNAUTHORIZED', message: '需要 Bearer token' },
      });
      return;
    }
  }

  if (path.startsWith('/api/llm/')) {
    await handleLlmProxy(
      request,
      response,
      url,
      providerRuntime.list(),
      providerRuntime.defaultProvider().id,
    );
    return;
  }

  if (path === '/api/stats' && request.method === 'GET') {
    json(response, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      http: httpMetrics,
      projects: [...contexts.values()].map((context) =>
        collectProjectMetrics({
          id: context.config.id,
          name: context.config.name,
          store: context.runtime.store,
        }),
      ),
    });
    return;
  }

  if (path === '/api/metrics' && request.method === 'GET') {
    const projects = [...contexts.values()].map((context) =>
      collectProjectMetrics({
        id: context.config.id,
        name: context.config.name,
        store: context.runtime.store,
      }),
    );
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(renderPrometheus(projects, httpMetrics, process.uptime()));
    return;
  }

  if (path === '/api/provider' && request.method === 'GET') {
    json(response, 200, providerRuntime.get(url.searchParams.get('secrets') === '1'));
    return;
  }

  if (path === '/api/provider' && request.method === 'PUT') {
    try {
      const settings = await providerRuntime.update(await readJson(request));
      json(response, 200, settings);
    } catch (error) {
      if (error instanceof AppError) {
        json(response, 400, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (path === '/api/system/pick-folder' && request.method === 'POST') {
    try {
      json(response, 200, { path: await folderPicker() });
    } catch (error) {
      if (error instanceof AppError) {
        json(response, projectErrorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (path === '/api/projects/import' && request.method === 'POST') {
    try {
      const upload = await readMultipart(request);
      const project = await manager.importFolder({
        name: upload.fields.get('name') ?? '',
        files: upload.files,
      });
      json(response, 201, { project });
    } catch (error) {
      if (error instanceof AppError) {
        json(response, projectErrorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (path === '/api/projects' && request.method === 'GET') {
    json(response, 200, {
      defaultProject: manager.defaultId(),
      manageable: manager.manageable,
      projects: manager.list(),
    });
    return;
  }

  if (path === '/api/projects' && request.method === 'POST') {
    try {
      const project = await manager.create(await readJson(request));
      json(response, 201, { project });
    } catch (error) {
      if (error instanceof AppError) {
        json(response, projectErrorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }
    return;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projectMatch && request.method === 'DELETE') {
    try {
      await manager.archive(
        decodeURIComponent(projectMatch[1]!),
        url.searchParams.get('force') === '1',
      );
      json(response, 200, { ok: true, defaultProject: manager.defaultId() });
    } catch (error) {
      if (error instanceof AppError) {
        json(response, projectErrorStatus(error.code), {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (path.startsWith('/api/')) {
    const requested =
      String(request.headers['x-spec-agent-project'] ?? '') ||
      url.searchParams.get('project') ||
      manager.defaultId();
    const context = contexts.get(requested);
    if (!context) {
      json(response, 404, {
        error: { code: 'E_PROJECT_NOT_FOUND', message: requested },
      });
      return;
    }
    await api(
      context.runtime,
      context.repo,
      context.config.root,
      context.planner,
      context.chat,
      context.work,
      context.workMemory,
      context.workExecutor,
      context.workTriage,
      context.privateAssistant,
      context.workPlanner,
      context.outboxWorker,
      context.plans,
      request,
      response,
      path,
      url,
      { json, readJson, readRawBody },
    );
    return;
  }

  if (webDist) {
    serveStatic(webDist, path, response);
    return;
  }

  json(response, 404, { error: { code: 'E_NOT_FOUND', message: path } });
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;

  const provided = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

