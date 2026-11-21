/**
 * 命令：意图，不产生副作用。由 domain 校验后转成事件草稿（design.md §5.8）。
 *
 * 每个命令都带齐事件信封需要的 id，domain 不查库、不生成 id。
 */

import type {
  AgentId,
  ArtifactRef,
  ErrorInfo,
  GateId,
  IsoDateTime,
  NodeId,
  NodeRunId,
  RunId,
  TaskId,
  TaskResult,
  Usage,
} from './common.js';
import type { GateAsk, GateKind, GatePayload } from './gate.js';
import type { EventActor } from './events.js';

export type GateAction = 'approve' | 'edit' | 'reject' | 'respond';

/* ------------------------------------------------------------------ */
/* Task                                                                */
/* ------------------------------------------------------------------ */

export type CreateTaskCommand = {
  type: 'task.create';
  taskId: TaskId;
  assignee: AgentId;
  caller: AgentId | null;
  parentTaskId?: TaskId;
  originNodeRunId?: NodeRunId;
  title: string;
  brief: string;
  inputs?: ArtifactRef[];
  baseCommit?: string;
  branch?: string;
  /** 任务所在仓库；缺省使用项目 repo */
  repoPath?: string;
  /** 规划器调用成本，创建任务时一并入账 */
  planUsage?: Usage;
};

export type ClaimTaskCommand = {
  type: 'task.claim';
  taskId: TaskId;
  leaseUntil: IsoDateTime;
};

export type WaitTaskCommand = {
  type: 'task.wait';
  taskId: TaskId;
  reason: 'children' | 'gate' | 'input';
  /** reason = gate/input 时的闸门 id */
  refId?: string;
  /** reason = children 时还在跑的子任务 */
  pending?: TaskId[];
};

export type ResumeTaskCommand = {
  type: 'task.resume';
  taskId: TaskId;
  reason?: string;
};

export type FinishTaskCommand = {
  type: 'task.finish';
  taskId: TaskId;
  result: TaskResult;
};

export type FailTaskCommand = {
  type: 'task.fail';
  taskId: TaskId;
  error: ErrorInfo;
  partial?: TaskResult;
};

export type CancelTaskCommand = {
  type: 'task.cancel';
  taskId: TaskId;
  reason?: string;
};

export type ReopenTaskCommand = {
  type: 'task.reopen';
  taskId: TaskId;
  reason?: string;
};

export type TaskCommand =
  | CreateTaskCommand
  | ClaimTaskCommand
  | WaitTaskCommand
  | ResumeTaskCommand
  | FinishTaskCommand
  | FailTaskCommand
  | CancelTaskCommand
  | ReopenTaskCommand;

/* ------------------------------------------------------------------ */
/* Node                                                                */
/* ------------------------------------------------------------------ */

export type NodeContext = {
  taskId: TaskId;
  runId: RunId;
  nodeRunId: NodeRunId;
  nodeId: NodeId;
};

export type ReadyNodeCommand = NodeContext & { type: 'node.ready' };

export type StartNodeCommand = NodeContext & { type: 'node.start' };

export type ProduceNodeCommand = NodeContext & {
  type: 'node.produced';
  outputs: ArtifactRef[];
  transcriptRef?: string;
  /** session 模式的稳定路由/工具/前缀指纹 */
  sessionKey?: string;
  /** Claude resume session 的累计成本，用于跨节点差分化 */
  sessionCumulativeUsd?: number;
  usage?: Usage;
};

export type CompleteNodeCommand = NodeContext & { type: 'node.complete' };

export type WaitNodeGateCommand = NodeContext & {
  type: 'node.wait_gate';
  gateId: GateId;
};

export type RetryNodeCommand = NodeContext & {
  type: 'node.retry';
  reason: 'auto' | 'human';
};

export type FailNodeCommand = NodeContext & {
  type: 'node.fail';
  error: ErrorInfo;
};

export type SkipNodeCommand = NodeContext & {
  type: 'node.skip';
  reason: string;
};

export type InterruptNodeCommand = NodeContext & {
  type: 'node.interrupt';
  reason: 'lease_expired' | 'cancelled' | 'shutdown';
};

export type CancelNodeCommand = NodeContext & {
  type: 'node.cancel';
  reason: string;
};

export type ResetNodeCommand = NodeContext & {
  type: 'node.reset';
  reason: string;
};

export type NodeCommand =
  | ReadyNodeCommand
  | StartNodeCommand
  | ProduceNodeCommand
  | CompleteNodeCommand
  | WaitNodeGateCommand
  | RetryNodeCommand
  | FailNodeCommand
  | SkipNodeCommand
  | InterruptNodeCommand
  | CancelNodeCommand
  | ResetNodeCommand;

/* ------------------------------------------------------------------ */
/* Gate                                                                */
/* ------------------------------------------------------------------ */

export type RequestGateCommand = {
  type: 'gate.request';
  gateId: GateId;
  taskId?: TaskId;
  nodeRunId?: NodeRunId;
  kind: GateKind;
  ask: GateAsk;
  attempt: number;
  payload: GatePayload;
  remindAt?: IsoDateTime;
  escalateAt?: IsoDateTime;
};

export type DecideGateCommand = {
  type: 'gate.decide';
  gateId: GateId;
  action: GateAction;
  by: string;
  comment?: string;
  /** action = 'respond' 时的回答 */
  content?: string;
};

export type CancelGateCommand = {
  type: 'gate.cancel';
  gateId: GateId;
  reason: string;
};

export type GateCommand = RequestGateCommand | DecideGateCommand | CancelGateCommand;

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

export type StartRunCommand = {
  type: 'run.start';
  runId: RunId;
  taskId: TaskId;
  specId: string;
  params: Record<string, unknown>;
  parentRunId?: RunId;
  parentNodeRunId?: NodeRunId;
};

export type WaitRunCommand = {
  type: 'run.wait';
  runId: RunId;
  reason: 'children' | 'gate';
  refId?: string;
};

export type FinishRunCommand = {
  type: 'run.finish';
  runId: RunId;
  status: 'succeeded' | 'failed';
  costUsd: number;
};

export type FailRunCommand = {
  type: 'run.fail';
  runId: RunId;
  error: ErrorInfo;
};

export type CancelRunCommand = {
  type: 'run.cancel';
  runId: RunId;
  reason?: string;
};

export type ReopenRunCommand = {
  type: 'run.reopen';
  runId: RunId;
  reason?: string;
};

export type PauseRunCommand = { type: 'run.pause'; runId: RunId; reason: string };
export type ResumeRunCommand = { type: 'run.resume'; runId: RunId };

/** 审批前替换 run 的 spec；只允许在没有真实节点执行时使用 */
export type ReplanRunCommand = {
  type: 'run.replan';
  runId: RunId;
  specId: string;
  reason?: string;
};

export type RunCommand =
  | StartRunCommand
  | WaitRunCommand
  | FinishRunCommand
  | FailRunCommand
  | CancelRunCommand
  | ReopenRunCommand
  | PauseRunCommand
  | ResumeRunCommand
  | ReplanRunCommand;

/* ------------------------------------------------------------------ */

export type Command = TaskCommand | NodeCommand | GateCommand | RunCommand;

export type CommandType = Command['type'];

/** 命令信封：谁发的、幂等键是什么。 */
export type CommandEnvelope<C extends Command = Command> = {
  command: C;
  actor: EventActor;
  /** 重投递时用于去重；不填则由运行时生成 */
  idempotencyKey?: string;
};
