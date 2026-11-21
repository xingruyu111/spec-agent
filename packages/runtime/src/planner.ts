/**
 * 受限规划器：目标 → 一个只含 llm 节点的 WorkflowSpec。
 *
 * 约束是刻意的：
 * - 模型只提节点职责和边，工具/写范围/类型由我们补，避免它生成 rm -rf；
 * - 生成的 spec 先加一个“确认工作流”人审节点，批准后才真正执行；
 * - 解析失败、有环、引用不存在的节点都直接拒绝，不做静默修补。
 */

import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import { artifactKindForPath } from '@spec-agent/core';
import type {
  AgentConfig,
  AgentId,
  LlmNode,
  NodeSpec,
  NodeId,
  ShellNode,
  Usage,
  WorkflowEdge,
  WorkflowSpec,
} from '@spec-agent/schema';
import { zWorkflowSpec } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';

export const PLAN_GATE_ID = 'plan-approval';

export type PlanOptions = {
  goal: string;
  agentRuntime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  /** 组织配置；提供时每个节点必须选择其中一个 agent */
  agents?: AgentConfig[];
  /** 任务 owner，未指定 agent 时的默认值 */
  defaultAgent?: string;
  maxNodes?: number;
  cwd?: string;
  signal?: AbortSignal;
  /** 项目级规划上限；缺省使用面向大型项目的默认值 */
  limits?: Partial<PlannerLimits>;
};

export type PlanResult = {
  spec: WorkflowSpec;
  usage?: Usage;
};

type CatalogNode = {
  id: string;
  agentId: string;
  node: NonNullable<AgentConfig['nodes']>[number];
};

export type PlannerLimits = {
  maxLayerNodes: number;
  maxTotalNodes: number;
  maxDepth: number;
  maxAgents: number;
};

export const DEFAULT_PLANNER_LIMITS: PlannerLimits = {
  maxLayerNodes: 16,
  maxTotalNodes: 128,
  maxDepth: 8,
  maxAgents: 32,
};

function resolveLimits(options: PlanOptions): PlannerLimits {
  return { ...DEFAULT_PLANNER_LIMITS, ...options.limits };
}

type LayerNode =
  | { kind: 'local'; id: string; template: NonNullable<AgentConfig['nodes']>[number] }
  | {
      kind: 'delegate';
      id: string;
      agentId: string;
      brief: string;
      deliverable: string;
    };

type LayerPlan = {
  nodes: LayerNode[];
  edges: WorkflowEdge[];
  /** 由规划器判断目标需要实际产出（execution）还是只需要分析/文档（advisory）。 */
  delivery: 'execution' | 'advisory';
};

type ExpandedLayer = {
  nodes: NodeSpec[];
  edges: WorkflowEdge[];
  roots: string[];
  sinks: string[];
};

function directReports(agents: AgentConfig[], agent: AgentConfig): AgentConfig[] {
  return agents.filter((candidate) => candidate.parent === agent.id);
}

function canPlanAgent(
  agents: AgentConfig[],
  agent: AgentConfig,
  seen = new Set<string>(),
): boolean {
  if ((agent.nodes?.length ?? 0) > 0) return true;
  if (seen.has(agent.id)) return false;
  seen.add(agent.id);
  return directReports(agents, agent).some((child) =>
    canPlanAgent(agents, child, seen),
  );
}

function addUsage(left: Usage | undefined, right: Usage | undefined): Usage {
  return {
    usd: (left?.usd ?? 0) + (right?.usd ?? 0),
    ...((left?.inputTokens !== undefined || right?.inputTokens !== undefined) && {
      inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
    }),
    ...((left?.outputTokens !== undefined || right?.outputTokens !== undefined) && {
      outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
    }),
  };
}

