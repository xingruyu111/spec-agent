import { AppError } from '@spec-agent/kernel';
import type { ProviderConfig } from '@spec-agent/core';

type RouteOptions = {
  defaultRoute?: () => { providerId: string; model: string };
  providers?: () => ProviderConfig[];
};

export function resolveRoute(
  options: RouteOptions,
  providerId?: string,
  model?: string,
): { providerId: string | null; model: string | null } {
    const fallback = options.defaultRoute?.();
    const providers = options.providers?.() ?? [];
    if (providers.length === 0) {
      return {
        providerId: providerId?.trim() || fallback?.providerId || null,
        model: model?.trim() || fallback?.model || null,
      };
    }

    const chatProviders = providers;
    if (chatProviders.length === 0) {
      throw new AppError(
        'E_CHAT_PROVIDER_UNAVAILABLE',
        '聊天需要至少一个供应商',
      );
    }
    if (providerId?.trim()) {
      const selected = providers.find((entry) => entry.id === providerId.trim());
      if (!selected) {
        throw new AppError('E_CHAT_MODEL', `供应商不存在：${providerId}`);
      }
    }

    const fallbackProvider = chatProviders.find(
      (entry) => entry.id === fallback?.providerId,
    );
    const targetProvider =
      (providerId?.trim()
        ? providers.find((entry) => entry.id === providerId.trim())
        : fallbackProvider) ?? chatProviders[0]!;
    const explicitModel = model?.trim();
    if (explicitModel && !targetProvider.models?.[explicitModel]) {
      throw new AppError(
        'E_CHAT_MODEL',
        `模型不属于供应商 ${targetProvider.id}：${explicitModel}`,
      );
    }
    const targetModel =
      explicitModel ||
      (fallback?.model && targetProvider.models?.[fallback.model]
        ? fallback.model
        : Object.keys(targetProvider.models ?? {})[0]);
    if (!targetModel) {
      throw new AppError(
        'E_CHAT_MODEL',
        `供应商 ${targetProvider.id} 没有可用聊天模型`,
      );
    }
    return { providerId: targetProvider.id, model: targetModel };
  }

