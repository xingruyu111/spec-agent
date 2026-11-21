import { describe, expect, it } from 'vitest';
import type { AgentConfig, LlmNode } from '@spec-agent/schema';
import { routeModel } from '../../packages/core/src/model-router.js';
import type { ProviderConfig } from '@spec-agent/core';

const textProvider: ProviderConfig = {
  id: 'text',
  models: {
    fast: { capabilities: ['tools'], quality: 1, speed: 5 },
  },
};
const visionProvider: ProviderConfig = {
  id: 'vision',
  models: {
    'vision-pro': { capabilities: ['tools', 'vision'], quality: 5, speed: 2 },
    'vision-lite': { capabilities: ['tools', 'vision'], quality: 2, speed: 5 },
  },
};

function node(over: Partial<LlmNode> = {}): LlmNode {
  return {
    id: 'node' as never,
    type: 'llm',
    description: '执行',
    inputs: [],
    outputs: [],
    tools: [],
    ...over,
  };
}

describe('routeModel', () => {
  it('按能力从 provider 目录选择最佳模型', () => {
    const route = routeModel({
      node: node({ modelCapabilities: ['vision', 'tools'] }),
      defaultProvider: textProvider,
      defaultModel: 'fast',
      providers: [textProvider, visionProvider],
    });
    expect(route.provider.id).toBe('vision');
    expect(route.model).toBe('vision-pro');
  });

  it('node 显式选择优先于 agent 和能力路由', () => {
    const agent = {
      model: { provider: 'vision', model: 'vision-lite' },
    } as AgentConfig;
    const route = routeModel({
      node: node({ model: { provider: 'text', model: 'fast' } }),
      agent,
      defaultProvider: textProvider,
      defaultModel: 'fast',
      providers: [textProvider, visionProvider],
    });
    expect(route.model).toBe('fast');
  });

  it('agent 只指定 provider 时也生效；无能力匹配会显式失败', () => {
    const agent = {
      model: { provider: 'vision', model: 'inherit' },
    } as AgentConfig;
    const route = routeModel({
      node: node(),
      agent,
      defaultProvider: textProvider,
      defaultModel: 'fast',
      providers: [textProvider, visionProvider],
    });
    expect(route.provider.id).toBe('vision');
    expect(route.model).toBe('fast');
    expect(() => routeModel({
      node: node({ modelCapabilities: ['audio'] }),
      defaultProvider: textProvider,
      defaultModel: 'fast',
      providers: [textProvider, visionProvider],
    })).toThrowError(/audio/);
  });
});
