import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@spec-agent/core';
import { assistText } from './ai-assist.js';

function runtimeWith(
  text: string | undefined,
  stopReason: 'finished' | 'failed' = 'finished',
): AgentRuntime {
  return {
    id: 'fake-ai',
    async run() {
      return {
        outputs: [],
        ...(text !== undefined ? { text } : {}),
        transcriptRef: 't',
        usage: { usd: 0.002 },
        stopReason,
      };
    },
  };
}

const options = (text: string | undefined) => ({
  kind: 'role' as const,
  text: '根据需求生成文档',
  context: { name: '项目经理', role: '根据需求生成文档' },
  agentRuntime: runtimeWith(text),
  provider: { id: 'fake' },
  model: 'fake-model',
});

describe('assistText', () => {
  it('优化职责时只传原文和上下文，去掉代码围栏', async () => {
    let captured: { systemPrompt: string; task: string; tools: string[] } | undefined;
    const runtime: AgentRuntime = {
      id: 'fake',
      async run(input) {
        captured = {
          systemPrompt: input.systemPrompt,
          task: input.task,
          tools: input.allowedTools,
        };
        return {
          outputs: [],
          text: '```text\n负责需求分析与文档产出\n```',
          transcriptRef: 't',
          usage: { usd: 0.002 },
          stopReason: 'finished',
        };
      },
    };
    const result = await assistText({ ...options(undefined), agentRuntime: runtime });
    expect(result.text).toBe('负责需求分析与文档产出');
    expect(captured?.task).toContain('根据需求生成文档');
    expect(captured?.task).toContain('项目经理');
    expect(captured?.tools).toEqual([]);
    expect(captured?.systemPrompt).toContain('职责');
  });

  it('根据职责生成系统提示词', async () => {
    const result = await assistText({
      ...options('你是项目经理，负责需求分析和验收。'),
      kind: 'systemPrompt',
      text: '负责需求分析和验收',
    });
    expect(result.text).toContain('你是项目经理');
    expect(result.usage?.usd).toBe(0.002);
  });

  it('根据节点职责生成执行指令', async () => {
    const result = await assistText({
      ...options('目标：生成文档\n输出文件：docs/req.md'),
      kind: 'nodeInstructions',
      text: '生成需求文档',
      context: {
        name: '需求文档',
        description: '生成需求文档',
        outputPath: 'docs/req.md',
        doneCriteria: '文件存在',
      },
    });
    expect(result.text).toContain('目标：生成文档');
  });

  it('AI 未完成或没有文本时报错', async () => {
    await expect(
      assistText({ ...options(undefined), agentRuntime: runtimeWith(undefined) }),
    ).rejects.toMatchObject({ code: 'E_AI_EMPTY' });
    await expect(
      assistText({
        ...options('不会用到'),
        agentRuntime: runtimeWith('x', 'failed'),
      }),
    ).rejects.toMatchObject({ code: 'E_AI_FAILED' });
  });
});
