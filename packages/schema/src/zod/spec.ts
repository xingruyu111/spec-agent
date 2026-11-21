import { z } from 'zod';
import type {
  DelegateNode,
  ConditionNode,
  FanoutNode,
  LoopNode,
  VerifyNode,
  InputBinding,
  LlmNode,
  NodeBase,
  NodeDefaults,
  NodeSpec,
  NodeType,
  OutputPort,
  RetryPolicy,
  ShellNode,
  SubworkflowNode,
  UiLayout,
  WorkflowEdge,
  WorkflowParam,
  WorkflowSpec,
  SpecMeta,
  ParamKind,
  SpecOrigin,
} from '../spec.js';
import type { NodeId } from '../common.js';
import { zAgentId, zArtifactKind, zDuration, zIsoDateTime, zModelSelector } from './common.js';
import { zApprovalSpec, zVerifierSpec } from './gate.js';

export const zNodeType = z.enum([
  'llm',
  'shell',
  'verify',
  'delegate',
  'subworkflow',
  'condition',
  'loop',
  'fanout',
]);
export const zRetryPolicy = z.enum(['never', 'on_failure', 'on_crash']);
export const zNodeRef = z
  .string()
  .regex(
    /^(param|[A-Za-z][A-Za-z0-9_-]{0,63})\.[A-Za-z][A-Za-z0-9_-]{0,63}$/,
    '引用格式应为 param.<name> 或 <nodeId>.<portName>',
  );

export const zInputBinding = z.object({
  name: z.string().min(1),
  from: zNodeRef,
  kind: zArtifactKind.optional(),
  required: z.boolean().optional(),
});

export const zOutputPort = z.object({
  name: z.string().min(1),
  kind: zArtifactKind,
  path: z.string().optional(),
  schema: z.string().optional(),
  required: z.boolean().optional(),
});

/** 节点 id 既要是 branded，也要受命名规则约束。 */
const zNodeIdStrict = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, '节点 id 只能包含字母、数字、下划线和短横线')
  .transform((v) => v as NodeId);

const nodeBaseShape = {
  id: zNodeIdStrict,
  description: z.string().min(1),
  inputs: z.array(zInputBinding),
  outputs: z.array(zOutputPort),
  timeout: zDuration.optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryPolicy: zRetryPolicy.optional(),
  verify: z.array(zVerifierSpec).optional(),
  approval: zApprovalSpec.optional(),
  autoCommit: z.boolean().optional(),
};

const nodeBase = z.object(nodeBaseShape);

export const zLlmNode = nodeBase.extend({
  type: z.literal('llm'),
  agent: zAgentId.optional(),
  instructions: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()),
  writeScope: z.array(z.string()).optional(),
  model: z.union([z.literal('inherit'), zModelSelector]).optional(),
  modelCapabilities: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
});

