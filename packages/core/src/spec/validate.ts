/**
 * 7 道校验（design.md §11.3）。
 *
 *   1 Schema            结构合法
 *   2 引用              节点/端口/参数/边都能解析，无重复、无自环
 *   3 契约              上游产出类型能喂给下游输入，且确实在上游
 *   4 权限              writeScope / tools / delegate 目标
 *   5 预算              节点数与预估成本
 *   6 Lint              连通性、终端产物、路径缺失
 *   7 可验证性          终端产物必须挂自动闸门或人工闸门
 *
 * 原则：错误必须能定位到具体节点；schema / 引用 / 环失败时尽早返回，
 * 避免下游检查产生一堆噪音。
 */

import type {
  AgentConfig,
  ArtifactKind,
  NodeSpec,
  OrgConfig,
  ToolPolicy,
  ValidationIssue,
  VerifierSpec,
  WorkflowSpec,
} from '@spec-agent/schema';
import { zWorkflowSpec } from '@spec-agent/schema';
import { componentCount, indexGraph, isUpstream, topoSort } from './graph.js';

export type ValidationResult = {
  ok: boolean;
  spec?: WorkflowSpec;
  issues: ValidationIssue[];
};

export type ValidationContext = {
  /** 谁在组装这份 spec */
  agent: AgentConfig;
  agents: AgentConfig[];
  org: OrgConfig;
  /** 默认 12 */
  maxNodes?: number;
  budgetUsd?: number;
  estimatedCostUsd?: number;
};

type PortKind = ArtifactKind | 'string' | 'number' | 'boolean';

type ResolvedSource = {
  kind: PortKind;
  /** 来自节点时填，用于上游判定 */
  nodeId?: string;
};

const DEFAULT_MAX_NODES = 12;

export function validateWorkflowSpec(
  input: unknown,
  ctx: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  const parsed = zWorkflowSpec.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: 'E_SCHEMA',
        message: issue.message,
        path: toPointer(issue.path),
      });
    }
    return { ok: false, issues };
  }

  const spec = parsed.data;
  checkReferences(spec, ctx, issues);
  if (issues.length > 0) return { ok: false, spec, issues };

  const { cycle } = topoSort(spec);
  if (cycle.length > 0) {
    issues.push({
      code: 'E_CYCLE',
      message: `存在环：${cycle.join(' → ')}`,
    });
    return { ok: false, spec, issues };
  }

  checkContracts(spec, issues);
  checkPermissions(spec, ctx, issues);
  checkBudget(spec, ctx, issues);
  checkLint(spec, issues);
  checkVerifiability(spec, ctx, issues);

  return { ok: issues.length === 0, spec, issues };
}

/* ------------------------------------------------------------------ */
/* 1–2 引用                                                            */
/* ------------------------------------------------------------------ */

