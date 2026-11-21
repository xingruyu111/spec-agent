/**
 * WorkflowSpec —— 画布、校验器、引擎、数据库共用的唯一结构。
 *
 * 两条硬约定：
 * 1. `ui` 只服务编辑器，**不进 hash**。拖动节点不能产生新版本，否则历史 run 的引用全断。
 * 2. 节点之间传的是 artifact 引用（ArtifactRef），不是正文。
 *
 * YAML 里的 `- [plan, implement]` 在解析时归一化成 `{ from, to }`。
 */

import type {
  AgentId,
  ArtifactKind,
  Duration,
  IsoDateTime,
  ModelSelector,
  NodeId,
} from './common.js';
import type { ApprovalSpec, VerifierSpec } from './gate.js';

/* ------------------------------------------------------------------ */
/* 节点                                                                */
/* ------------------------------------------------------------------ */

export type NodeType =
  | 'llm'
  | 'shell'
  | 'verify'
  | 'delegate'
  | 'subworkflow'
  | 'condition'
  | 'loop'
  | 'fanout';

export type RetryPolicy = 'never' | 'on_failure' | 'on_crash';

/** 工具名，例如 'read_file' / 'shell:test' */
export type ToolRef = string;

/**
 * 引用：'param.spec' 或 '<nodeId>.<portName>'。
 * 故意不做成模板字符串类型——spec 来自 LLM，先宽松解析，再由校验器判合法性。
 */
export type NodeRef = string;

export type InputBinding = {
  name: string;
  from: NodeRef;
  /**
   * 期望的产物类型。省略表示"接受任意类型"。
   * 声明了才会参与契约校验（design.md §11.3 规则 3）。
   */
  kind?: ArtifactKind;
  required?: boolean;
};

export type OutputPort = {
  name: string;
  kind: ArtifactKind;
  /** 相对于任务 worktree 的路径 */
  path?: string;
  /** kind = 'json' 时的 schema 标识 */
  schema?: string;
  required?: boolean;
};

export type NodeBase = {
  id: NodeId;
  /** 给组装器看的一句话职责。和 instructions 不同，它不直接进 prompt。 */
  description: string;
  inputs: InputBinding[];
  outputs: OutputPort[];
  timeout?: Duration;
  retries?: number;
  retryPolicy?: RetryPolicy;
  /** 自动闸门；全部通过才进下游 */
  verify?: VerifierSpec[];
  /** 人工闸门 */
  approval?: ApprovalSpec;
  /** 默认 true；只读节点（如纯分析）设为 false */
  autoCommit?: boolean;
};

/** 单次 LLM 调用。无记忆：跑完只留 artifact。 */
export type LlmNode = NodeBase & {
  type: 'llm';
  /** 执行该节点的 agent；缺省为任务 assignee。必须在组织树内 */
  agent?: AgentId;
  /** 节点 prompt；省略时退化为 description */
  instructions?: string;
  systemPrompt?: string;
  tools: ToolRef[];
  /** 提交时的路径白名单，越界会被 git 包装器拒绝 */
  writeScope?: string[];
  /** 'inherit' 表示沿用 agent 的模型 */
  model?: 'inherit' | ModelSelector;
  /** 未显式选模型时，需要 provider 目录满足的能力 */
  modelCapabilities?: string[];
  /** 单节点最大轮次；缺省沿用引擎默认值 */
  maxTurns?: number;
};

/** 执行命令。默认带一个 exit_code 自动闸门。 */
export type ShellNode = NodeBase & {
  type: 'shell';
  run: string;
  /** 显式声明解释器，别让模型猜 */
  shell?: 'pwsh' | 'bash' | 'sh' | 'cmd';
  cwd?: string;
  env?: Record<string, string>;
};

/** 创建子任务并等待。agent 与 workflow 的唯一接口。 */
export type DelegateNode = NodeBase & {
  type: 'delegate';
  agent: AgentId;
  brief: string;
  /** 缺省为调用者 worktree 的 HEAD */
  base?: string;
};

/** 嵌套另一份 spec。执行时开一个子 run。 */
export type SubworkflowNode = NodeBase & {
  type: 'subworkflow';
  /** 'feature-dev@v3' 或 spec id */
  workflow: string;
  /** 参数名 -> 引用 */
  params: Record<string, NodeRef>;
};

/** 与 shell 相同的确定性执行，但语义上只负责交付验证。 */
export type VerifyNode = Omit<ShellNode, 'type'> & { type: 'verify' };

