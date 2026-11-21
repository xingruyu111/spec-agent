/**
 * 项目级 Spec Agent 设置。
 *
 * 放在 <project>/.spec-agent/settings.json，随项目走，不依赖服务器启动参数。
 * 缺省值面向大型项目，但仍由项目所有者显式收紧或放宽。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@spec-agent/kernel';

export type SpecAgentPlannerSettings = {
  maxLayerNodes: number;
  maxTotalNodes: number;
  maxDepth: number;
  maxAgents: number;
  maxWorkstreams: number;
};

export type SpecAgentExecutionMode = 'session';

export type SpecAgentExecutionSettings = {
  mode: SpecAgentExecutionMode;
  maxUsdPerTask: number;
  maxUsdPerNode: number;
  maxTurns: number;
  maxConcurrentChildren: number;
  maxConcurrentTasks: number;
  maxUsdPerProject: number;
  maxUsdPerDay: number;
  /** 配置后自动在根工作流末尾追加独立 QA 节点 */
  qaAgent?: string;
};

export type SpecAgentMemorySettings = {
  provider: 'local' | 'tencent' | 'hy-memory';
  baseUrl?: string;
  serviceId?: string;
  userId?: string;
  workspaceId?: string;
  branch?: string;
};

export type SpecAgentSettings = {
  planner: SpecAgentPlannerSettings;
  execution: SpecAgentExecutionSettings;
  capabilities: {
    mcpServers: Record<string, unknown>;
    memory: SpecAgentMemorySettings;
  };
};

export const DEFAULT_SPEC_AGENT_SETTINGS: SpecAgentSettings = {
  planner: {
    maxLayerNodes: 16,
    maxTotalNodes: 128,
    maxDepth: 8,
    maxAgents: 32,
    maxWorkstreams: 16,
  },
  execution: {
    mode: 'session',
    maxUsdPerTask: 50,
    maxUsdPerNode: 5,
    maxTurns: 60,
    maxConcurrentChildren: 8,
    maxConcurrentTasks: 4,
    maxUsdPerProject: 500,
    maxUsdPerDay: 200,
  },
  capabilities: { mcpServers: {}, memory: { provider: 'local' } },
};

export function settingsPath(root: string): string {
  return join(root, '.spec-agent', 'settings.json');
}

/** 读取项目设置；文件不存在时使用面向大型项目的缺省值。 */
export function loadSpecAgentSettings(root: string): SpecAgentSettings {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return cloneDefaults();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new AppError('E_SETTINGS_INVALID', `.spec-agent/settings.json 不是合法 JSON`, {
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw new AppError('E_SETTINGS_INVALID', '.spec-agent/settings.json 必须是对象');
  }
  return {
    planner: {
      ...DEFAULT_SPEC_AGENT_SETTINGS.planner,
      ...readPlanner(parsed.planner),
    },
    execution: {
      ...DEFAULT_SPEC_AGENT_SETTINGS.execution,
      ...readExecution(parsed.execution),
    },
    capabilities: readCapabilities(parsed.capabilities),
  };
}

function readPlanner(value: unknown): Partial<SpecAgentPlannerSettings> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid('planner 必须是对象');
  return {
    ...positiveInt(value, 'maxLayerNodes', 'planner.maxLayerNodes'),
    ...positiveInt(value, 'maxTotalNodes', 'planner.maxTotalNodes'),
    ...positiveInt(value, 'maxDepth', 'planner.maxDepth'),
    ...positiveInt(value, 'maxAgents', 'planner.maxAgents'),
    ...positiveInt(value, 'maxWorkstreams', 'planner.maxWorkstreams'),
  };
}

function readExecution(value: unknown): Partial<SpecAgentExecutionSettings> {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid('execution 必须是对象');
  const mode = value.mode ?? 'session';
  if (mode !== 'session') {
    invalid('execution.mode 只支持 session；node 模式已移除');
  }
  if (
    value.qaAgent !== undefined &&
    (typeof value.qaAgent !== 'string' || value.qaAgent.trim().length === 0)
  ) {
    invalid('execution.qaAgent 必须是非空字符串');
  }
  const qaAgent =
    typeof value.qaAgent === 'string' ? value.qaAgent.trim() : undefined;
  return {
    mode,
    ...(qaAgent ? { qaAgent } : {}),
    ...positiveNumber(value, 'maxUsdPerTask', 'execution.maxUsdPerTask'),
    ...positiveNumber(value, 'maxUsdPerNode', 'execution.maxUsdPerNode'),
    ...positiveInt(value, 'maxTurns', 'execution.maxTurns'),
    ...positiveInt(value, 'maxConcurrentChildren', 'execution.maxConcurrentChildren'),
    ...positiveInt(value, 'maxConcurrentTasks', 'execution.maxConcurrentTasks'),
    ...positiveNumber(value, 'maxUsdPerProject', 'execution.maxUsdPerProject'),
    ...positiveNumber(value, 'maxUsdPerDay', 'execution.maxUsdPerDay'),
  };
}

function readCapabilities(value: unknown): SpecAgentSettings['capabilities'] {
  if (value === undefined) return { mcpServers: {}, memory: { provider: 'local' } };
  if (!isRecord(value)) invalid('capabilities 必须是对象');
  const servers = value.mcpServers;
  if (servers !== undefined && !isRecord(servers)) {
    invalid('capabilities.mcpServers 必须是对象');
  }
  return {
    mcpServers: servers ? { ...servers } : {},
    memory: readMemory(value.memory),
  };
}

function readMemory(value: unknown): SpecAgentMemorySettings {
  if (value === undefined) return { provider: 'local' };
  if (!isRecord(value)) invalid('capabilities.memory 必须是对象');
  const provider = value.provider ?? 'local';
  if (provider !== 'local' && provider !== 'tencent' && provider !== 'hy-memory') {
    invalid('capabilities.memory.provider 只能是 local、tencent 或 hy-memory');
  }
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : undefined;
  const serviceId = typeof value.serviceId === 'string' ? value.serviceId.trim() : undefined;
  const userId = typeof value.userId === 'string' ? value.userId.trim() : undefined;
  const workspaceId =
    typeof value.workspaceId === 'string' ? value.workspaceId.trim() : undefined;
  const branch = typeof value.branch === 'string' ? value.branch.trim() : undefined;
  if ((provider === 'tencent' || provider === 'hy-memory') && !baseUrl) {
    invalid(`capabilities.memory.baseUrl 在 ${provider} 模式下必填`);
  }
  return { provider, baseUrl, serviceId, userId, workspaceId, branch };
}

function readNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
  integer: boolean,
): Record<string, number> {
  const raw = value[key];
  if (raw === undefined) return {};
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    invalid(`${label} 必须是${integer ? '正整' : '正'}数`);
  }
  if (integer && !Number.isSafeInteger(raw)) {
    invalid(`${label} 必须是正整数`);
  }
  return { [key]: raw };
}

function positiveInt(
  value: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, number> {
  return readNumber(value, key, label, true);
}

function positiveNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, number> {
  return readNumber(value, key, label, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new AppError('E_SETTINGS_INVALID', `.spec-agent/settings.json: ${message}`);
}

function cloneDefaults(): SpecAgentSettings {
  return {
    planner: { ...DEFAULT_SPEC_AGENT_SETTINGS.planner },
    execution: { ...DEFAULT_SPEC_AGENT_SETTINGS.execution },
    capabilities: { mcpServers: {}, memory: { provider: 'local' } },
  };
}
