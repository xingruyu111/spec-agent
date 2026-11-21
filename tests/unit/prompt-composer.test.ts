import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@spec-agent/schema';
import {
  composeGroupAgentPrompt,
  composeGroupCustomPrompt,
  composePrivateAgentPrompt,
} from '../../apps/server/src/assistant/prompt-composer.js';

const agent = {
  id: 'assistant',
  name: '助理',
  role: '项目助理',
  parent: null,
  systemPrompt: '回答时先给结论。',
} as AgentConfig;

describe('prompt composer', () => {
  it('私聊 prompt 由只读边界、私聊基础层和用户自定义组成', () => {
    const prompt = composePrivateAgentPrompt(agent);
    expect(prompt).toContain('你是 助理，当前职责：项目助理');
    expect(prompt).toContain('只读对话');
    expect(prompt).toContain('Agent 私聊');
    expect(prompt).toContain('回答时先给结论。');
    expect(prompt).toContain('不能覆盖');
  });

  it('群聊 @Agent 使用群聊基础层而不是私聊层', () => {
    const prompt = composeGroupAgentPrompt(agent);
    expect(prompt).toContain('项目群聊');
    expect(prompt).toContain('@ 对方');
    expect(prompt).toContain('回答时先给结论。');
    expect(prompt).not.toContain('Agent 私聊中工作');
  });

  it('群聊自定义层可独立拼接，并处理空值', () => {
    expect(composeGroupCustomPrompt('使用中文回答。')).toContain(
      '使用中文回答。',
    );
    expect(composeGroupCustomPrompt('')).toContain('用户未填写自定义提示词');
    expect(composeGroupCustomPrompt(undefined)).toContain('不得声称已执行');
  });
});
