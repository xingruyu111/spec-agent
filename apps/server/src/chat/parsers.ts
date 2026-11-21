import { AppError } from '@spec-agent/kernel';
import { parseAgents } from '@spec-agent/runtime';
import type { AgentConfig } from '@spec-agent/schema';
import type { TaskRow } from '@spec-agent/core';

function assertChatNodeConfig(node: unknown, label: string): void {
  if (!node || typeof node !== 'object') {
    throw new AppError('E_CHANGE_SET_INVALID', `${label} 必须是对象`);
  }
  const record = node as Record<string, unknown>;
  const outputPath =
    typeof record.outputPath === 'string' ? record.outputPath.trim() : '';
  const doneCriteria =
    typeof record.doneCriteria === 'string' ? record.doneCriteria.trim() : '';
  if (!outputPath || !doneCriteria) {
    throw new AppError(
      'E_NODE_CONFIG_INCOMPLETE',
      `${label} 必须配置 outputPath 和 doneCriteria`,
    );
  }
}

export function applyOperations(
  current: AgentConfig[],
  operations: unknown[],
): AgentConfig[] {
  const next = structuredClone(current) as AgentConfig[];
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') {
      throw new AppError('E_CHANGE_SET_INVALID', '变更操作必须是对象');
    }
    const op = raw as Record<string, unknown>;
    switch (op.op) {
      case 'upsert_agent': {
        const agent = op.agent;
        if (!agent || typeof agent !== 'object') {
          throw new AppError('E_CHANGE_SET_INVALID', 'upsert_agent 缺少 agent');
        }
        const record = structuredClone(agent) as Record<string, unknown>;
        if (record.parent === 'root' || record.parent === '') record.parent = null;
        const id = String(record.id ?? '').trim();
        if (!id) throw new AppError('E_CHANGE_SET_INVALID', 'agent.id 不能为空');
        if (Array.isArray(record.nodes)) {
          for (const node of record.nodes) {
            assertChatNodeConfig(node, `agent ${id} 的节点`);
          }
        }
        const index = next.findIndex((entry) => entry.id === id);
        if (index >= 0) next[index] = record as unknown as AgentConfig;
        else next.push(record as unknown as AgentConfig);
        break;
      }
      case 'delete_agent': {
        const id = String(op.id ?? '');
        const index = next.findIndex((entry) => entry.id === id);
        if (index < 0) throw new AppError('E_CHANGE_SET_INVALID', `agent 不存在：${id}`);
        next.splice(index, 1);
        break;
      }
      case 'upsert_node': {
        const agentId = String(op.agentId ?? '');
        const agent = next.find((entry) => entry.id === agentId);
        if (!agent) throw new AppError('E_CHANGE_SET_INVALID', `agent 不存在：${agentId}`);
        if (!op.node || typeof op.node !== 'object') {
          throw new AppError('E_CHANGE_SET_INVALID', 'upsert_node 缺少 node');
        }
        const node = structuredClone(op.node) as Record<string, unknown>;
        assertChatNodeConfig(node, `agent ${agentId} 的节点`);
        const nodeId = String(node.id ?? '').trim();
        if (!nodeId) throw new AppError('E_CHANGE_SET_INVALID', 'node.id 不能为空');
        agent.nodes = agent.nodes ?? [];
        const index = agent.nodes.findIndex((entry) => entry.id === nodeId);
        const cast = node as unknown as NonNullable<AgentConfig['nodes']>[number];
        if (index >= 0) agent.nodes[index] = cast;
        else agent.nodes.push(cast);
        break;
      }
      case 'delete_node': {
        const agentId = String(op.agentId ?? '');
        const nodeId = String(op.nodeId ?? '');
        const agent = next.find((entry) => entry.id === agentId);
        if (!agent) throw new AppError('E_CHANGE_SET_INVALID', `agent 不存在：${agentId}`);
        agent.nodes = (agent.nodes ?? []).filter((node) => node.id !== nodeId);
        break;
      }
      default:
        throw new AppError(
          'E_CHANGE_SET_INVALID',
          `不支持的变更操作：${String(op.op)}`,
        );
    }
  }
  return parseAgents({ agents: next });
}

export function parseChangeBlock(text: string): {
  text: string;
  change?: { summary: string; operations: unknown[] };
} {
  const match = /```hive-change\s*([\s\S]*?)```/i.exec(text);
  if (!match) return { text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch {
    return { text };
  }
  if (!parsed || typeof parsed !== 'object') return { text };
  const record = parsed as { summary?: unknown; operations?: unknown };
  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    return { text };
  }
  return {
    text: text.replace(match[0], '').trim(),
    change: {
      summary:
        typeof record.summary === 'string' && record.summary.trim()
          ? record.summary.trim()
          : '配置变更草案',
      operations: record.operations.slice(0, 20),
    },
  };
}

export function parseProjectPlanBlock(text: string): {
  text: string;
  value: Record<string, unknown>;
} | undefined {
  const match = /```hive-project-plan\s*([\s\S]*?)```/i.exec(text);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch {
    throw new AppError('E_PROJECT_PLAN_INVALID', 'hive-project-plan 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('E_PROJECT_PLAN_INVALID', 'hive-project-plan 必须是对象');
  }
  return {
    text: text.replace(match[0], '').trim(),
    value: parsed as Record<string, unknown>,
  };
}

export function parseMemoryCandidates(text: string): Array<{
  scope: 'project' | 'agent';
  agentId: string | null;
  content: string;
  tags: string[];
}> {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const rows = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const record = row as Record<string, unknown>;
      const content = typeof record.content === 'string' ? record.content.trim() : '';
      if (!content || content.length < 8 || content.length > 500) return null;
      return {
        scope: record.scope === 'agent' ? ('agent' as const) : ('project' as const),
        agentId: typeof record.agentId === 'string' ? record.agentId : null,
        content,
        tags: Array.isArray(record.tags)
          ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
          : [],
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

export function taskSummary(task: TaskRow): string {
  const result = task.result as { summary?: unknown; text?: unknown } | null;
  const text =
    result && typeof result.summary === 'string'
      ? result.summary
      : result && typeof result.text === 'string'
        ? result.text
        : '';
  return [
    `任务：${task.title}`,
    `assignee：${task.assignee}`,
    `status：${task.status}`,
    text ? `结果：${text.slice(0, 2400)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function isTerminal(task: TaskRow): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(task.status);
}

export function firstTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 40) || '新对话';
}