function makeGlobalNodeId(agentId: string, localId: string, used: Set<string>): string {
  let base = `${agentId}-${localId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `n-${base}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function buildLocalNode(
  agent: AgentConfig,
  template: NonNullable<AgentConfig['nodes']>[number],
  id: string,
  cwd: string,
  context = '',
): NodeSpec {
  const parts = [
    template.description,
    template.instructions,
    template.outputPath ? `输出文件：${template.outputPath}` : undefined,
    template.doneCriteria ? `完成标准：${template.doneCriteria}` : undefined,
    context ? `本次委派：${context}` : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  const outputs = template.outputs?.length
    ? template.outputs
    : template.outputPath
      ? [{
          name: 'output',
          kind: artifactKindForPath(template.outputPath!),
          path: template.outputPath,
          required: true,
          ...(template.artifactSchema ? { schema: template.artifactSchema } : {}),
        }]
      : [];
  const verification = [...(template.verify ?? [])];
  if (
    template.doneCriteria?.trim() &&
    !verification.some((verifier) => verifier.kind === 'judge')
  ) {
    verification.push({
      kind: 'judge',
      rubric: template.doneCriteria,
      threshold: 0.8,
      advisory: false,
    });
  }
  const base = {
    id: id as NodeId,
    description: template.name,
    inputs: template.inputs ?? [],
    outputs,
    ...(verification.length > 0 ? { verify: verification } : {}),
    ...(template.approval
      ? { approval: { approvers: ['human' as const] } }
      : {}),
  };
  const type = template.type ?? 'llm';

  if (type === 'llm') {
    return {
      ...base,
      type: 'llm',
      agent: agent.id as AgentId,
      instructions: sanitizeInstructions(
        Array.from(new Set(parts.map((part) => part.trim()))).join('\n\n'),
        cwd,
      ),
      tools: [],
      modelCapabilities: template.modelCapabilities,
      autoCommit: true,
      ...(template.maxTurns ? { maxTurns: template.maxTurns } : {}),
    };
  }

  if (type === 'subworkflow') {
    if (!template.workflow) missingNodeConfig(template, 'workflow');
    return {
      ...base,
      type: 'subworkflow',
      workflow: template.workflow!,
      params: template.params ?? {},
      autoCommit: false,
    };
  }

  if (type === 'fanout') {
    if (!template.itemsPath) missingNodeConfig(template, 'itemsPath');
    if (!template.run?.trim()) missingNodeConfig(template, 'run');
    return {
      ...base,
      type: 'fanout',
      itemsPath: template.itemsPath!,
      run: template.run!,
      shell: template.shell,
      brief: template.instructions?.trim() || template.description,
      agent: agent.id,
      maxConcurrency: template.maxConcurrency ?? 4,
      autoCommit: false,
    };
  }

  if (!template.run?.trim()) missingNodeConfig(template, 'run');
  if (type === 'condition') {
    return {
      ...base,
      type: 'condition',
      run: template.run!,
      shell: template.shell,
      branches: template.branches ?? { whenTrue: [], whenFalse: [] },
      autoCommit: false,
    };
  }
  if (type === 'loop') {
    return {
      ...base,
      type: 'loop',
      run: template.run!,
      shell: template.shell,
      maxIterations: template.maxIterations ?? 3,
      intervalMs: template.intervalMs,
      autoCommit: false,
    };
  }
  return {
    ...base,
    type,
    run: template.run!,
    shell: template.shell,
    autoCommit: type === 'shell',
  };
}

function missingNodeConfig(
  template: NonNullable<AgentConfig['nodes']>[number],
  field: string,
): never {
  throw new AppError(
    'E_NODE_CONFIG_INCOMPLETE',
    `节点 ${template.id} 的 ${template.type ?? 'llm'} 类型缺少 ${field}`,
  );
}

function layerPrompt(
  agent: AgentConfig,
  reports: AgentConfig[],
  goal: string,
  context: string,
  maxLayerNodes: number,
): string {
  const localNodes =
    agent.nodes?.length
      ? agent.nodes
          .map(
            (node) =>
              `- ${node.id}: ${node.name} [${node.type ?? 'llm'}] — ${node.description}`,
          )
          .join('\n')
      : '（当前 agent 没有本地节点）';
  const reportList =
    reports.length > 0
      ? reports
          .map(
            (report) =>
              `- ${report.id}: ${report.name} — ${report.role}；可组装节点：${
                report.nodes?.length
                  ? report.nodes
                      .map(
                        (node) =>
                          `${node.name}[${node.type ?? 'llm'}]（${node.description}）`,
                      )
                      .join('、')
                  : '无（可继续向自己的下属委派）'
              }`,
          )
          .join('\n')
      : '（没有直接下属）';

  return `你是层级工作流规划器。你只规划当前 agent 这一层，不规划孙子层。
总目标：${goal}
父级上下文：${context || '无'}

当前 agent：
- id: ${agent.id}
- 名称: ${agent.name}
- 职责: ${agent.role}

本地节点（只能使用这些 id）：
${localNodes}

直接下属（只有确实需要时才委派；可以一个都不选）：
${reportList}

只输出一个 JSON 对象：
{
  "delivery": "execution" 或 "advisory",
  "nodes": [
    { "kind": "local", "id": "本地节点 id" },
    { "kind": "delegate", "id": "分支别名", "agent": "直接下属 id", "brief": "交给它的任务", "deliverable": "它必须交付什么" }
  ],
  "edges": [["from-id", "to-id"]]
}

规则：
- 先判断 delivery，不要按项目名称或行业套模板：
  - execution：目标需要实际制作、实现、运行、测试、部署或交付可运行/可验收产物
  - advisory：目标只需要分析、建议、文档、评审或方案讨论
- 最多 ${maxLayerNodes} 个节点，至少 1 个
- local 只能使用当前 agent 的本地节点 id
- delegate 只能使用直接下属 id，不能使用孙子或自己
- 如果 delivery 是 execution，而当前 agent 的本地节点只覆盖分析/需求/规划/评审/文档，不能停在本地阶段；直接下属有对应执行节点时，必须把实际制作、实现、测试或交付委派出去，不要只输出分析或文档阶段
- 如果 delivery 是 advisory，只有目标确实需要该下属时才生成 delegate；不需要就省略
- 每个 delegate 必须有 brief 和 deliverable
- 节点 id 在当前层唯一；边只能引用本层节点，必须无环
- 优先并行；存在真实依赖时才连边
- 不要输出 description、instructions、agent、tools、审批等字段；这些由节点配置决定`;
}

function needsExecutionDelegation(
  reports: AgentConfig[],
  layer: LayerPlan,
): boolean {
  return (
    layer.delivery === 'execution' &&
    reports.length > 0 &&
    !layer.nodes.some((node) => node.kind === 'delegate')
  );
}

function parseLayerPlan(
  raw: RawPlan,
  agent: AgentConfig,
  reports: AgentConfig[],
  maxLayerNodes: number,
): LayerPlan {
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new AppError('E_PLAN_INVALID', `${agent.id} 没有生成任何节点`);
  }
  if (raw.nodes.length > maxLayerNodes) {
    throw new AppError(
      'E_PLAN_INVALID',
      `${agent.id} 单层节点过多：${raw.nodes.length}`,
    );
  }

  const localById = new Map((agent.nodes ?? []).map((node) => [node.id, node]));
  const reportById = new Map<string, AgentConfig>(
    reports.map((report) => [String(report.id), report]),
  );
  const usedTemplates = new Set<string>();
  const ids = new Set<string>();
  const nodes: LayerNode[] = raw.nodes.map((entry, index) => {
    const node = entry as Record<string, unknown>;
    const kind = String(node.kind ?? 'local');
    const id = String(node.id ?? '');
    if (!id || ids.has(id)) {
      throw new AppError('E_PLAN_INVALID', `${agent.id} 节点 id 不合法或重复：${id}`);
    }
    ids.add(id);

    if (kind === 'delegate') {
      const target = String(node.agent ?? '');
      if (!reportById.has(target)) {
        throw new AppError(
          'E_PLAN_INVALID',
          `${agent.id} 只能委派给直接下属，收到：${target || '空'}`,
        );
      }
      const brief = String(node.brief ?? '').trim();
      const deliverable = String(node.deliverable ?? '').trim();
      if (!brief || !deliverable) {
        throw new AppError(
          'E_PLAN_INVALID',
          `${agent.id} 的委派 ${target} 缺少 brief 或 deliverable`,
        );
      }
      return { kind: 'delegate', id, agentId: target, brief, deliverable };
    }

    const qualifiedPrefix = `${agent.id}-`;
    const templateId = id.startsWith(qualifiedPrefix)
      ? id.slice(qualifiedPrefix.length)
      : id;
    const template = localById.get(id) ?? localById.get(templateId);
    if (!template) {
      throw new AppError(
        'E_PLAN_INVALID',
        `${agent.id} 使用了未配置的本地节点：${id || `#${index}`}`,
      );
    }
    if (usedTemplates.has(template.id)) {
      throw new AppError(
        'E_PLAN_INVALID',
        `${agent.id} 的节点 ${template.id} 被重复使用`,
      );
    }
    usedTemplates.add(template.id);
    return { kind: 'local', id, template };
  });

  const edges = normalizeEdges(raw.edges, ids);
  assertAcyclic(ids, edges);
  return {
    nodes,
    edges,
    delivery: raw.delivery === 'execution' ? 'execution' : 'advisory',
  };
}

async function planLayer(
  options: PlanOptions,
  agent: AgentConfig,
  reports: AgentConfig[],
  goal: string,
  context: string,
  limits: PlannerLimits,
): Promise<{ layer: LayerPlan; usage?: Usage }> {
  const cwd = options.cwd ?? process.cwd();
  const output = await options.agentRuntime.run({
    systemPrompt: layerPrompt(
      agent,
      reports,
      goal,
      context,
      limits.maxLayerNodes,
    ),
    task: `总目标：${goal}\n\n当前负责：${agent.name}（${agent.id}）`,
    cwd,
    allowedTools: [],
    skills: [],
    provider: options.provider,
    model: options.model,
    budget: { maxTurns: 2, maxUsd: 0.2 },
    signal: options.signal ?? new AbortController().signal,
  });
  if (output.stopReason !== 'finished') {
    const detail = output.error?.message ? `：${output.error.message}` : '';
    throw new AppError(
      'E_PLAN_FAILED',
      `${agent.id} 的层级规划没有正常结束：${output.stopReason}${detail}`,
    );
  }
  if (!output.text) {
    throw new AppError('E_PLAN_INVALID', `${agent.id} 没有返回规划文本`);
  }
  const layer = parseLayerPlan(
    parseRawPlan(output.text),
    agent,
    reports,
    limits.maxLayerNodes,
  );
  return { layer, usage: output.usage };
}

async function expandLayer(
  options: PlanOptions,
  agents: AgentConfig[],
  agent: AgentConfig,
  goal: string,
  context: string,
  path: Set<string>,
  depth: number,
  used: Set<string>,
  totalAgents: { count: number },
  limits: PlannerLimits,
): Promise<ExpandedLayer & { usage?: Usage }> {
  if (depth > limits.maxDepth) {
    throw new AppError('E_PLAN_INVALID', `层级超过最大深度 ${limits.maxDepth}`);
  }
  if (path.has(agent.id)) {
    throw new AppError('E_PLAN_INVALID', `规划路径出现环：${agent.id}`);
  }
  if (totalAgents.count >= limits.maxAgents) {
    throw new AppError('E_PLAN_INVALID', `规划 agent 数超过上限 ${limits.maxAgents}`);
  }
  if (!canPlanAgent(agents, agent)) {
    throw new AppError(
      'E_PLAN_INVALID',
      `${agent.id} 没有节点库，也没有可继续委派的下属`,
    );
  }

  totalAgents.count += 1;
  const nextPath = new Set(path);
  nextPath.add(agent.id);
  const reports = directReports(agents, agent).filter(
    (report) =>
      canPlanAgent(agents, report) &&
      (!agent.canDelegateTo || agent.canDelegateTo.includes(report.id)),
  );
  let planned = await planLayer(options, agent, reports, goal, context, limits);
  let totalUsage = planned.usage;

  // 防止模型把 execution 型目标降级成纯分析/文档计划：首版完全没委派时，
  // 在存在直接下属的情况下强制重规划一次。
  if (needsExecutionDelegation(reports, planned.layer)) {
    const retry = await planLayer(
      options,
      agent,
      reports,
      goal,
      `${context}\n\n强制规划要求：上一版 delivery=execution，但没有委派任何直接下属。请重新判断目标需要的实际产出；如果直接下属拥有覆盖该产出的节点，必须委派，而不是只输出分析、文档或计划阶段。`,
      limits,
    );
    planned = retry;
    totalUsage = addUsage(totalUsage, retry.usage);
  }
  const { layer } = planned;

  const localIds = new Map<string, string>();
  const delegateExpansions = new Map<string, ExpandedLayer>();
  const nodes: NodeSpec[] = [];
  const edges: WorkflowEdge[] = [];

  for (const node of layer.nodes) {
    if (node.kind === 'local') {
      const globalId = makeGlobalNodeId(agent.id, node.template.id, used);
      localIds.set(node.id, globalId);
      nodes.push(
        buildLocalNode(
          agent,
          node.template,
          globalId,
          options.cwd ?? process.cwd(),
          context,
        ),
      );
    } else {
      const child = agents.find((candidate) => candidate.id === node.agentId);
      if (!child) {
        throw new AppError('E_PLAN_INVALID', `直接下属不存在：${node.agentId}`);
      }
      const expanded = await expandLayer(
        options,
        agents,
        child,
        goal,
        `委派任务：${node.brief}\n交付物：${node.deliverable}`,
        nextPath,
        depth + 1,
        used,
        totalAgents,
        limits,
      );
      delegateExpansions.set(node.id, expanded);
      nodes.push(...expanded.nodes);
      edges.push(...expanded.edges);
      totalUsage = addUsage(totalUsage, expanded.usage);
    }
  }

  // condition 模板里的分支 id 是 agent 本地 id；展开后必须映射到全局 id。
  for (const node of nodes) {
    if (node.type !== 'condition') continue;
    node.branches = {
      whenTrue: node.branches.whenTrue.map(
        (id) => (localIds.get(id) ?? id) as NodeId,
      ),
      whenFalse: node.branches.whenFalse.map(
        (id) => (localIds.get(id) ?? id) as NodeId,
      ),
    };
  }

  const addEdges = (from: string[], to: string[]): void => {
    for (const source of from) {
      for (const target of to) {
        if (source !== target && !edges.some((edge) => edge.from === source && edge.to === target)) {
          edges.push({ from: source as NodeId, to: target as NodeId });
        }
      }
    }
  };

  for (const edge of layer.edges) {
    const fromNode = layer.nodes.find((node) => node.id === edge.from)!;
    const toNode = layer.nodes.find((node) => node.id === edge.to)!;
    const from =
      fromNode.kind === 'local'
        ? [localIds.get(fromNode.id)!]
        : delegateExpansions.get(fromNode.id)!.sinks;
    const to =
      toNode.kind === 'local'
        ? [localIds.get(toNode.id)!]
        : delegateExpansions.get(toNode.id)!.roots;
    addEdges(from, to);
  }

  const incoming = new Set<string>(
    layer.edges.map((edge) => String(edge.to)),
  );
  const outgoing = new Set<string>(
    layer.edges.map((edge) => String(edge.from)),
  );
  const roots: string[] = [];
  const sinks: string[] = [];
  for (const node of layer.nodes) {
    const nodeRoots =
      node.kind === 'local'
        ? [localIds.get(node.id)!]
        : delegateExpansions.get(node.id)!.roots;
    const nodeSinks =
      node.kind === 'local'
        ? [localIds.get(node.id)!]
        : delegateExpansions.get(node.id)!.sinks;
    if (!incoming.has(node.id)) roots.push(...nodeRoots);
    if (!outgoing.has(node.id)) sinks.push(...nodeSinks);
  }
  if (roots.length === 0 || sinks.length === 0) {
    throw new AppError('E_PLAN_INVALID', `${agent.id} 的层级计划没有根或叶子`);
  }
  if (nodes.length > limits.maxTotalNodes) {
    throw new AppError(
      'E_PLAN_INVALID',
      `工作流节点超过上限 ${limits.maxTotalNodes}`,
    );
  }

  return {
    nodes,
    edges,
    roots: Array.from(new Set(roots)),
    sinks: Array.from(new Set(sinks)),
    usage: totalUsage,
  };
}

async function planHierarchicalWorkflow(
  options: PlanOptions,
): Promise<PlanResult> {
  const agents = options.agents ?? [];
  const owner =
    agents.find((agent) => agent.id === options.defaultAgent) ??
    agents.find((agent) => agent.parent === null);
  if (!owner) throw new AppError('E_PLAN_INVALID', '没有可用于规划的组织根节点');
  const limits = resolveLimits(options);
  const used = new Set<string>();
  const expanded = await expandLayer(
    options,
    agents,
    owner,
    options.goal,
    '',
    new Set(),
    0,
    used,
    { count: 0 },
    limits,
  );
  const spec: WorkflowSpec = {
    name: 'assembled',
    version: 1,
    description: options.goal,
    params: [],
    nodes: expanded.nodes,
    edges: expanded.edges,
  };
  return {
    spec: withPlanGate(spec, options.goal),
    usage: expanded.usage,
  };
}

function buildCatalog(agents: AgentConfig[] | undefined): CatalogNode[] {
  const catalog: CatalogNode[] = [];
  const used = new Set<string>();
  for (const agent of agents ?? []) {
    for (const node of agent.nodes ?? []) {
      let base = `${agent.id}-${node.id}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!/^[a-z]/.test(base)) base = `n-${base}`;
      let id = base;
      let suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
      used.add(id);
      catalog.push({ id, agentId: agent.id, node });
    }
  }
  return catalog;
}

function systemPrompt(
  maxNodes: number,
  catalog: CatalogNode[],
  defaultAgent?: string,
): string {
  if (catalog.length > 0) {
    const available = catalog
      .map(
        (entry) =>
          `- ${entry.id}: ${entry.node.name}（agent ${entry.agentId}）— ${entry.node.description}`,
      )
      .join('\n');
    return `你是工作流组装器。你只能从用户预配置的节点里选择并组装工作流，不能创建节点，不能改写节点职责、执行指令或 agent。
只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。

结构：
{
  "name": "short-slug",
  "description": "一句话说明",
  "nodes": [{ "id": "预配置节点 id" }],
  "edges": [["from-id", "to-id"]]
}

可用节点（id 必须原样使用）：
${available}

约束：
- 1 到 ${maxNodes} 个节点，只能使用上面列出的 id
- 不要输出 description、instructions、agent、tools 字段；这些由节点配置决定
- 边只能引用已存在的节点，必须是有向无环图
- 只选择完成目标真正需要的节点，可以少选，不能编造新节点
- 任务 owner 是 ${defaultAgent ?? '默认 agent'}；优先使用 owner 或其可委派下属的节点
- 优先把互不依赖的节点并行；需要前后依赖时再用 edges`;
  }

  return `你是工作流规划器。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。

结构：
{
  "name": "short-slug",
  "description": "一句话说明",
  "nodes": [
    { "id": "lowercase-id", "description": "一句话职责", "instructions": "给执行 agent 的具体指令" }
  ],
  "edges": [["from-id", "to-id"]]
}

约束：
- 1 到 ${maxNodes} 个节点
- id 只能用小写字母、数字、连字符，且以字母开头
- 边只能引用已存在的节点，必须是有向无环图
- 优先把可以并行的步骤拆成独立分支：例如两个互不依赖的交付分支可以接在同一个前置节点后，不要强行串成一条链
- 每个节点是一个独立的 llm 执行步骤；instructions 要具体、可执行、可验证
- 所有文件路径必须写成相对路径（例如 server/auth.js），**不要写绝对路径**，执行时的工作目录是任务 worktree
- 不要生成 shell、delegate、subworkflow 节点，不要写工具名和权限
- 节点职责要拆得足够小；宁可 4 个清楚的节点，不要 1 个巨大的节点`;
}

export async function planWorkflowWithUsage(
  options: PlanOptions,
): Promise<PlanResult> {
  if (options.agents?.some((agent) => (agent.nodes?.length ?? 0) > 0)) {
    return planHierarchicalWorkflow(options);
  }

  const cwd = options.cwd ?? process.cwd();
  const limits = resolveLimits(options);
  const maxNodes = Math.min(options.maxNodes ?? limits.maxTotalNodes, limits.maxTotalNodes);
  const catalog = buildCatalog(options.agents);
  const roster = options.agents?.length
    ? `\n\n组织角色：\n${options.agents
        .map((agent) => `- ${agent.id}: ${agent.role}`)
        .join('\n')}\n${
        catalog.length > 0
          ? '节点 agent 由预配置节点决定，不要输出 agent 字段。'
          : '每个节点必须带 "agent" 字段，值必须是上面某个 id；不要把节点分给同级。'
      }`
    : '';

  const output = await options.agentRuntime.run({
    systemPrompt:
      systemPrompt(maxNodes, catalog, options.defaultAgent) + roster,
    task: `目标：${options.goal}`,
    cwd,
    allowedTools: [],
    skills: [],
    provider: options.provider,
    model: options.model,
    budget: { maxTurns: 2, maxUsd: 0.2 },
    signal: options.signal ?? new AbortController().signal,
  });

  if (output.stopReason !== 'finished') {
    throw new AppError('E_PLAN_FAILED', `规划器没有正常结束：${output.stopReason}`);
  }
  if (!output.text) {
    throw new AppError('E_PLAN_INVALID', '规划器没有返回文本');
  }

  const raw = parseRawPlan(output.text);
  const spec = buildSpec(
    raw,
    options.goal,
    maxNodes,
    cwd,
    options.agents,
    options.defaultAgent,
    catalog,
  );
  return { spec: withPlanGate(spec, options.goal), usage: output.usage };
}

/** 只需 spec 的调用方；成本和 spec 一起返回用 planWorkflowWithUsage。 */
export async function planWorkflow(
  options: PlanOptions,
): Promise<WorkflowSpec> {
  return (await planWorkflowWithUsage(options)).spec;
}

type RawPlan = {
  name?: unknown;
  description?: unknown;
  delivery?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

function parseRawPlan(text: string): RawPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new AppError('E_PLAN_INVALID', '规划结果里找不到 JSON 对象');
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1)) as RawPlan;
  } catch (cause) {
    throw new AppError('E_PLAN_INVALID', '规划结果不是合法 JSON', { cause });
  }
}

function buildSpec(
  raw: RawPlan,
  goal: string,
  maxNodes: number,
  cwd: string,
  agents?: AgentConfig[],
  defaultAgent?: string,
  catalog: CatalogNode[] = [],
): WorkflowSpec {
  if (catalog.length > 0) {
    return buildCatalogSpec(
      raw,
      goal,
      maxNodes,
      cwd,
      agents,
      defaultAgent,
      catalog,
    );
  }

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new AppError('E_PLAN_INVALID', '规划结果没有节点');
  }
  if (raw.nodes.length > maxNodes) {
    throw new AppError('E_PLAN_INVALID', `节点过多：${raw.nodes.length} > ${maxNodes}`);
  }

  const ids = new Set<string>();
  const nodes: LlmNode[] = raw.nodes.map((entry, index) => {
    const node = entry as Record<string, unknown>;
    const id = String(node.id ?? '');
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new AppError('E_PLAN_INVALID', `节点 id 不合法：${id || `#${index}`}`);
    }
    if (id === PLAN_GATE_ID) {
      throw new AppError('E_PLAN_INVALID', `节点 id 与系统节点冲突：${id}`);
    }
    if (ids.has(id)) {
      throw new AppError('E_PLAN_INVALID', `节点 id 重复：${id}`);
    }
    ids.add(id);

    const description = String(node.description ?? '').trim();
    if (!description) {
      throw new AppError('E_PLAN_INVALID', `节点 ${id} 缺少 description`);
    }
    const instructions = sanitizeInstructions(
      String(node.instructions ?? description).trim(),
      cwd,
    );

    const agent = resolveAgent(
      typeof node.agent === 'string' ? node.agent : undefined,
      agents,
      defaultAgent,
    );

    return {
      id: id as NodeId,
      type: 'llm',
      ...(agent ? { agent: agent as AgentId } : {}),
      description,
      instructions,
      inputs: [],
      outputs: [],
      // 有组织配置时继承 agent 的工具/写范围；否则给一个安全的默认值
      tools: agent ? [] : ['Read', 'Write', 'Edit'],
      ...(agent ? {} : { writeScope: ['.'] }),
      autoCommit: true,
    };
  });

  const edges = normalizeEdges(raw.edges, ids);
  assertAcyclic(ids, edges);

  const spec: WorkflowSpec = {
    name: 'planned',
    version: 1,
    description: goal,
    params: [],
    nodes,
    edges,
  };

  const parsed = zWorkflowSpec.safeParse(spec);
  if (!parsed.success) {
    throw new AppError('E_PLAN_INVALID', '规划结果不符合 spec 结构', {
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function buildCatalogSpec(
  raw: RawPlan,
  goal: string,
  maxNodes: number,
  cwd: string,
  agents: AgentConfig[] | undefined,
  defaultAgent: string | undefined,
  catalog: CatalogNode[],
): WorkflowSpec {
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new AppError('E_PLAN_INVALID', '规划结果没有节点');
  }
  if (raw.nodes.length > maxNodes) {
    throw new AppError('E_PLAN_INVALID', `节点过多：${raw.nodes.length} > ${maxNodes}`);
  }

  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const ids = new Set<string>();
  const nodes: LlmNode[] = raw.nodes.map((entry, index) => {
    const node = entry as Record<string, unknown>;
    const id = String(node.id ?? '');
    const template = byId.get(id);
    if (!template) {
      throw new AppError(
        'E_PLAN_INVALID',
        `规划器使用了未配置的节点：${id || `#${index}`}`,
      );
    }
    if (ids.has(id)) {
      throw new AppError('E_PLAN_INVALID', `节点 id 重复：${id}`);
    }
    ids.add(id);

    const agent = resolveAgent(template.agentId, agents, defaultAgent);
    const instructionParts = [
      template.node.description,
      template.node.instructions,
      template.node.outputPath ? `输出文件：${template.node.outputPath}` : undefined,
      template.node.doneCriteria ? `完成标准：${template.node.doneCriteria}` : undefined,
    ].filter((part): part is string => Boolean(part?.trim()));
    const uniqueParts = Array.from(new Set(instructionParts.map((part) => part.trim())));
    const instructions = sanitizeInstructions(uniqueParts.join('\n\n'), cwd);

    return {
      id: id as NodeId,
      type: 'llm',
      ...(agent ? { agent: agent as AgentId } : {}),
      description: template.node.name,
      instructions,
      inputs: [],
      outputs: [],
      tools: [],
      autoCommit: true,
      ...(template.node.maxTurns ? { maxTurns: template.node.maxTurns } : {}),
      ...(template.node.approval
        ? { approval: { approvers: ['human' as const] } }
        : {}),
    };
  });

  const edges = normalizeEdges(raw.edges, ids);
  assertAcyclic(ids, edges);

  const spec: WorkflowSpec = {
    name: 'assembled',
    version: 1,
    description: goal,
    params: [],
    nodes,
    edges,
  };

  const parsed = zWorkflowSpec.safeParse(spec);
  if (!parsed.success) {
    throw new AppError('E_PLAN_INVALID', '组装结果不符合 spec 结构', {
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function sanitizeInstructions(value: string, cwd: string): string {
  let result = value.split(cwd).join('.');
  result = result.split(cwd.replace(/\\/g, '/')).join('.');

  // 执行发生在 worktree；绝对路径会把文件写到错误的位置，直接拒绝
  if (/[A-Za-z]:[\\/]/.test(result) || /file:\/\//i.test(result)) {
    throw new AppError('E_PLAN_INVALID', '节点指令包含绝对路径，拒绝执行');
  }
  return result;
}

function resolveAgent(
  requested: string | undefined,
  agents: AgentConfig[] | undefined,
  defaultAgent: string | undefined,
): string | undefined {
  if (!agents || agents.length === 0) return undefined;

  const fallback = defaultAgent ?? agents.find((agent) => agent.parent === null)?.id;
  const candidate = requested ?? fallback;
  if (!candidate || !agents.some((agent) => agent.id === candidate)) {
    throw new AppError('E_PLAN_INVALID', `规划指定了不存在的 agent：${candidate ?? '空'}`);
  }

  const owner = agents.find((agent) => agent.id === fallback);
  if (owner && candidate !== owner.id) {
    let current = agents.find((agent) => agent.id === candidate);
    let descendant = false;
    const seen = new Set<string>();
    while (current?.parent && !seen.has(current.id)) {
      if (current.parent === owner.id) {
        descendant = true;
        break;
      }
      seen.add(current.id);
      current = agents.find((agent) => agent.id === current!.parent);
    }
    if (!descendant) {
      throw new AppError(
        'E_PLAN_INVALID',
        `${owner.id} 不能把节点分配给 ${candidate}`,
      );
    }
  }
  return candidate;
}

function normalizeEdges(value: unknown, ids: Set<string>): WorkflowEdge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppError('E_PLAN_INVALID', 'edges 必须是数组');
  }

  const seen = new Set<string>();
  const edges: WorkflowEdge[] = [];

  for (const entry of value) {
    const pair = Array.isArray(entry)
      ? { from: entry[0], to: entry[1] }
      : (entry as { from?: unknown; to?: unknown });
    const from = String(pair.from ?? '');
    const to = String(pair.to ?? '');

    if (!ids.has(from) || !ids.has(to)) {
      throw new AppError('E_PLAN_INVALID', `边引用了不存在的节点：${from} → ${to}`);
    }
    if (from === to) {
      throw new AppError('E_PLAN_INVALID', `节点不能指向自己：${from}`);
    }
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from as NodeId, to: to as NodeId });
  }
  return edges;
}

function assertAcyclic(ids: Set<string>, edges: WorkflowEdge[]): void {
  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const edge of edges) outgoing.get(edge.from)!.push(edge.to);

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new AppError('E_PLAN_INVALID', `规划结果有环：${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of ids) visit(id);
}

/** 前置一个人审节点：批准后才执行规划出来的节点。 */
export function withPlanGate(spec: WorkflowSpec, goal: string): WorkflowSpec {
  const roots = spec.nodes.filter(
    (node) => !spec.edges.some((edge) => edge.to === node.id),
  );
  if (roots.length === 0) {
    throw new AppError('E_PLAN_INVALID', '规划结果没有根节点');
  }

  const gate: ShellNode = {
    id: PLAN_GATE_ID as NodeId,
    type: 'shell',
    description: `确认工作流：${goal.slice(0, 80)}`,
    inputs: [],
    outputs: [],
    run: 'node -e "process.exit(0)"',
    approval: { approvers: ['human'] },
  };

  const gated: WorkflowSpec = {
    ...spec,
    nodes: [gate, ...spec.nodes],
    edges: [
      ...roots.map((node) => ({ from: gate.id, to: node.id })),
      ...spec.edges,
    ],
  };

  const parsed = zWorkflowSpec.safeParse(gated);
  if (!parsed.success) {
    throw new AppError('E_PLAN_INVALID', '加上确认节点后 spec 不合法', {
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
