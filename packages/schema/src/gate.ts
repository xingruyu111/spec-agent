/**
 * 闸门：自动验证与人工审核共用一套类型。
 *
 * 关键约定（design.md §12）：
 * - 先自动，后人工；
 * - 人的动作有四种：approve / edit / reject / respond；
 * - 自动闸门的失败必须能结构化地喂回下一次 attempt。
 */

import type { AgentId, ArtifactRef, Duration, NodeId } from './common.js';

export type GateKind = 'auto' | 'human';

/** 这次要人（或机器）做什么。 */
export type GateAsk = 'check' | 'approve' | 'input';

export type GateStatus = 'pending' | 'passed' | 'failed' | 'cancelled';

/** 决策来源。`auto` 表示机器判的。 */
export type GateDecision = 'auto' | 'approve' | 'edit' | 'reject' | 'respond';

export type Approver = 'human' | AgentId;

export type RejectMode = 'revise' | 'rollback' | 'fail';

export type ApprovalSpec = {
  approvers: Approver[];
  /** 不填默认 revise */
  onReject?: RejectMode;
  /** 不填默认 3 */
  maxAttempts?: number;
  /** 不填默认 '1h' */
  remindAfter?: Duration;
  escalateAfter?: Duration;
  /**
   * 工具级闸门：这些工具每次调用都要单独审批。
   * 节点级闸门太粗时用，例如只拦 shell 和 spec_agent_commit。
   */
  tools?: string[];
};

/* ------------------------------------------------------------------ */
/* 验证器                                                              */
/* ------------------------------------------------------------------ */

export type VerifierSpec =
  | {
      kind: 'exit_code';
      /** 默认 true；设为 false 只记录不拦截 */
      mustPass?: boolean;
    }
  | {
      kind: 'contract';
      /** 例如 'pnpm tsc --noEmit' */
      run: string;
      timeout?: Duration;
      /** 只提示不阻塞 */
      advisory?: boolean;
    }
  | {
      kind: 'judge';
      /** rubric 文件路径，相对于工作区 */
      rubric: string;
      /** 0..1，默认 0.8 */
      threshold?: number;
      /** 默认 true：judge 误判率撑不起硬拦截 */
      advisory?: boolean;
    };

/** 一个节点或一个任务上挂的闸门声明。 */
export type GateSpec = {
  kind: GateKind;
  ask: GateAsk;
  /** kind = auto 时必须有 */
  verifier?: VerifierSpec;
  /** kind = human 时必须有 */
  approval?: ApprovalSpec;
};

/* ------------------------------------------------------------------ */
/* 验证结果                                                            */
/* ------------------------------------------------------------------ */

export type VerificationFailure = {
  message: string;
  file?: string;
  line?: number;
  expected?: string;
  actual?: string;
};

/* ------------------------------------------------------------------ */
/* 校验错误（spec 的 7 道校验）                                        */
/* ------------------------------------------------------------------ */

export type ValidationCode =
  | 'E_SCHEMA'
  | 'E_REFERENCE'
  | 'E_CYCLE'
  | 'E_CONTRACT_MISMATCH'
  | 'E_PERMISSION'
  | 'E_BUDGET'
  | 'E_LINT'
  | 'E_UNVERIFIED_ARTIFACT'
  /** 允许扩展，但新增时必须在这里登记 */
  | (string & {});

export type ValidationIssue = {
  code: ValidationCode;
  message: string;
  nodeId?: NodeId;
  /** JSON Pointer，例如 '/nodes/2/outputs/0' */
  path?: string;
};

/* ------------------------------------------------------------------ */
/* 审批包（给人看的材料）                                              */
/* ------------------------------------------------------------------ */

/**
 * 审批卡片的内容。注意：人只靠 agent 的自述是没法审的，
 * 所以 diff 和自动闸门的输出是必填项。
 */
export type GatePayload = {
  title: string;
  summary: string;
  /** unified diff；没有文件改动时省略 */
  diff?: string;
  artifacts?: ArtifactRef[];
  /** 自动闸门的输出摘要 */
  checks?: Array<{
    verifier: string;
    ok: boolean;
    failures?: VerificationFailure[];
  }>;
  meta?: {
    costUsd?: number;
    durationMs?: number;
    files?: number;
    insertions?: number;
    deletions?: number;
    attempts?: number;
  };
};
