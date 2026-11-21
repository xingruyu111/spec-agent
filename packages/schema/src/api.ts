/**
 * API DTO —— server / client / web 三方的合同。
 *
 * 约定：
 * - 错误统一用 ApiError，不返回 HTML；
 * - 列表统一分页，哪怕现在用不上；
 * - SSE 只推两类帧：事件和心跳。
 */

import type {
  AgentId,
  ArtifactRef,
  EventId,
  GateId,
  IsoDateTime,
  ModelSelector,
  NodeRunId,
  RunId,
  RunStatus,
  TaskId,
  TaskResult,
  TaskStatus,
  NodeRunStatus,
  Usage,
} from './common.js';
import type { GateAsk, GateDecision, GateKind, GatePayload, GateStatus } from './gate.js';
import type { EventEnvelope } from './events.js';
import type { GateAction } from './commands.js';
import type { SpecRef } from './spec.js';

/* ------------------------------------------------------------------ */
/* 读模型                                                              */
/* ------------------------------------------------------------------ */

export type AgentRuntimeStatus = 'idle' | 'running' | 'waiting_gate';

export type AgentDTO = {
  id: AgentId;
  name: string;
  role: string;
  parentId: AgentId | null;
  model: ModelSelector;
  status: AgentRuntimeStatus;
  currentTaskId?: TaskId;
  pendingGates: number;
};

export type TaskDTO = {
  id: TaskId;
  parentId: TaskId | null;
  assignee: AgentId;
  caller: AgentId | null;
  title: string;
  status: TaskStatus;
  result?: TaskResult;
  costUsd: number;
  branch?: string;
  createdAt: IsoDateTime;
  finishedAt?: IsoDateTime;
};

export type NodeRunDTO = {
  id: NodeRunId;
  nodeId: string;
  type: string;
  status: NodeRunStatus;
  attempt: number;
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  costUsd: number;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
};

export type RunDTO = {
  id: RunId;
  taskId: TaskId;
  specRef: SpecRef;
  status: RunStatus;
  nodes: NodeRunDTO[];
  costUsd: number;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
};

export type GateDTO = {
  id: GateId;
  kind: GateKind;
  ask: GateAsk;
  status: GateStatus;
  decision?: GateDecision;
  nodeRunId?: NodeRunId;
  taskId?: TaskId;
  attempt: number;
  payload: GatePayload;
  remindAt?: IsoDateTime;
  requestedAt: IsoDateTime;
  decidedAt?: IsoDateTime;
  decidedBy?: string;
};

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

export type CreateTaskRequest = {
  assignee: AgentId;
  title: string;
  brief: string;
  inputs?: ArtifactRef[];
  parentTaskId?: TaskId;
};

export type DecideGateRequest = {
  action: GateAction;
  comment?: string;
  /** action = 'respond' 时的回答内容 */
  content?: string;
};

export type SendOperatorMessageRequest = {
  agentId: AgentId;
  taskId?: TaskId;
  text: string;
};

export type CancelTaskRequest = { reason?: string };

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

export type ApiError = {
  code: string;
  message: string;
  detail?: unknown;
  requestId?: string;
};

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};

export type DecideGateResponse = {
  gate: GateDTO;
  taskStatus: TaskStatus;
};

export type CostBreakdownRow = {
  key: string;
  usd: number;
  usage?: Usage;
};

/**
 * SSE 帧。`Last-Event-ID` 对应 EventEnvelope.seq，断线重连可以精确补齐。
 */
export type SseFrame =
  | { type: 'event'; seq: number; event: EventEnvelope }
  | { type: 'heartbeat'; ts: IsoDateTime };

/** 事件在 UI 上的投影，比原始 envelope 多一点展示用的字段。 */
export type EventDTO = {
  seq: number;
  id: EventId;
  ts: IsoDateTime;
  type: string;
  actor: string;
  summary: string;
  taskId?: TaskId;
  runId?: RunId;
  nodeRunId?: NodeRunId;
};

export type InboxDTO = {
  gates: GateDTO[];
  total: number;
};
