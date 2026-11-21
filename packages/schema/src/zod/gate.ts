import { z } from 'zod';
import type {
  ApprovalSpec,
  Approver,
  GateAsk,
  GateDecision,
  GateKind,
  GatePayload,
  GateSpec,
  GateStatus,
  RejectMode,
  ValidationIssue,
  VerifierSpec,
  VerificationFailure,
} from '../gate.js';
import { zAgentId, zArtifactRef, zDuration, zNodeId } from './common.js';

export const zGateKind = z.enum(['auto', 'human']);
export const zGateAsk = z.enum(['check', 'approve', 'input']);
export const zGateStatus = z.enum(['pending', 'passed', 'failed', 'cancelled']);
export const zGateDecision = z.enum(['auto', 'approve', 'edit', 'reject', 'respond']);
export const zRejectMode = z.enum(['revise', 'rollback', 'fail']);

export const zVerifierSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('exit_code'),
    mustPass: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('contract'),
    run: z.string().min(1),
    timeout: zDuration.optional(),
    advisory: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('judge'),
    rubric: z.string().min(1),
    threshold: z.number().min(0).max(1).optional(),
    advisory: z.boolean().optional(),
  }),
]);

export const zApprover = z.union([z.literal('human'), zAgentId]);

export const zApprovalSpec = z.object({
  approvers: z.array(zApprover).min(1, '至少要有一个审批人'),
  onReject: zRejectMode.optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  remindAfter: zDuration.optional(),
  escalateAfter: zDuration.optional(),
  tools: z.array(z.string()).optional(),
});

export const zGateSpec = z
  .object({
    kind: zGateKind,
    ask: zGateAsk,
    verifier: zVerifierSpec.optional(),
    approval: zApprovalSpec.optional(),
  })
  .refine((v) => v.kind !== 'auto' || v.verifier !== undefined, {
    message: 'auto 闸门必须提供 verifier',
    path: ['verifier'],
  })
  .refine((v) => v.kind !== 'human' || v.approval !== undefined, {
    message: 'human 闸门必须提供 approval',
    path: ['approval'],
  });

export const zVerificationFailure = z.object({
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});

export const zGatePayload = z.object({
  title: z.string().min(1),
  summary: z.string(),
  diff: z.string().optional(),
  artifacts: z.array(zArtifactRef).optional(),
  checks: z
    .array(
      z.object({
        verifier: z.string(),
        ok: z.boolean(),
        failures: z.array(zVerificationFailure).optional(),
      }),
    )
    .optional(),
  meta: z
    .object({
      costUsd: z.number().nonnegative().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      files: z.number().int().nonnegative().optional(),
      insertions: z.number().int().nonnegative().optional(),
      deletions: z.number().int().nonnegative().optional(),
      attempts: z.number().int().min(1).optional(),
    })
    .optional(),
});

export const zValidationIssue = z.object({
  code: z.string(),
  message: z.string(),
  nodeId: zNodeId.optional(),
  path: z.string().optional(),
});

/* ---------------- 漂移检查 ---------------- */

const _verifier: VerifierSpec = {} as z.infer<typeof zVerifierSpec>;
const _verifierBack: z.infer<typeof zVerifierSpec> = {} as VerifierSpec;
const _approval: ApprovalSpec = {} as z.infer<typeof zApprovalSpec>;
const _approvalBack: z.infer<typeof zApprovalSpec> = {} as ApprovalSpec;
const _approver: Approver = {} as z.infer<typeof zApprover>;
const _approverBack: z.infer<typeof zApprover> = {} as Approver;
const _gateSpec: GateSpec = {} as z.infer<typeof zGateSpec>;
const _gateSpecBack: z.infer<typeof zGateSpec> = {} as GateSpec;
const _kind: GateKind = {} as z.infer<typeof zGateKind>;
const _ask: GateAsk = {} as z.infer<typeof zGateAsk>;
const _status: GateStatus = {} as z.infer<typeof zGateStatus>;
const _decision: GateDecision = {} as z.infer<typeof zGateDecision>;
const _reject: RejectMode = {} as z.infer<typeof zRejectMode>;
const _payload: GatePayload = {} as z.infer<typeof zGatePayload>;
const _payloadBack: z.infer<typeof zGatePayload> = {} as GatePayload;
const _failure: VerificationFailure = {} as z.infer<typeof zVerificationFailure>;
const _failureBack: z.infer<typeof zVerificationFailure> = {} as VerificationFailure;
const _issue: ValidationIssue = {} as z.infer<typeof zValidationIssue>;
const _issueBack: z.infer<typeof zValidationIssue> = {} as ValidationIssue;

void [
  _verifier,
  _verifierBack,
  _approval,
  _approvalBack,
  _approver,
  _approverBack,
  _gateSpec,
  _gateSpecBack,
  _kind,
  _ask,
  _status,
  _decision,
  _reject,
  _payload,
  _payloadBack,
  _failure,
  _failureBack,
  _issue,
  _issueBack,
];
