import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@spec-agent/core';
import {
  dshChatRouteId,
  dshProviderPatchYaml,
} from '../../apps/server/src/dsh/dsh-chat.js';

describe('DSH pi-ai route patch', () => {
  it('生成 OpenAI Compatible provider route，并补 /v1', () => {
    const provider: ProviderConfig = {
      id: 'deepseek-openai',
      name: 'DeepSeek OpenAI',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/',
      authToken: 'secret',
      models: { 'deepseek-flash': { contextWindow: 200000 } },
    };
    const routeId = dshChatRouteId(provider.id, 'abcdef123456');
    expect(routeId).toBe('spec-agent-chat-deepseek-openai-abcdef');
    const yaml = dshProviderPatchYaml(routeId, provider, 'deepseek-flash');
    expect(yaml).toContain(`      ${routeId}:`);
    expect(yaml).toContain('api: openai-completions');
    expect(yaml).toContain('baseURL: "https://api.deepseek.com/v1"');
    expect(yaml).toContain('apiKeyEnv: SPEC_AGENT_CHAT_API_KEY');
    expect(yaml).toContain('id: "deepseek-flash"');
    expect(yaml).toContain('contextWindow: 200000');
  });

  it('Anthropic route 保持 baseURL，并声明 anthropic-messages', () => {
    const provider: ProviderConfig = {
      id: 'relay',
      protocol: 'anthropic',
      baseUrl: 'https://relay.example.com/anthropic',
      models: { 'claude-sonnet': {} },
    };
    const yaml = dshProviderPatchYaml(
      dshChatRouteId(provider.id, '123456abcdef'),
      provider,
      'claude-sonnet',
    );
    expect(yaml).toContain('api: anthropic-messages');
    expect(yaml).toContain('baseURL: "https://relay.example.com/anthropic"');
    expect(yaml).not.toContain('/v1"');
  });
});
