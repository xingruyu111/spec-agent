/**
 * 全局模型供应商配置。
 *
 * 凭证只写到 server 本机的 ~/.spec-agent/provider.json（可用 SPEC_AGENT_PROVIDER_FILE 覆盖），
 * 不从 GET 接口返回明文；环境变量仍作为启动默认值。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppError } from '@spec-agent/kernel';
import type { ProviderConfig } from '@spec-agent/core';

export type ProviderFileData = {
  version?: 2;
  defaultProviderId?: string;
  baseUrl?: string;
  authToken?: string;
  model?: string;
  models?: string[];
  modelAliases?: Record<string, string>;
  /** 可选额外 provider 注册表，支持能力路由 */
  providers?: ProviderConfig[];
};

type PublicProviderModel = {
  id: string;
  contextWindow?: number;
  autoCompact?: boolean;
};

type PublicProvider = {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  models: PublicProviderModel[];
  hasToken: boolean;
  tokenHint: string;
  /** 仅 secrets=1 的配置编辑器返回 */
  authToken?: string;
};

export type ProviderSettings = {
  baseUrl: string;
  model: string;
  models: string[];
  hasToken: boolean;
  tokenHint: string;
  file: string;
  defaultProviderId: string;
  providers: PublicProvider[];
};

export function defaultProviderFile(): string {
  if (process.env.SPEC_AGENT_PROVIDER_FILE) return process.env.SPEC_AGENT_PROVIDER_FILE;
  const current = join(homedir(), '.spec-agent', 'provider.json');
  const legacy = join(homedir(), '.hive', 'provider.json');
  if (!existsSync(current) && existsSync(legacy)) {
    mkdirSync(dirname(current), { recursive: true });
    renameSync(legacy, current);
  }
  return current;
}

export function loadProviderFile(file: string): ProviderFileData | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProviderFileData;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...(parsed.version === 2 ? { version: 2 as const } : {}),
      ...(typeof parsed.defaultProviderId === 'string' && parsed.defaultProviderId.trim()
        ? { defaultProviderId: parsed.defaultProviderId.trim() }
        : {}),
      ...(typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
        ? { baseUrl: parsed.baseUrl.trim() }
        : {}),
      ...(typeof parsed.authToken === 'string'
        ? { authToken: parsed.authToken.trim() }
        : {}),
      ...(typeof parsed.model === 'string' && parsed.model.trim()
        ? { model: parsed.model.trim() }
        : {}),
      ...(Array.isArray(parsed.models)
        ? {
            models: parsed.models
              .filter((model): model is string => typeof model === 'string')
              .map((model) => model.trim())
              .filter(Boolean),
          }
        : {}),
      ...(parsed.modelAliases && typeof parsed.modelAliases === 'object'
        ? { modelAliases: parsed.modelAliases }
        : {}),
      ...(Array.isArray(parsed.providers)
        ? { providers: parsed.providers.filter((entry): entry is ProviderConfig => isProviderConfig(entry)) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function saveProviderFile(file: string, data: ProviderFileData): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 不可用；文件仍由 server 用户目录保护
  }
}

export function providerFromEnvironment(): ProviderConfig {
  return {
    id: 'anthropic',
    baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
    authToken:
      process.env.ANTHROPIC_AUTH_TOKEN?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim() ||
      undefined,
  };
}

export function publicProviderSettings(
  provider: ProviderConfig,
  model: string,
  models: string[],
  file: string,
  providers: ProviderConfig[] = [provider],
  defaultProviderId = provider.id,
  includeSecrets = false,
): ProviderSettings {
  const token = provider.authToken ?? '';
  const publicProviders = providers.map((entry) => {
    const entryToken = entry.authToken ?? '';
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      protocol: entry.protocol ?? 'anthropic' as const,
      baseUrl: entry.baseUrl ?? '',
      models: (entry.id === provider.id
        ? Array.from(new Set([...Object.keys(entry.models ?? {}), ...models, model]))
        : Object.keys(entry.models ?? {})
      ).map((id) => ({
        id,
        ...(entry.models?.[id]?.contextWindow
          ? { contextWindow: entry.models[id]!.contextWindow }
          : {}),
        ...(entry.models?.[id]?.autoCompact !== undefined
          ? { autoCompact: entry.models[id]!.autoCompact }
          : {}),
      })),
      hasToken: entryToken.length > 0,
      tokenHint: entryToken ? `…${entryToken.slice(-4)}` : '',
      ...(includeSecrets ? { authToken: entryToken } : {}),
    };
  });
  return {
    baseUrl: provider.baseUrl ?? '',
    model,
    models,
    hasToken: token.length > 0,
    tokenHint: token ? `…${token.slice(-4)}` : '',
    file,
    defaultProviderId,
    providers: publicProviders,
  };
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    Boolean((value as { id: string }).id.trim())
  );
}

