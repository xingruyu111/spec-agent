/**
 * 事件：系统的唯一真相（design.md §5.8）。
 *
 * 约定：
 * - 事件一旦写入不可修改；纠正靠追加新事件；
 * - `v` 是 payload 的 schema 版本，无法解析的旧事件必须显式拒绝，不能猜；
 * - `correlationId` 是任务树的根，用于把一次交付的所有事件串起来；
 * - `causationId` 指向直接触发它的上一条事件。
 *
 * 注意：taskId / runId / nodeRunId 放在信封上，payload 里不再重复。
 */

import type {
  AgentId,
  ArtifactRef,
  BudgetScope,
  ErrorInfo,
  EventId,
  GateId,
  IsoDateTime,
  MessageId,
  NodeId,
  NodeRunId,
  RunId,
  TaskId,
  TaskResult,
  Usage,
} from './common.js';
import type {
  GateAsk,
  GateDecision,
  GateKind,
  GatePayload,
  ValidationIssue,
  VerificationFailure,
} from './gate.js';
import type { SpecOrigin } from './spec.js';

export type EventActor =
  | { type: 'user'; id: string }
  | { type: 'agent'; id: AgentId }
  | { type: 'runtime'; id: string }
  | { type: 'tool'; id: string };

export type MessageKind = 'question' | 'answer' | 'notice' | 'operator';

export interface EventPayloadMap {
  /* ---------------- project / agent ---------------- */
  'project.created': { name: string; rootPath: string; mainBranch: string };
  'agent.created': { agentId: AgentId; parentId: AgentId | null };
  'agent.updated': { agentId: AgentId; configHash: string; changed: string[] };

  /* ---------------- task ---------------- */
  'task.created': {
    assignee: AgentId;
    caller: AgentId | null;
    parentTaskId: TaskId | null;
    /** 由哪个节点委派而来，用于 delegate 节点找回子任务 */
    originNodeRunId?: NodeRunId;
    title: string;
    brief: string;
    inputs: ArtifactRef[];
    baseCommit?: string;
    branch?: string;
    repoPath?: string;
    worktree?: string;
    /** 规划器调用成本，创建任务时一并入账 */
    plannerUsage?: Usage;
  };
  'task.claimed': { leaseUntil: IsoDateTime };
  'task.started': Record<string, never>;
  'task.waiting_children': { pending: TaskId[] };
  'task.waiting_gate': { gateId: GateId };
  'task.waiting_input': { gateId: GateId };
  'task.resumed': {
    from: 'waiting_children' | 'waiting_gate' | 'waiting_input';
    reason?: string;
  };
  'task.finished': { result: TaskResult };
  'task.failed': { error: ErrorInfo; partial?: TaskResult };
  'task.cancelled': { reason?: string; cascade: TaskId[] };
  'task.reopened': { reason?: string };

  /* ---------------- message ---------------- */
  'message.sent': {
    messageId: MessageId;
    from: AgentId;
    to: AgentId;
    kind: MessageKind;
    /** 跨级提问的转发路径，直连时为空 */
    route: AgentId[];
    body: string;
    replyTo?: MessageId;
  };
  'message.delivered': { messageId: MessageId };
  'message.answered': { messageId: MessageId; body: string };
  'message.expired': { messageId: MessageId };

  /* ---------------- workflow ---------------- */
  'workflow.assembled': {
    specId: string;
    origin: SpecOrigin;
    basedOn?: string;
    nodeCount: number;
    /** 组装的执行者 */
    assembledBy: AgentId;
  };
  'workflow.validated': { specId: string; checks: string[] };
  'workflow.validation_failed': { errors: ValidationIssue[] };
  'workflow.run.started': {
    specId: string;
    params: Record<string, unknown>;
    /** subworkflow 嵌套时指向父 run / 父节点 */
    parentRunId?: RunId;
    parentNodeRunId?: NodeRunId;
  };
  'workflow.run.waiting': { reason: 'children' | 'gate'; refId?: string };
  'workflow.run.finished': { status: 'succeeded' | 'failed'; costUsd: number };
  'workflow.run.replanned': { specId: string; reason?: string };
  'workflow.run.failed': { error: ErrorInfo };
  'run.cancelled': { reason?: string };
  'workflow.run.reopened': { reason?: string };