export const zShellNode = nodeBase.extend({
  type: z.literal('shell'),
  run: z.string().min(1),
  shell: z.enum(['pwsh', 'bash', 'sh', 'cmd']).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const zDelegateNode = nodeBase.extend({
  type: z.literal('delegate'),
  agent: zAgentId,
  brief: z.string().min(1),
  base: z.string().optional(),
});

export const zSubworkflowNode = nodeBase.extend({
  type: z.literal('subworkflow'),
  workflow: z.string().min(1),
  params: z.record(z.string(), zNodeRef),
});

export const zVerifyNode = zShellNode.extend({ type: z.literal('verify') });

export const zConditionNode = nodeBase.extend({
  type: z.literal('condition'),
  run: z.string().min(1),
  shell: z.enum(['pwsh', 'bash', 'sh', 'cmd']).optional(),
  branches: z.object({
    whenTrue: z.array(zNodeIdStrict),
    whenFalse: z.array(zNodeIdStrict),
  }),
});

export const zLoopNode = nodeBase.extend({
  type: z.literal('loop'),
  run: z.string().min(1),
  shell: z.enum(['pwsh', 'bash', 'sh', 'cmd']).optional(),
  maxIterations: z.number().int().min(1).max(100),
  intervalMs: z.number().int().min(0).max(60_000).optional(),
});

export const zFanoutNode = nodeBase.extend({
  type: z.literal('fanout'),
  itemsPath: z.string().min(1),
  run: z.string().min(1),
  shell: z.enum(['pwsh', 'bash', 'sh', 'cmd']).optional(),
  brief: z.string().min(1),
  agent: zAgentId.optional(),
  maxConcurrency: z.number().int().min(1).max(32).optional(),
});

export const zNodeSpec = z.discriminatedUnion('type', [
  zLlmNode,
  zShellNode,
  zVerifyNode,
  zDelegateNode,
  zSubworkflowNode,
  zConditionNode,
  zLoopNode,
  zFanoutNode,
]);

export const zWorkflowEdge = z.object({
  from: zNodeIdStrict,
  to: zNodeIdStrict,
});

export const zParamKind = z.enum([
  'file',
  'dir',
  'text',
  'json',
  'diff',
  'image',
  'audio',
  'video',
  'binary',
  'string',
  'number',
  'boolean',
]);

export const zWorkflowParam = z.object({
  name: z.string().min(1),
  kind: zParamKind,
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export const zNodeDefaults = z.object({
  model: z.union([z.literal('inherit'), zModelSelector]).optional(),
  timeout: zDuration.optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryPolicy: zRetryPolicy.optional(),
});

export const zSpecOrigin = z.enum(['template', 'assembled', 'promoted']);

export const zSpecMeta = z.object({
  origin: zSpecOrigin,
  createdBy: zAgentId.optional(),
  basedOn: z.string().optional(),
  createdAt: zIsoDateTime.optional(),
});

export const zUiLayout = z.object({
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  zoom: z.number().positive().optional(),
});

export const zWorkflowSpec = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().optional(),
  params: z.array(zWorkflowParam),
  nodes: z.array(zNodeSpec),
  edges: z.array(zWorkflowEdge),
  defaults: zNodeDefaults.optional(),
  ui: zUiLayout.optional(),
  meta: zSpecMeta.optional(),
});

/* ---------------- 漂移检查 ---------------- */

const _input: InputBinding = {} as z.infer<typeof zInputBinding>;
const _inputBack: z.infer<typeof zInputBinding> = {} as InputBinding;
const _output: OutputPort = {} as z.infer<typeof zOutputPort>;
const _outputBack: z.infer<typeof zOutputPort> = {} as OutputPort;
const _base: NodeBase = {} as z.infer<typeof nodeBase>;
const _baseBack: z.infer<typeof nodeBase> = {} as NodeBase;
const _llm: LlmNode = {} as z.infer<typeof zLlmNode>;
const _llmBack: z.infer<typeof zLlmNode> = {} as LlmNode;
const _shell: ShellNode = {} as z.infer<typeof zShellNode>;
const _shellBack: z.infer<typeof zShellNode> = {} as ShellNode;
const _delegate: DelegateNode = {} as z.infer<typeof zDelegateNode>;
const _delegateBack: z.infer<typeof zDelegateNode> = {} as DelegateNode;
const _sub: SubworkflowNode = {} as z.infer<typeof zSubworkflowNode>;
const _subBack: z.infer<typeof zSubworkflowNode> = {} as SubworkflowNode;
const _node: NodeSpec = {} as z.infer<typeof zNodeSpec>;
const _nodeBack: z.infer<typeof zNodeSpec> = {} as NodeSpec;
const _type: NodeType = {} as z.infer<typeof zNodeType>;
const _retry: RetryPolicy = {} as z.infer<typeof zRetryPolicy>;
const _edge: WorkflowEdge = {} as z.infer<typeof zWorkflowEdge>;
const _edgeBack: z.infer<typeof zWorkflowEdge> = {} as WorkflowEdge;
const _param: WorkflowParam = {} as z.infer<typeof zWorkflowParam>;
const _paramBack: z.infer<typeof zWorkflowParam> = {} as WorkflowParam;
const _paramKind: ParamKind = {} as z.infer<typeof zParamKind>;
const _defaults: NodeDefaults = {} as z.infer<typeof zNodeDefaults>;
const _defaultsBack: z.infer<typeof zNodeDefaults> = {} as NodeDefaults;
const _meta: SpecMeta = {} as z.infer<typeof zSpecMeta>;
const _metaBack: z.infer<typeof zSpecMeta> = {} as SpecMeta;
const _origin: SpecOrigin = {} as z.infer<typeof zSpecOrigin>;
const _ui: UiLayout = {} as z.infer<typeof zUiLayout>;
const _uiBack: z.infer<typeof zUiLayout> = {} as UiLayout;
const _spec: WorkflowSpec = {} as z.infer<typeof zWorkflowSpec>;
const _specBack: z.infer<typeof zWorkflowSpec> = {} as WorkflowSpec;

void [
  _input,
  _inputBack,
  _output,
  _outputBack,
  _base,
  _baseBack,
  _llm,
  _llmBack,
  _shell,
  _shellBack,
  _delegate,
  _delegateBack,
  _sub,
  _subBack,
  _node,
  _nodeBack,
  _type,
  _retry,
  _edge,
  _edgeBack,
  _param,
  _paramBack,
  _paramKind,
  _defaults,
  _defaultsBack,
  _meta,
  _metaBack,
  _origin,
  _ui,
  _uiBack,
  _spec,
  _specBack,
];