/** 命令退出码 0 = true，非 0 = false；false 不是节点失败。 */
export type ConditionNode = NodeBase & {
  type: 'condition';
  run: string;
  shell?: 'pwsh' | 'bash' | 'sh' | 'cmd';
  branches: {
    whenTrue: NodeId[];
    whenFalse: NodeId[];
  };
};

/** 确定性命令循环：退出码 0 停止，非 0 继续，达到上限才失败。 */
export type LoopNode = NodeBase & {
  type: 'loop';
  run: string;
  shell?: 'pwsh' | 'bash' | 'sh' | 'cmd';
  maxIterations: number;
  intervalMs?: number;
};

/** 从 JSON 数组文件创建多个子任务；{{item}} 可注入 brief。 */
export type FanoutNode = NodeBase & {
  type: 'fanout';
  itemsPath: string;
  /** 每个 item 的命令模板，支持 {{item}} / {{index}} / {{item.field}} */
  run: string;
  shell?: 'pwsh' | 'bash' | 'sh' | 'cmd';
  brief: string;
  agent?: AgentId;
  maxConcurrency?: number;
};

export type NodeSpec =
  | LlmNode
  | ShellNode
  | VerifyNode
  | DelegateNode
  | SubworkflowNode
  | ConditionNode
  | LoopNode
  | FanoutNode;

/* ------------------------------------------------------------------ */
/* 图                                                                  */
/* ------------------------------------------------------------------ */

export type WorkflowEdge = {
  from: NodeId;
  to: NodeId;
};

export type ParamKind = ArtifactKind | 'string' | 'number' | 'boolean';

export type WorkflowParam = {
  name: string;
  kind: ParamKind;
  required?: boolean;
  default?: unknown;
  description?: string;
};

export type NodeDefaults = {
  model?: 'inherit' | ModelSelector;
  timeout?: Duration;
  retries?: number;
  retryPolicy?: RetryPolicy;
};

export type SpecOrigin = 'template' | 'assembled' | 'promoted';

export type SpecMeta = {
  origin: SpecOrigin;
  createdBy?: AgentId;
  /** 基于哪个模板组装而来，例如 'feature-dev@v3' */
  basedOn?: string;
  createdAt?: IsoDateTime;
};

/** 仅编辑器使用；不参与 hash，不参与校验。 */
export type UiLayout = {
  positions: Record<string, { x: number; y: number }>;
  zoom?: number;
};

export type WorkflowSpec = {
  /** 保存时由内容 hash 生成；草稿态可以没有 */
  id?: string;
  name: string;
  version: number;
  description?: string;
  params: WorkflowParam[];
  nodes: NodeSpec[];
  edges: WorkflowEdge[];
  defaults?: NodeDefaults;
  ui?: UiLayout;
  meta?: SpecMeta;
};

/* ------------------------------------------------------------------ */
/* hash 边界                                                           */
/* ------------------------------------------------------------------ */

/**
 * 只有这些字段参与 spec id 的计算。
 * 排除：id（自引用）、ui（布局）、meta.createdAt（时间戳）。
 */
export type HashedSpec = Pick<
  WorkflowSpec,
  'name' | 'version' | 'description' | 'params' | 'nodes' | 'edges' | 'defaults'
>;

/** spec 的完整标识，例如 'feature-dev@v3' */
export type SpecRef = string;

/* ------------------------------------------------------------------ */
/* 目录（给组装器看的紧凑视图）                                        */
/* ------------------------------------------------------------------ */

export type CatalogNodeType = {
  type: NodeType;
  description: string;
  inputs: OutputPort[];
  outputs: OutputPort[];
  /** 历史 p50，用于成本预判 */
  typicalCostUsd?: number;
  typicalDurationMs?: number;
  /** 能不能和别的节点并行 */
  parallelizable: boolean;
  requiresApproval?: boolean;
};

export type CatalogTemplate = {
  name: string;
  version: number;
  description: string;
  nodeCount: number;
  params: WorkflowParam[];
  usageCount: number;
  avgCostUsd?: number;
};

export type Catalog = {
  nodeTypes: CatalogNodeType[];
  templates: CatalogTemplate[];
  agents: Array<{
    id: AgentId;
    name: string;
    description: string;
    inputs: string[];
    outputs: string[];
  }>;
  skills: Array<{ id: string; description: string; when?: string }>;
};
