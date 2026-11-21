/** Provider / model 能力路由。 */

import type { AgentConfig, LlmNode } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';
import type { ProviderConfig } from './ports/agent-runtime.js';

export type ModelRoute = { provider: ProviderConfig; model: string };

export function routeModel(input: {
  node: LlmNode;
  agent?: AgentConfig;
  defaultProvider: ProviderConfig;
  defaultModel: string;
  providers?: ProviderConfig[];
}): ModelRoute {
  const providers = input.providers?.length
    ? input.providers
    : [input.defaultProvider];
  if (input.node.model && input.node.model !== 'inherit') {
    return {
      provider: findProvider(providers, input.node.model.provider, input.defaultProvider),
      model: input.node.model.model,
    };
  }
  const agentModel = input.agent?.model;
  if (agentModel && agentModel.model !== 'inherit') {
    return {
      provider: findProvider(providers, agentModel.provider, input.defaultProvider),
      model: agentModel.model,
    };
  }
  if (agentModel && agentModel.provider !== 'inherit') {
    return {
      provider: findProvider(providers, agentModel.provider, input.defaultProvider),
      model: input.defaultModel,
    };
  }

  const required = input.node.modelCapabilities ?? [];
  if (required.length === 0) {
    return { provider: input.defaultProvider, model: input.defaultModel };
  }
  const candidates: Array<ModelRoute & { score: number }> = [];
  for (const provider of providers) {
    for (const [model, metadata] of Object.entries(provider.models ?? {})) {
      const capabilities = metadata.capabilities ?? [];
      if (!required.every((capability) => capabilities.includes(capability))) continue;
      const quality = metadata.quality ?? 0;
      const speed = metadata.speed ?? 0;
      const cost = metadata.cost ?? 0;
      candidates.push({
        provider,
        model,
        score: quality * 100 + speed - cost * 0.01,
      });
    }
  }
  if (candidates.length === 0) {
    throw new AppError(
      'E_MODEL_ROUTE_UNAVAILABLE',
      `没有模型满足能力：${required.join(', ')}`,
    );
  }
  candidates.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model));
  return { provider: candidates[0]!.provider, model: candidates[0]!.model };
}

function findProvider(
  providers: ProviderConfig[],
  id: string,
  fallback: ProviderConfig,
): ProviderConfig {
  if (!id || id === 'inherit') return fallback;
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) throw new AppError('E_PROVIDER_NOT_FOUND', `provider 不存在：${id}`);
  return provider;
}
