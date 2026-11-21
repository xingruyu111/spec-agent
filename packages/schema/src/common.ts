/**
 * 基础类型。这里不放任何业务规则，也不依赖任何运行时。
 *
 * 命名约定：
 * - 所有 id 都是 branded string，避免把 taskId 当 runId 传；
 * - 时间统一用 ISO 8601 字符串，精度到毫秒；
 * - 金额统一用美元（number），不做货币换算。
 */

/** 给原始类型加一个编译期标记，运行时不产生任何东西。 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type AgentId = Brand<string, 'AgentId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type RunId = Brand<string, 'RunId'>;
export type NodeRunId = Brand<string, 'NodeRunId'>;
export type GateId = Brand<string, 'GateId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type EventId = Brand<string, 'EventId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type MessageId = Brand<string, 'MessageId'>;

/** ISO 8601，例如 2026-10-26T13:32:51.000+08:00 */
export type IsoDateTime = string;

/** 人类可读的时长，例如 '20m' / '1h30m' / '90s'。运行时解析成毫秒。 */
export type Duration = string;

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider prefix cache hits; 0/undefined 表示未提供或不支持 */
  cacheReadInputTokens?: number;
  /** 本次请求写入缓存的 token 数 */
  cacheCreationInputTokens?: number;
  turns?: number;
  usd: number;
};

/* ------------------------------------------------------------------ */
/* 产物                                                                */
/* ------------------------------------------------------------------ */

export type ArtifactKind =
  | 'file'
  | 'dir'
  | 'text'
  | 'json'
  | 'diff'
  | 'image'
  | 'audio'
  | 'video'
  | 'binary';

/**
 * 产物引用。节点之间传的是这个，不是正文。
 *
 * 大内容一律落文件；`path` 相对于该任务的 worktree。
 * `commit` 用来把产物钉在某个提交上，防止被后续节点改掉。
 */
export type ArtifactRef = {
  name: string;
  kind: ArtifactKind;
  path?: string;
  commit?: string;
  contentHash?: string;
  /** kind = 'json' 时的 schema 标识 */
  schema?: string;
  /** 小型结构化内联值，例如 condition 决策；大内容仍写文件 */
  data?: unknown;
  bytes?: number;
};

/* ------------------------------------------------------------------ */
/* 结果与错误                                                          */
/* ------------------------------------------------------------------ */

export type ResultStatus = 'ok' | 'failed' | 'blocked' | 'needs_input';

/**
 * 任务终结时父 agent 读到的结构化结果（design.md §8.2）。
 * 报告自由文本是禁止的，至少要有 status + summary + artifacts。
 */
export type TaskResult = {
  status: ResultStatus;
  summary: string;
  artifacts: ArtifactRef[];
  decisions?: string[];
  openIssues?: string[];
  suggestions?: string[];
  error?: ErrorInfo;
  usage?: Usage;
};

export type ErrorInfo = {
  /** 稳定错误码，例如 E_CONTRACT_MISMATCH */
  code: string;
  message: string;
  detail?: unknown;
};

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */

export type ModelSelector = {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
};

/* ------------------------------------------------------------------ */
/* 状态（跨模块共享，定义只此一份）                                     */
/* ------------------------------------------------------------------ */

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_children'
  | 'waiting_gate'
  | 'waiting_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type NodeRunStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'waiting_gate'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type BudgetScope = 'task' | 'run' | 'project_day';

/** 终态集合，调度与取消都会用到。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];
