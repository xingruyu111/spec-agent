/**
 * 组织/节点编辑器的 AI 辅助。
 *
 * 只做“把现有原文改得更好”或“根据职责生成提示词”，不执行任务、不使用工具。
 */

import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import type { Usage } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';

export type AiAssistKind =
  | 'role'
  | 'systemPrompt'
  | 'nodeDescription'
  | 'nodeInstructions';

export type AiAssistContext = Record<string, string | number | undefined>;

export type AiAssistInput = {
  kind: AiAssistKind;
  text: string;
  context?: AiAssistContext;
  agentRuntime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  signal?: AbortSignal;
};

export type AiAssistResult = {
  text: string;
  usage?: Usage;
};

const KIND_LIMIT: Record<AiAssistKind, number> = {
  role: 1200,
  systemPrompt: 4000,
  nodeDescription: 1200,
  nodeInstructions: 4000,
};

const KIND_PROMPT: Record<AiAssistKind, string> = {
  role: `你是组织设计助手。请优化下面的 agent 职责描述。
要求：
- 动作导向，说明负责范围、关键产出和边界
- 80 字以内，信息密度高
- 不要写工具权限、技术实现、空泛口号
- 只返回优化后的职责文本，不要标题、引号或 Markdown`,
  systemPrompt: `你是 agent 系统提示词设计助手。请根据职责生成一份可执行的系统提示词。
要求：
- 说明角色定位、主要职责、工作边界、协作方式和质量要求
- 200 到 400 字，第二人称或角色口吻均可
- 如果上下文已有 systemPrompt，保留其中正确的约束并优化结构
- 不要写具体工具权限、文件路径或无法执行的承诺
- 只返回系统提示词正文，不要标题、引号或 Markdown`,
  nodeDescription: `你是工作流节点设计助手。请优化下面的节点职责描述。
要求：
- 说明这个节点做什么、产出什么、不做什么
- 80 字以内，动作导向
- 不要写具体实现步骤、工具名或空泛口号
- 只返回优化后的节点职责，不要标题、引号或 Markdown`,
  nodeInstructions: `你是工作流节点执行指令设计助手。请根据节点信息生成详细、可执行的指令。
要求：
- 包含目标、输入、执行步骤、输出文件、完成条件和约束
- 指令要具体、可验证，避免空话
- 不要写工具权限，不要编造不存在的输入
- 如果已有指令，保留其中正确的约束并优化结构
- 只返回执行指令正文，不要标题、引号或 Markdown`,
};

function contextText(context: AiAssistContext | undefined): string {
  if (!context) return '';
  const entries = Object.entries(context).filter(
    ([, value]) => value !== undefined && String(value).trim() !== '',
  );
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `${key}: ${String(value).trim()}`)
    .join('\n');
}

function stripOutput(text: string, limit: number): string {
  let output = text.trim();
  const fenced = /```(?:text|markdown|md)?\s*([\s\S]*?)```/i.exec(output);
  if (fenced) output = fenced[1]!.trim();
  output = output
    .replace(/^(优化后的?|生成的?|结果)[^：:\n]*[：:]\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  if (output.length > limit) output = output.slice(0, limit).trim();
  if (!output) throw new AppError('E_AI_EMPTY', 'AI 没有返回可用内容');
  return output;
}

export async function assistText(input: AiAssistInput): Promise<AiAssistResult> {
  const context = contextText(input.context);
  const output = await input.agentRuntime.run({
    systemPrompt: KIND_PROMPT[input.kind],
    task: [
      context ? `上下文：\n${context}` : '',
      `原文：\n<original>\n${input.text.trim()}\n</original>`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    cwd: process.cwd(),
    allowedTools: [],
    skills: [],
    provider: input.provider,
    model: input.model,
    budget: { maxTurns: 2, maxUsd: 0.2 },
    signal: input.signal ?? new AbortController().signal,
  });

  if (output.stopReason !== 'finished') {
    throw new AppError('E_AI_FAILED', `AI 辅助没有正常结束：${output.stopReason}`);
  }
  if (!output.text) throw new AppError('E_AI_EMPTY', 'AI 没有返回内容');

  return {
    text: stripOutput(output.text, KIND_LIMIT[input.kind]),
    usage: output.usage,
  };
}