  /* ---------------- node ---------------- */
  'node.ready': { nodeId: NodeId };
  'node.started': { nodeId: NodeId; attempt: number };
  'node.verifying': {
    nodeId: NodeId;
    attempt: number;
    outputs: ArtifactRef[];
    transcriptRef?: string;
    sessionKey?: string;
    sessionCumulativeUsd?: number;
    usage?: Usage;
  };
  'node.waiting_gate': { nodeId: NodeId; gateId: GateId };
  'node.finished': { nodeId: NodeId; outputs: ArtifactRef[]; usage?: Usage };
  'node.failed': {
    nodeId: NodeId;
    attempt: number;
    error: ErrorInfo;
    willRetry: boolean;
  };
  'node.retried': {
    nodeId: NodeId;
    from: number;
    to: number;
    reason: 'auto' | 'human';
  };
  'node.skipped': { nodeId: NodeId; reason: string };
  'node.cancelled': { nodeId: NodeId; reason: string };
  'node.reset': { nodeId: NodeId; attempt: number; reason: string };
  'node.checkpoint': { nodeId: NodeId; ref: string };
  'node.interrupted': {
    nodeId: NodeId;
    reason: 'lease_expired' | 'cancelled' | 'shutdown';
  };
  'node.verification_failed': {
    nodeId: NodeId;
    verifier: string;
    failures: VerificationFailure[];
  };

  /* ---------------- gate ---------------- */
  'gate.requested': {
    gateId: GateId;
    kind: GateKind;
    ask: GateAsk;
    attempt: number;
    payload: GatePayload;
    remindAt?: IsoDateTime;
    escalateAt?: IsoDateTime;
  };
  'gate.passed': {
    gateId: GateId;
    decision: GateDecision;
    by?: string;
    comment?: string;
    /** decision = 'respond' 时的回答内容，和 comment 分开存 */
    content?: string;
  };
  'gate.failed': {
    gateId: GateId;
    decision: GateDecision;
    by?: string;
    comment?: string;
    failures?: VerificationFailure[];
  };
  'gate.cancelled': { gateId: GateId; reason: string };
  'gate.reminded': { gateId: GateId; level: number };
  'gate.overridden': { gateId: GateId; by: string; reason: string };

  /* ---------------- llm / tool ---------------- */
  'llm.called': {
    agentId: AgentId;
    provider: string;
    model: string;
    promptHash: string;
    usage: Usage;
    latencyMs: number;
  };
  'llm.failed': { agentId: AgentId; provider: string; model: string; error: ErrorInfo };
  'tool.called': {
    tool: string;
    argsHash: string;
    toolUseId?: string;
    inputPreview?: string;
    nodeId?: NodeId;
  };
  'tool.result': {
    tool: string;
    ok: boolean;
    durationMs: number;
    toolUseId?: string;
    outputPreview?: string;
    error?: ErrorInfo;
    nodeId?: NodeId;
  };

  /* ---------------- git ---------------- */
  'git.branch_created': { branch: string; base: string };
  'git.committed': {
    branch: string;
    commit: string;
    files: number;
    insertions: number;
    deletions: number;
  };
  'git.merged': { from: string; into: string; commit: string };
  'git.conflict': { files: string[]; ours: string; theirs: string };
  'git.reset': { to: string; reason: string };

  /* ---------------- 运行控制 ---------------- */
  'budget.warning': { scope: BudgetScope; usedUsd: number; limitUsd: number };
  'budget.exceeded': {
    scope: BudgetScope;
    usedUsd: number;
    limitUsd: number;
    paused: boolean;
  };
  'lease.expired': { kind: 'task' | 'node'; id: string; owner?: string };
  'run.paused': { reason: string };
  'run.resumed': Record<string, never>;
  'human.override': { target: AgentId; message: string };
  'template.promoted': {
    specId: string;
    name: string;
    version: number;
    fromRun: RunId;
  };
  'plan.friction': {
    kind: 'shared_file' | 'contract_gap' | 'replan';
    detail: string;
  };
}

export type EventType = keyof EventPayloadMap;

export type EventEnvelope<T extends EventType = EventType> = {
  seq: number;
  id: EventId;
  ts: IsoDateTime;
  type: T;
  v: number;
  actor: EventActor;
  taskId?: TaskId;
  runId?: RunId;
  nodeRunId?: NodeRunId;
  correlationId: string;
  causationId?: EventId;
  payload: EventPayloadMap[T];
};

/** 便于在 store 里做窄化。 */
export type AnyEvent = {
  [K in EventType]: EventEnvelope<K>;
}[EventType];

/** 当前的 payload schema 版本。新增事件类型时一起维护。 */
export const EVENT_SCHEMA_VERSION = 1;
