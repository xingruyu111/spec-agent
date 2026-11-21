/**
 * AgentRuntime —— 一次节点执行的完整边界。
 *
 * 为什么不是"一次 LLM 调用"：Claude Agent SDK 拥有 agent 循环本身
 * （工具调用、上下文压缩、重试），我们只能以"一次 run"为粒度打交道。
 *
 * 三条约束（design.md §5.10 / 调研结论）：
 * 1. 一次 run 只做一件事，跑完只留 artifact，没有跨 run 记忆；
 * 2. 不依赖 SDK 的 session 恢复来做持久化——恢复靠我们自己的 node_run 状态；
 * 3. 人审不走 SDK 的回调，走 gates 表。
 */

import type { ArtifactRef, ErrorInfo, Usage } from '@spec-agent/schema';

export type ModelMetadata = {
  /** vision / tools / reasoning / code / audio / video 等能力标识 */
  capabilities?: string[];
  quality?: number;
  speed?: number;
  cost?: number;
  /** 模型实际上下文窗口；Claude 同时作为 autoCompactWindow */
  contextWindow?: number;
  /** 是否启用自动上下文压缩；缺省 true */
  autoCompact?: boolean;
};

/** 一个供应商端点。authToken 只在这一层出现，禁止落库或写日志。 */
export type ProviderConfig = {
  id: string;
  name?: string;
  /** 中转使用的线协议；缺省 anthropic 保持旧项目兼容 */
  protocol?: 'anthropic' | 'openai';
  baseUrl?: string;
  authToken?: string;
  /** 供应商级额外请求头；属于敏感配置，禁止通过公开 GET 返回 */
  headers?: Record<string, string>;
  /** 可用模型及其能力/排序元数据 */
  models?: Record<string, ModelMetadata>;
  /** 把 claude-* 的模型名映射到该供应商的实际模型 */
  modelAliases?: Record<string, string>;
};

export type SkillRef = {
  id: string;
  name: string;
  /** SKILL.md 的绝对路径 */
  path: string;
  description?: string;
};

export type AgentBudget = {
  maxTurns: number;
  maxUsd: number;
};

export type AgentRuntimeInput = {
  systemPrompt: string;
  /** 任务简述 + 产物引用；不要塞整段对话 */
  task: string;
  /** 任务 worktree 的绝对路径，所有读写都被限制在这里 */
  cwd: string;
  /** 组织根目录；用于 MCP 工具定位 agents.yaml（与临时 worktree 区分） */
  workspaceRoot?: string;
  allowedTools: string[];
  skills: SkillRef[];
  /** 项目显式配置的 MCP servers；无隐式开发机配置 */
  mcpServers?: Record<string, unknown>;
  provider: ProviderConfig;
  model: string;
  /** 节点重试/恢复时继续上次的 SDK session */
  resumeSessionId?: string;
  /** 分支节点从共同前驱 fork 新 session，避免共享可变上下文 */
  forkSession?: boolean;
  /** 当前模型的上下文与自动压缩策略 */
  modelContext?: Pick<ModelMetadata, 'contextWindow' | 'autoCompact'>;
  /** 会话级文件权限；缺省由 allowedTools 推导 */
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  budget: AgentBudget;
  signal: AbortSignal;
  /** 实时工具调用回调；用于写入事件并推给 UI */
  onToolEvent?: (event: AgentToolEvent) => void;
};

export type AgentStopReason = 'finished' | 'max_turns' | 'aborted' | 'failed';

export type AgentToolEvent = {
  phase: 'call' | 'result';
  toolUseId: string;
  tool: string;
  /** 已经截断、脱敏到可展示长度 */
  inputPreview?: string;
  outputPreview?: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
};

export type AgentRuntimeOutput = {
  /** 产物引用，正文已经落盘 */
  outputs: ArtifactRef[];
  /** 本次 run 的最终文本；规划器等需要纯文本的调用方用它 */
  text?: string;
  /** 指向 transcript 存储的引用，不是正文 */
  transcriptRef: string;
  usage: Usage;
  stopReason: AgentStopReason;
  error?: ErrorInfo;
};

/** 连通性自检。用于 provider 接入前验证 tool calling / 缓存是否可用。 */
export type ProbeResult = {
  ok: boolean;
  toolCalling: boolean;
  promptCaching: boolean;
  latencyMs: number;
  error?: string;
};

export interface AgentRuntime {
  readonly id: string;
  run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
  probe?(provider: ProviderConfig, signal: AbortSignal): Promise<ProbeResult>;
}