function normalizeModels(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 120),
    ),
  ).slice(0, 50);
}

export function validateProviderInput(input: {
  baseUrl?: unknown;
  model?: unknown;
  models?: unknown;
}): { baseUrl?: string; model?: string; models?: string[] } {
  const baseUrl =
    typeof input.baseUrl === 'string' ? input.baseUrl.trim() : undefined;
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new AppError('E_PROVIDER_INVALID', '供应商 Base URL 不是合法 URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError('E_PROVIDER_INVALID', '供应商 Base URL 必须是 http(s)');
    }
  }

  const model = typeof input.model === 'string' ? input.model.trim() : undefined;
  if (model !== undefined && (!model || model.length > 120)) {
    throw new AppError('E_PROVIDER_INVALID', '默认模型名必填，最多 120 字符');
  }

  let models: string[] | undefined;
  if (Array.isArray(input.models)) {
    models = normalizeModels(
      input.models.filter((value): value is string => typeof value === 'string'),
    );
    if (models.length === 0 && !model) {
      throw new AppError('E_PROVIDER_INVALID', '至少配置一个可用模型');
    }
  }

  return { baseUrl, model, models };
}

/** 校验完整多供应商配置；token 缺省保留，clearToken 才清除。 */
function normalizeModelConfigs(
  value: unknown,
  previous: ProviderConfig['models'],
): NonNullable<ProviderConfig['models']> {
  const entries = Array.isArray(value) ? value : Object.keys(previous ?? {});
  const result: NonNullable<ProviderConfig['models']> = {};
  for (const raw of entries.slice(0, 50)) {
    const item = typeof raw === 'string' ? { id: raw } : raw;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || result[id]) continue;
    const contextWindow = record.contextWindow;
    if (contextWindow !== undefined && (
      typeof contextWindow !== 'number' ||
      !Number.isInteger(contextWindow) ||
      contextWindow < 1000 ||
      contextWindow > 10_000_000
    )) {
      throw new AppError('E_PROVIDER_INVALID', `模型 ${id} 的上下文窗口必须是 1000–10000000 的整数`);
    }
    const autoCompact = record.autoCompact;
    if (autoCompact !== undefined && typeof autoCompact !== 'boolean') {
      throw new AppError('E_PROVIDER_INVALID', `模型 ${id} 的 autoCompact 必须是布尔值`);
    }
    result[id] = {
      ...previous?.[id],
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(typeof autoCompact === 'boolean' ? { autoCompact } : {}),
    };
  }
  return result;
}

/** 校验完整多供应商配置；token 缺省保留，clearToken 才清除。 */
export function validateProviderRegistryInput(
  input: Record<string, unknown>,
  existing: ProviderConfig[],
): { providers: ProviderConfig[]; defaultProviderId: string; model: string } {
  if (!Array.isArray(input.providers) || input.providers.length === 0) {
    throw new AppError('E_PROVIDER_INVALID', '至少配置一个供应商');
  }
  const ids = new Set<string>();
  const providers = input.providers.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new AppError('E_PROVIDER_INVALID', '供应商配置必须是对象');
    }
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
      throw new AppError('E_PROVIDER_INVALID', '供应商 id 只能包含小写字母、数字、_ 和 -');
    }
    if (ids.has(id)) throw new AppError('E_PROVIDER_INVALID', `供应商 id 重复：${id}`);
    ids.add(id);
    const previous = existing.find((entry) => entry.id === id);
    const protocol = item.protocol ?? previous?.protocol ?? 'anthropic';
    if (protocol !== 'anthropic' && protocol !== 'openai') {
      throw new AppError('E_PROVIDER_INVALID', `供应商 ${id} 的协议无效`);
    }
    const base = validateProviderInput({ baseUrl: item.baseUrl });
    const models = normalizeModelConfigs(item.models, previous?.models);
    if (Object.keys(models).length === 0) {
      throw new AppError('E_PROVIDER_INVALID', `供应商 ${id} 至少需要一个模型`);
    }
    const authToken = typeof item.authToken === 'string'
      ? item.authToken.trim()
      : item.clearToken === true
        ? ''
        : previous?.authToken;
    return {
      ...previous,
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      protocol,
      baseUrl: base.baseUrl || undefined,
      authToken,
      models,
    } satisfies ProviderConfig;
  });
  const defaultProviderId = typeof input.defaultProviderId === 'string'
    ? input.defaultProviderId
    : providers[0]!.id;
  if (!ids.has(defaultProviderId)) {
    throw new AppError('E_PROVIDER_INVALID', '默认供应商不存在');
  }
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) throw new AppError('E_PROVIDER_INVALID', '默认模型不能为空');
  return { providers, defaultProviderId, model };
}