function checkReferences(
  spec: WorkflowSpec,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const nodeById = new Map<string, NodeSpec>();
  for (const node of spec.nodes) {
    const id = String(node.id);
    if (nodeById.has(id)) {
      issues.push({
        code: 'E_REFERENCE',
        message: `节点 id 重复：${id}`,
        nodeId: node.id,
      });
    }
    nodeById.set(id, node);
  }

  const paramNames = new Set<string>();
  for (const param of spec.params) {
    if (paramNames.has(param.name)) {
      issues.push({ code: 'E_REFERENCE', message: `参数重复：${param.name}` });
    }
    paramNames.add(param.name);
  }

  const edgeSeen = new Set<string>();
  for (const edge of spec.edges) {
    const from = String(edge.from);
    const to = String(edge.to);
    if (!nodeById.has(from)) {
      issues.push({ code: 'E_REFERENCE', message: `边引用了不存在的节点：${from}` });
    }
    if (!nodeById.has(to)) {
      issues.push({ code: 'E_REFERENCE', message: `边引用了不存在的节点：${to}` });
    }
    if (from === to) {
      issues.push({ code: 'E_REFERENCE', message: `节点不能连自己：${from}` });
    }
    const key = `${from}->${to}`;
    if (edgeSeen.has(key)) {
      issues.push({ code: 'E_REFERENCE', message: `重复的边：${from} → ${to}` });
    }
    edgeSeen.add(key);
  }

  for (const node of spec.nodes) {
    const inputNames = new Set<string>();
    for (const input of node.inputs) {
      if (inputNames.has(input.name)) {
        issues.push({
          code: 'E_REFERENCE',
          message: `输入名重复：${input.name}`,
          nodeId: node.id,
        });
      }
      inputNames.add(input.name);

      const ref = parseRef(input.from);

      if (ref.kind === 'param') {
        if (!paramNames.has(ref.name)) {
          issues.push({
            code: 'E_REFERENCE',
            message: `引用了不存在的参数：${ref.name}`,
            nodeId: node.id,
          });
        }
        continue;
      }

      const source = nodeById.get(ref.nodeId);
      if (!source) {
        issues.push({
          code: 'E_REFERENCE',
          message: `引用了不存在的节点：${ref.nodeId}`,
          nodeId: node.id,
        });
      } else if (!source.outputs.some((o) => o.name === ref.port)) {
        issues.push({
          code: 'E_REFERENCE',
          message: `节点 ${ref.nodeId} 没有输出端口 ${ref.port}`,
          nodeId: node.id,
        });
      }
    }

    const outputNames = new Set<string>();
    for (const output of node.outputs) {
      if (outputNames.has(output.name)) {
        issues.push({
          code: 'E_REFERENCE',
          message: `输出名重复：${output.name}`,
          nodeId: node.id,
        });
      }
      outputNames.add(output.name);
    }

    if (node.type === 'delegate' && !ctx.agents.some((a) => a.id === node.agent)) {
      issues.push({
        code: 'E_REFERENCE',
        message: `委派目标不存在：${node.agent}`,
        nodeId: node.id,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3 契约                                                              */
/* ------------------------------------------------------------------ */

function checkContracts(spec: WorkflowSpec, issues: ValidationIssue[]): void {
  for (const node of spec.nodes) {
    for (const input of node.inputs) {
      const source = resolveSource(spec, input.from);
      if (!source) continue;

      if (source.nodeId && !isUpstream(spec, source.nodeId, String(node.id))) {
        issues.push({
          code: 'E_CONTRACT_MISMATCH',
          message: `输入 ${input.name} 引用了非上游节点 ${source.nodeId}`,
          nodeId: node.id,
        });
      }

      if (input.kind && !canFeed(source.kind, input.kind)) {
        issues.push({
          code: 'E_CONTRACT_MISMATCH',
          message: `输入 ${input.name} 需要 ${input.kind}，但上游产出 ${source.kind}`,
          nodeId: node.id,
        });
      }
    }
  }
}

function resolveSource(spec: WorkflowSpec, ref: string): ResolvedSource | undefined {
  const parsed = parseRef(ref);

  if (parsed.kind === 'param') {
    const param = spec.params.find((p) => p.name === parsed.name);
    return param ? { kind: param.kind } : undefined;
  }

  const node = spec.nodes.find((n) => String(n.id) === parsed.nodeId);
  const port = node?.outputs.find((o) => o.name === parsed.port);
  return port ? { kind: port.kind, nodeId: parsed.nodeId } : undefined;
}

function canFeed(from: PortKind, to: PortKind): boolean {
  if (from === to) return true;
  if (to === 'text') return true;
  if (to === 'string') return from === 'text';
  return false;
}

/* ------------------------------------------------------------------ */
/* 4 权限                                                              */
/* ------------------------------------------------------------------ */

function checkPermissions(
  spec: WorkflowSpec,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const agent = ctx.agent;
  const allowedScopes = agent.workspace?.writeScope ?? [];

  for (const node of spec.nodes) {
    if (node.type === 'llm') {
      for (const scope of node.writeScope ?? []) {
        if (!allowedScopes.some((allowed) => isPathWithin(scope, allowed))) {
          issues.push({
            code: 'E_PERMISSION',
            message: `写入范围 ${scope} 超出该 agent 的权限`,
            nodeId: node.id,
          });
        }
      }
      for (const tool of node.tools) {
        if (!isToolAllowed(tool, agent.tools)) {
          issues.push({
            code: 'E_PERMISSION',
            message: `agent 没有工具权限：${tool}`,
            nodeId: node.id,
          });
        }
      }
    }

    if (node.type === 'shell' && agent.tools.shell === 'readonly') {
      issues.push({
        code: 'E_PERMISSION',
        message: 'agent 处于 readonly shell 模式，不能运行 shell 节点',
        nodeId: node.id,
      });
    }

    if (node.type === 'delegate') {
      const target = ctx.agents.find((a) => a.id === node.agent);
      if (!target) continue;
      const allowed = agent.canDelegateTo
        ? agent.canDelegateTo.includes(node.agent)
        : target.parent === agent.id;
      if (!allowed) {
        issues.push({
          code: 'E_PERMISSION',
          message: `不能委派给 ${node.agent}（既不在 canDelegateTo，也不是直接下属）`,
          nodeId: node.id,
        });
      }
    }
  }
}

function isPathWithin(target: string, scope: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = norm(target);
  const s = norm(scope);
  if (s === '' || s === '.') return true;
  return t === s || t.startsWith(`${s}/`);
}

function isToolAllowed(tool: string, policy: ToolPolicy): boolean {
  const matches = (pattern: string) => tool === pattern || tool.startsWith(`${pattern}:`);
  if ((policy.deny ?? []).some(matches)) return false;
  return (policy.allow ?? []).some(matches);
}

/* ------------------------------------------------------------------ */
/* 5 预算                                                              */
/* ------------------------------------------------------------------ */

function checkBudget(
  spec: WorkflowSpec,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const maxNodes = ctx.maxNodes ?? DEFAULT_MAX_NODES;
  if (spec.nodes.length > maxNodes) {
    issues.push({
      code: 'E_BUDGET',
      message: `节点数 ${spec.nodes.length} 超过上限 ${maxNodes}`,
    });
  }

  if (
    ctx.budgetUsd !== undefined &&
    ctx.estimatedCostUsd !== undefined &&
    ctx.estimatedCostUsd > ctx.budgetUsd * 0.8
  ) {
    issues.push({
      code: 'E_BUDGET',
      message: `预估成本 $${ctx.estimatedCostUsd.toFixed(2)} 超过预算的 80%（$${ctx.budgetUsd.toFixed(2)}）`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 6 Lint                                                              */
/* ------------------------------------------------------------------ */

function checkLint(spec: WorkflowSpec, issues: ValidationIssue[]): void {
  if (spec.nodes.length === 0) {
    issues.push({ code: 'E_LINT', message: 'spec 里没有任何节点' });
    return;
  }

  const components = componentCount(spec);
  if (components > 1) {
    issues.push({
      code: 'E_LINT',
      message: `图不连通：有 ${components} 个互不相连的部分`,
    });
  }

  const byId = new Map(spec.nodes.map((n) => [String(n.id), n]));
  for (const node of spec.nodes) {
    for (const output of node.outputs) {
      if ((output.kind === 'file' || output.kind === 'dir') && !output.path) {
        issues.push({
          code: 'E_LINT',
          message: `输出 ${output.name} 是 ${output.kind}，必须给 path`,
          nodeId: node.id,
        });
      }
    }
  }

  const { terminals } = indexGraph(spec);
  for (const id of terminals) {
    const node = byId.get(id);
    if (!node) continue;
    if (node.outputs.length === 0 && node.type !== 'delegate') {
      issues.push({
        code: 'E_LINT',
        message: '终端节点没有产物',
        nodeId: node.id,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 7 可验证性                                                          */
/* ------------------------------------------------------------------ */

function checkVerifiability(
  spec: WorkflowSpec,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const byId = new Map(spec.nodes.map((n) => [String(n.id), n]));
  const { terminals } = indexGraph(spec);

  for (const id of terminals) {
    const node = byId.get(id);
    if (!node) continue;
    if (hasGate(node, ctx)) continue;
    issues.push({
      code: 'E_UNVERIFIED_ARTIFACT',
      message: `终端节点 ${id} 既没有自动验证也没有人工闸门`,
      nodeId: node.id,
    });
  }
}

function hasGate(node: NodeSpec, ctx: ValidationContext): boolean {
  if (node.approval) return true;
  if (node.verify?.some(isBlockingVerifier)) return true;
  // shell 节点默认带 exit_code 闸门；显式写 verify: [] 视为关闭
  if (node.type === 'shell' && node.verify === undefined) return true;
  // delegate 的验证责任下推给子任务
  if (node.type === 'delegate') {
    const target = ctx.agents.find((a) => a.id === node.agent);
    if (target?.gates?.taskGate) return true;
  }
  return false;
}

/**
 * 只有"会拦住流程"的验证器才算闸门。
 * advisory 的 judge、mustPass: false 的 exit_code 都只是提示，
 * 不能拿来证明产物验过。
 */
function isBlockingVerifier(verifier: VerifierSpec): boolean {
  if (verifier.kind === 'exit_code') return verifier.mustPass !== false;
  return verifier.advisory !== true;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

type ParsedRef =
  | { kind: 'param'; name: string }
  | { kind: 'node'; nodeId: string; port: string };

/**
 * 解析 'param.x' / '<node>.<port>'。
 * 格式合法性由 zod 保证；这里做防御式切分，解析不出来就当节点名查不到，
 * 统一走 E_REFERENCE，不额外抛错。
 */
function parseRef(ref: string): ParsedRef {
  // 格式由 zod 的 zNodeRef 保证一定含且只含一个点，这里不再做分支判断。
  const index = ref.indexOf('.');
  const scope = ref.slice(0, index);
  const target = ref.slice(index + 1);
  if (scope === 'param') return { kind: 'param', name: target };
  return { kind: 'node', nodeId: scope, port: target };
}

function toPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '/';
  return `/${path.map((p) => String(p)).join('/')}`;
}
