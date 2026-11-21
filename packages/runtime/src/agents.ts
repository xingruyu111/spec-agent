/**
 * agents.yaml 加载与组织校验。
 *
 * 配置是产品的一部分，所以宁可启动时失败，也不要在运行时静默降级。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentConfig, AgentId } from '@spec-agent/schema';
import { zAgentConfig } from '@spec-agent/schema';
import { parse, stringify } from 'yaml';
import { AppError } from '@spec-agent/kernel';

export function agentsPath(root: string): string {
  return join(root, '.spec-agent', 'agents.yaml');
}

export function loadAgents(root: string): AgentConfig[] | undefined {
  const path = agentsPath(root);
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new AppError('E_AGENT_CONFIG', `读取 agents.yaml 失败：${path}`, { cause });
  }
  return parseAgents(raw);
}

export function saveAgents(root: string, agents: AgentConfig[]): AgentConfig[] {
  const validated = parseAgents({ agents });
  const path = agentsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify({ agents: validated }, { lineWidth: 0 }), 'utf8');
  return validated;
}

export function parseAgents(raw: unknown): AgentConfig[] {
  const entries = toEntries(raw);
  if (entries.length === 0) {
    throw new AppError('E_AGENT_CONFIG', 'agents 配置不能为空');
  }

  const agents = entries.map((entry, index) => {
    const input = entry as Record<string, unknown>;
    const id = String(input.id ?? '');
    const normalized = {
      ...input,
      id,
      name: input.name ?? id,
      parent: input.parent ?? null,
      role: input.role ?? input.description ?? '执行任务',
      model: input.model ?? { provider: 'inherit', model: 'inherit' },
      skills: input.skills ?? [],
      nodes: input.nodes ?? [],
      tools: input.tools ?? { allow: ['Read', 'Write', 'Edit'], shell: 'readonly' },
      workspace: input.workspace ?? { writeScope: ['.'] },
    };

    const parsed = zAgentConfig.safeParse(normalized);
    if (!parsed.success) {
      throw new AppError('E_AGENT_CONFIG', `agent 配置不合法：#${index}`, {
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  });

  validateOrg(agents);
  return agents;
}

export function agentMap(agents: AgentConfig[]): Map<string, AgentConfig> {
  return new Map(agents.map((agent) => [agent.id, agent]));
}

function toEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;

  const input = raw as { agents?: unknown } | null;
  if (Array.isArray(input?.agents)) return input.agents as unknown[];

  if (input?.agents && typeof input.agents === 'object') {
    return Object.entries(input.agents as Record<string, unknown>).map(
      ([id, value]) => ({ id, ...(value as Record<string, unknown>) }),
    );
  }
  return [];
}

function validateOrg(agents: AgentConfig[]): void {
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw new AppError('E_AGENT_CONFIG', `agent id 重复：${agent.id}`);
    }
    ids.add(agent.id);
  }

  for (const agent of agents) {
    if (agent.parent === agent.id) {
      throw new AppError('E_AGENT_CONFIG', `agent 不能以自己为父：${agent.id}`);
    }
    if (agent.parent && !ids.has(agent.parent)) {
      throw new AppError('E_AGENT_CONFIG', `父 agent 不存在：${agent.parent}`);
    }
    for (const target of agent.canDelegateTo ?? []) {
      if (!ids.has(target)) {
        throw new AppError('E_AGENT_CONFIG', `委派目标不存在：${target}`);
      }
    }
  }

  // 沿 parent 链检查环
  for (const agent of agents) {
    const seen = new Set<string>();
    let current: AgentConfig | undefined = agent;
    while (current?.parent) {
      if (seen.has(current.id)) {
        throw new AppError('E_AGENT_CONFIG', `组织树有环：${agent.id}`);
      }
      seen.add(current.id);
      current = agents.find((candidate) => candidate.id === current!.parent);
    }
  }

  if (!agents.some((agent) => agent.parent === null)) {
    throw new AppError('E_AGENT_CONFIG', '组织树至少要有一个根 agent');
  }
}

/** 直接子 agent；没有显式 canDelegateTo 时的默认委派范围。 */
export function childrenOf(agents: AgentConfig[], parent: AgentId): AgentId[] {
  return agents
    .filter((agent) => agent.parent === parent)
    .map((agent) => agent.id);
}

