/**
 * 项目级计划器。
 *
 * 与任务 planner 不同：这里只拆 workstream / milestone / 依赖，不生成节点。
 * 每个 workstream 之后仍走自己的层级 planner，因此不会把项目类型写死。
 */

import type { AgentConfig, Usage } from '@spec-agent/schema';
import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import { AppError } from '@spec-agent/kernel';

export type ProjectPlanDraftItem = {
  title: string;
  goal: string;
  assignee: string;
  milestone: string;
  dependsOn: string[];
  /** 可选独立仓库绝对路径；空值使用项目默认仓库 */
  repoPath?: string;
};

export type ProjectPlanDraft = {
  title: string;
  items: ProjectPlanDraftItem[];
  usage?: Usage;
};

export type PlanProjectOptions = {
  goal: string;
  agentRuntime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  agents: AgentConfig[];
  defaultAgent?: string;
  cwd?: string;
  signal?: AbortSignal;
  maxWorkstreams?: number;
};

const MAX_WORKSTREAMS = 16;

/** 让模型按交付与依赖拆项目，不按行业/项目类型拆。 */
export async function planProject(
  options: PlanProjectOptions,
): Promise<ProjectPlanDraft> {
  const goal = options.goal.trim();
  if (!goal) throw new AppError('E_GOAL_REQUIRED', 'goal 不能为空');
  if (goal.length > 4000) {
    throw new AppError('E_GOAL_TOO_LONG', 'goal 最多 4000 字');
  }
  if (options.agents.length === 0) {
    throw new AppError('E_ORG_REQUIRED', '项目计划需要至少一个 agent');
  }

  const maxWorkstreams = Math.min(
    Math.max(options.maxWorkstreams ?? MAX_WORKSTREAMS, 1),
    MAX_WORKSTREAMS,
  );
  const roster = options.agents
    .map(
      (agent) =>
        `- ${agent.id}: ${agent.name} / ${agent.role}；parent=${
          agent.parent ?? 'null'
        }；可委派=${
          agent.canDelegateTo?.join(',') || '未限制'
        }；节点=${
          agent.nodes?.length
            ? agent.nodes
                .map((node) => `${node.name}（${node.description}）`)
                .join('、')
            : '无'
        }`,
    )
    .join('\n');
  const defaultAgent =
    options.defaultAgent ??
    options.agents.find((agent) => agent.parent === null)?.id ??
    options.agents[0]!.id;

  const output = await options.agentRuntime.run({
    systemPrompt: `你是项目计划器。把用户目标拆成 1-${maxWorkstreams} 个可执行的 workstream，并标出 milestone 与真实依赖。

要求：
- 先判断目标最终需要哪些可验收交付物、能力和阶段，不要按项目名称、行业或模板套固定流程。
- 一个 workstream 应该能独立分派给一个 agent，并有清晰的交付物。
- assignee 必须使用组织里的 agent id；优先使用最接近该交付物的 agent，不要为了完整把所有 agent 都塞进来。
- 如果目标需要实际制作/实现/运行/测试，而 owner 只有分析/文档节点，应该把执行型 workstream 分给有对应节点的下属。
- milestone 是阶段名，可用 M1/M2/...，但内容要能说明该阶段产出。
- dependsOn 只放真实前置 workstream 的 id；不要制造不存在的依赖，不能成环。
- 只有用户明确给出某个 workstream 的独立仓库绝对路径时才写 repoPath；否则省略，使用项目默认仓库。
- 不要输出节点、工具、instructions；后续任务 planner 会为每个 workstream 生成具体工作流。

只输出 JSON：
{
  "title": "项目计划标题",
  "workstreams": [
    {
      "id": "ws-1",
      "title": "工作流标题",
      "brief": "交给这个 agent 的目标、边界和交付物",
      "assignee": "agent id",
      "milestone": "M1 阶段名",
      "repoPath": "可选：该 workstream 的独立仓库绝对路径",
      "dependsOn": []
    }
  ]
}

组织：
${roster}

默认 owner/协调者：${defaultAgent}`,
    task: `总目标：${goal}`,
    cwd: options.cwd ?? process.cwd(),
    allowedTools: [],
    skills: [],
    provider: options.provider,
    model: options.model,
    budget: { maxTurns: 2, maxUsd: 0.3 },
    signal: options.signal ?? new AbortController().signal,
  });

  if (output.stopReason !== 'finished') {
    throw new AppError(
      'E_PROJECT_PLAN_FAILED',
      `项目计划没有正常结束：${output.stopReason}`,
    );
  }
  if (!output.text) {
    throw new AppError('E_PROJECT_PLAN_INVALID', '项目计划没有返回文本');
  }

  const raw = parseDraft(output.text);
  const items = validateProjectPlanDraft(
    raw,
    options.agents,
    defaultAgent,
    maxWorkstreams,
  );
  return {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : goal.slice(0, 80),
    items,
    usage: output.usage,
  };
}

