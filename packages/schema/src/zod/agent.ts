import { z } from 'zod';
import type {
  AgentConfig,
  AgentWorkspace,
  Budget,
  CommunicationMode,
  FlowKind,
  FlowSpec,
  OrgConfig,
  OrgShape,
  ShellPolicy,
  ToolPolicy,
} from '../agent.js';
import { zAgentId, zModelSelector } from './common.js';
import type { NodeId } from '../common.js';
import { zApprovalSpec, zVerifierSpec } from './gate.js';
import { zInputBinding, zNodeType, zOutputPort } from './spec.js';

export const zShellPolicy = z.enum(['readonly', 'full']);

export const zToolPolicy = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()).optional(),
  shell: zShellPolicy.optional(),
});

export const zAgentWorkspace = z.object({
  writeScope: z.array(z.string()),
  branchPrefix: z.string().optional(),
});

export const zAgentNodeConfig = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().optional(),
  approval: z.boolean().optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  outputPath: z.string().optional(),
  doneCriteria: z.string().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  type: zNodeType.exclude(['delegate']).optional(),
  run: z.string().optional(),
  shell: z.enum(['pwsh', 'bash', 'sh', 'cmd']).optional(),
  workflow: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
  branches: z.object({
    whenTrue: z.array(z.string().transform((value) => value as NodeId)),
    whenFalse: z.array(z.string().transform((value) => value as NodeId)),
  }).optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
  intervalMs: z.number().int().min(0).max(60_000).optional(),
  itemsPath: z.string().optional(),
  maxConcurrency: z.number().int().min(1).max(32).optional(),
  verify: z.array(zVerifierSpec).optional(),
  inputs: z.array(zInputBinding).optional(),
  outputs: z.array(zOutputPort).optional(),
  artifactSchema: z.string().optional(),
  modelCapabilities: z.array(z.string()).optional(),
});

export const zBudget = z.object({
  perTaskUsd: z.number().nonnegative().optional(),
  perDayUsd: z.number().nonnegative().optional(),
  maxParallel: z.number().int().min(1).optional(),
});

export const zAgentConfig = z.object({
  id: zAgentId,
  name: z.string().min(1),
  parent: z.union([zAgentId, z.null()]),
  role: z.string().min(1),
  systemPrompt: z.string().optional(),
  model: zModelSelector,
  skills: z.array(z.string()),
  nodes: z.array(zAgentNodeConfig).optional(),
  tools: zToolPolicy,
  canDelegateTo: z.array(zAgentId).optional(),
  workspace: zAgentWorkspace.optional(),
  gates: z
    .object({
      taskGate: zApprovalSpec.optional(),
    })
    .optional(),
  budget: zBudget.optional(),
  memory: z.string().optional(),
});

export const zOrgShape = z.enum(['hierarchy', 'flat']);
export const zCommunicationMode = z.enum(['strict', 'peer']);
export const zFlowKind = z.enum(['delegate', 'question', 'report']);

export const zFlowSpec = z.object({
  from: zAgentId,
  to: zAgentId,
  kind: zFlowKind,
});

export const zOrgConfig = z.object({
  shape: zOrgShape,
  communication: zCommunicationMode,
  roots: z.array(zAgentId).min(1, '至少要有一个根 agent'),
  extraFlows: z.array(zFlowSpec).optional(),
});

/* ---------------- 漂移检查 ---------------- */

const _tool: ToolPolicy = {} as z.infer<typeof zToolPolicy>;
const _toolBack: z.infer<typeof zToolPolicy> = {} as ToolPolicy;
const _shell: ShellPolicy = {} as z.infer<typeof zShellPolicy>;
const _workspace: AgentWorkspace = {} as z.infer<typeof zAgentWorkspace>;
const _workspaceBack: z.infer<typeof zAgentWorkspace> = {} as AgentWorkspace;
const _budget: Budget = {} as z.infer<typeof zBudget>;
const _budgetBack: z.infer<typeof zBudget> = {} as Budget;
const _agent: AgentConfig = {} as z.infer<typeof zAgentConfig>;
const _agentBack: z.infer<typeof zAgentConfig> = {} as AgentConfig;
const _shape: OrgShape = {} as z.infer<typeof zOrgShape>;
const _comm: CommunicationMode = {} as z.infer<typeof zCommunicationMode>;
const _flowKind: FlowKind = {} as z.infer<typeof zFlowKind>;
const _flow: FlowSpec = {} as z.infer<typeof zFlowSpec>;
const _flowBack: z.infer<typeof zFlowSpec> = {} as FlowSpec;
const _org: OrgConfig = {} as z.infer<typeof zOrgConfig>;
const _orgBack: z.infer<typeof zOrgConfig> = {} as OrgConfig;

void [
  _tool,
  _toolBack,
  _shell,
  _workspace,
  _workspaceBack,
  _budget,
  _budgetBack,
  _agent,
  _agentBack,
  _shape,
  _comm,
  _flowKind,
  _flow,
  _flowBack,
  _org,
  _orgBack,
];
