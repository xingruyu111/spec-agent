/**
 * Agent 与组织。
 *
 * agent 是持久身份 + 配置，不是一段会话（design.md §5.2）。
 * 任务级上下文由运行时组装，不在这里表达。
 */

import type { AgentId, ModelSelector } from './common.js';
import type { ApprovalSpec, VerifierSpec } from './gate.js';
import type {
  ConditionNode,
  InputBinding,
  NodeType,
  OutputPort,
  ShellNode,
} from './spec.js';

export type ShellPolicy = 'readonly' | 'full';

export type ToolPolicy = {
  allow: string[];
  deny?: string[];
  /** 不给 model 自由选择；默认 readonly */
  shell?: ShellPolicy;
};

export type AgentWorkspace = {
  /** 允许提交的路径前缀 */
  writeScope: string[];
  /** 例如 'agent/fe/' */
  branchPrefix?: string;
};

/** 用户预配置的工作流节点；agent 只能组装，不能创建。 */
export type AgentNodeConfig = {
  /** agent 内唯一 id，由系统生成 */
  id: string;
  name: string;
  description: string;
  instructions?: string;
  /** 节点完成后是否需要人工审批 */
  approval?: boolean;
  /** 单节点 agent 最大轮次；缺省沿用引擎默认值 */
  maxTurns?: number;
  /** 用户声明的输出文件，会注入执行指令 */
  outputPath?: string;
  /** 完成标准，会注入执行指令 */
  doneCriteria?: string;
  /** 画布位置；缺省时由 UI 自动排列 */
  x?: number;
  y?: number;
  /** 缺省 llm；delegate 由层级规划器生成，不作为本地模板 */
  type?: Exclude<NodeType, 'delegate'>;
  /** shell / verify / condition / loop 的确定性命令 */
  run?: string;
  shell?: ShellNode['shell'];
  /** subworkflow 引用 */
  workflow?: string;
  params?: Record<string, string>;
  /** condition 的分支节点 id */
  branches?: ConditionNode['branches'];
  /** loop 控制 */
  maxIterations?: number;
  intervalMs?: number;
  /** fanout 的 JSON 数组文件与子任务并发 */
  itemsPath?: string;
  maxConcurrency?: number;
  /** 自动交付验证 */
  verify?: VerifierSpec[];
  /** 显式产物契约 */
  inputs?: InputBinding[];
  outputs?: OutputPort[];
  artifactSchema?: string;
  /** 未显式选模型时需要的模型能力 */
  modelCapabilities?: string[];
};

export type Budget = {
  perTaskUsd?: number;
  perDayUsd?: number;
  /** 同一个 agent 同时能跑几个任务，默认 1 */
  maxParallel?: number;
};

export type AgentConfig = {
  id: AgentId;
  name: string;
  /** null = 顶层 */
  parent: AgentId | null;
  role: string;
  /** 可选的系统提示；缺省时用 role */
  systemPrompt?: string;
  model: ModelSelector;
  /** skills/ 目录下的技能 id */
  skills: string[];
  /** 用户为该 agent 预配置的可组装节点 */
  nodes?: AgentNodeConfig[];
  tools: ToolPolicy;
  /** 允许委派给谁；不填表示按组织树 */
  canDelegateTo?: AgentId[];
  workspace?: AgentWorkspace;
  gates?: {
    /** 任务级终审 */
    taskGate?: ApprovalSpec;
  };
  budget?: Budget;
  /** 记忆文件名，默认 memory.md */
  memory?: string;
};

/* ------------------------------------------------------------------ */
/* 组织                                                                */
/* ------------------------------------------------------------------ */

export type OrgShape = 'hierarchy' | 'flat';

export type CommunicationMode = 'strict' | 'peer';

export type FlowKind = 'delegate' | 'question' | 'report';

/** 额外允许的定向边。树决定的边不能删，只能加。 */
export type FlowSpec = {
  from: AgentId;
  to: AgentId;
  kind: FlowKind;
};

export type OrgConfig = {
  shape: OrgShape;
  communication: CommunicationMode;
  roots: AgentId[];
  extraFlows?: FlowSpec[];
};