function parseDraft(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new AppError('E_PROJECT_PLAN_INVALID', '项目计划里找不到 JSON 对象');
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (!isRecord(parsed)) throw new Error('not object');
    return parsed;
  } catch (cause) {
    throw new AppError('E_PROJECT_PLAN_INVALID', '项目计划不是合法 JSON', {
      cause,
    });
  }
}

/** 校验并规范化项目计划草案；LLM planner 与聊天草案共用。 */
export function validateProjectPlanDraft(
  value: unknown,
  agents: AgentConfig[],
  defaultAgent: string,
  maxWorkstreams = MAX_WORKSTREAMS,
): ProjectPlanDraftItem[] {
  if (!isRecord(value)) {
    throw new AppError('E_PROJECT_PLAN_INVALID', '项目计划必须是对象');
  }
  return normalizeDraftItems(value, agents, defaultAgent, maxWorkstreams);
}

function normalizeDraftItems(
  raw: Record<string, unknown>,
  agents: AgentConfig[],
  defaultAgent: string,
  maxWorkstreams: number,
): ProjectPlanDraftItem[] {
  const list = raw.workstreams;
  if (!Array.isArray(list) || list.length === 0) {
    throw new AppError('E_PROJECT_PLAN_INVALID', '项目计划没有 workstream');
  }
  if (list.length > maxWorkstreams) {
    throw new AppError(
      'E_PROJECT_PLAN_INVALID',
      `workstream 超过上限 ${maxWorkstreams}`,
    );
  }

  const byAgent = new Map(agents.map((agent) => [String(agent.id), agent]));
  const ids = new Set<string>();
  const originalIds: string[] = [];
  const items = list.map((entry, index): ProjectPlanDraftItem => {
    if (!isRecord(entry)) {
      throw new AppError('E_PROJECT_PLAN_INVALID', `workstream ${index + 1} 不是对象`);
    }
    const id = normalizeId(entry.id, index, ids);
    originalIds.push(id);
    const title = text(entry.title);
    const brief = text(entry.brief) || title;
    const assignee = text(entry.assignee) || defaultAgent;
    if (!byAgent.has(assignee)) {
      throw new AppError(
        'E_PROJECT_PLAN_INVALID',
        `workstream ${id} 的 assignee 不在组织里：${assignee}`,
      );
    }
    const milestone = text(entry.milestone) || 'M1';
    const dependsOn = Array.isArray(entry.dependsOn)
      ? entry.dependsOn
          .map((value) => String(value))
          .filter((value) => value.length > 0)
      : [];
    return {
      title: title || `Workstream ${index + 1}`,
      goal: brief,
      assignee,
      milestone,
      dependsOn,
      ...(text(entry.repoPath) ? { repoPath: text(entry.repoPath) } : {}),
    };
  });

  const canonical = new Map(originalIds.map((id, index) => [id, `ws-${index + 1}`]));
  const canonicalIds = new Set(canonical.values());
  for (const [index, item] of items.entries()) {
    item.dependsOn = item.dependsOn.map((dep) => canonical.get(dep) ?? dep);
    const self = `ws-${index + 1}`;
    for (const dep of item.dependsOn) {
      if (dep === self) {
        throw new AppError('E_PROJECT_PLAN_INVALID', `${self} 不能依赖自己`);
      }
      if (!canonicalIds.has(dep)) {
        throw new AppError('E_PROJECT_PLAN_INVALID', `${self} 依赖不存在的 ${dep}`);
      }
    }
  }
  assertAcyclic(items);
  return items;
}

function normalizeId(value: unknown, index: number, ids: Set<string>): string {
  const proposed = typeof value === 'string' && value.trim() ? value.trim() : `ws-${index + 1}`;
  if (ids.has(proposed)) {
    throw new AppError('E_PROJECT_PLAN_INVALID', `workstream id 重复：${proposed}`);
  }
  ids.add(proposed);
  return proposed;
}

function assertAcyclic(items: ProjectPlanDraftItem[]): void {
  const graph = new Map<string, string[]>();
  items.forEach((item, index) => graph.set(`ws-${index + 1}`, item.dependsOn));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new AppError('E_PROJECT_PLAN_INVALID', 'workstream 依赖存在环');
    }
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
