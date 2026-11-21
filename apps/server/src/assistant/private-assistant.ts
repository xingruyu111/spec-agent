/**
 * 私聊 LLM 助理。
 *
 * 只回答该 Agent 在项目里的执行情况；不自动把改动写进群聊，
 * 改动仍通过 UI 的「提到群聊」或 change_request 流程。
 */

import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import type { WorkService } from '../work/work-service.js';
import type { WorkMemoryStore } from '../work/work-memory.js';
import type { ChatEngine } from '../dsh/dsh-chat.js';

export type PrivateAssistantOptions = {
  work: WorkService;
  runtime: AgentRuntime;
  chatEngine?: ChatEngine;
  root: string;
  provider: ProviderConfig;
  model: string;
  cwd: string;
  resolveAgent?: (agentId: string) => AgentConfig | undefined;
  memories?: WorkMemoryStore;
  timeoutMs?: number;
};

export class PrivateAssistant {
  constructor(private readonly options: PrivateAssistantOptions) {}

  async answer(input: {
    projectId: string;
    agentId: string;
    userId: string;
    content: string;
  }): Promise<{
    thread: ReturnType<WorkService['privateThread']>;
    messages: ReturnType<WorkService['privateMessages']>['messages'];
  }> {
    const content = input.content.trim();
    if (!content) throw new Error('消息不能为空');
    const thread = this.options.work.privateThread(
      input.projectId,
      input.agentId,
      input.userId,
    );
    this.options.work.appendPrivateUserMessage(
      thread.id,
      input.userId,
      content,
    );
    const history = this.options.work.agentHistory(
      input.projectId,
      input.agentId,
    );
    const recent = this.options.work
      .privateMessages(input.projectId, input.agentId, input.userId)
      .messages.slice(-16)
      .map((message) => `${message.actorId}：${message.content.slice(0, 400)}`);
    const historyText =
      history.length === 0
        ? '（还没有执行记录）'
        : history
            .map((assignment) => {
              const report = assignment.reports.at(-1);
              return `- [${assignment.state}] ${assignment.itemTitle}${
                report ? `：${report.summary.slice(0, 300)}` : ''
              }`;
            })
            .join('\n');
    const agent = this.options.resolveAgent?.(input.agentId);
    const memories = this.options.memories
      ? await this.options.memories.searchAsync({
      projectId: input.projectId,
      query: content,
      scopeIds: {
        project: input.projectId,
        agent: input.agentId,
        private: thread.id,
      },
      limit: 6,
        })
      : undefined;
    const memoryText =
      memories && memories.length > 0
        ? memories
            .map(
              (memory) =>
                `- [${memory.scopeType}/${memory.kind}] ${memory.content}`,
            )
            .join('\n')
        : '（没有相关记忆）';
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60_000,
    );
    let text = '';
    let reasoning = '';
    try {
      const output = await this.options.runtime.run({
        systemPrompt: [
          `你是 ${agent?.name ?? input.agentId}，正在和用户私聊。`,
          agent?.role ? `你的职责：${agent.role}` : '',
          '基于下面的执行记录回答；不要编造没有发生的任务。',
          input.agentId === 'assistant'
            ? '你可以在私聊里通过 mcp__spec_agent__create_agent 工具创建组织 Agent；但不能修改项目文件。'
            : '',
          '如果用户要求修改项目，说明可以点「提到群聊」，由项目群聊的助理接单；不要声称已经修改。',
          '',
          '## 最近执行记录',
          historyText,
          '',
          '## 相关记忆',
          memoryText,
          '',
          '## 最近私聊',
          recent.join('\n'),
        ]
          .filter(Boolean)
          .join('\n'),
        task: content,
        cwd: this.options.cwd,
        allowedTools:
          input.agentId === 'assistant'
            ? [
                'mcp__spec_agent__create_agent',
                'mcp__spec_agent__list_agents',
              ]
            : [],
        skills: [],
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: 'read-only',
        budget: { maxTurns: 3, maxUsd: 0.08 },
        signal: controller.signal,
      });
      text = output.text?.trim() ?? '';
    } catch {
      text = '';
    } finally {
      clearTimeout(timer);
    }
    if (!text) {
      text =
        history.length === 0
          ? '我还没有在这个项目里执行过 Work Item。'
          : [
              '我最近做的事：',
              ...history.map(
                (assignment) =>
                  `- [${assignment.state}] ${assignment.itemTitle}`,
              ),
            ].join('\n');
    }
    this.options.work.appendPrivateAgentMessage(
      thread.id,
      input.agentId,
      text.slice(0, 4000),
      reasoning ? { reasoning: reasoning.slice(0, 12_000) } : undefined,
    );
    return this.options.work.privateMessages(
      input.projectId,
      input.agentId,
      input.userId,
    );
  }

  async answerStream(
    input: {
      projectId: string;
      agentId: string;
      userId: string;
      content: string;
    },
    hooks: {
      onDelta?: (delta: string) => void;
      onStatus?: (status: string) => void;
      onReasoning?: (text: string) => void;
    } = {},
  ): Promise<{
    thread: ReturnType<WorkService['privateThread']>;
    messages: ReturnType<WorkService['privateMessages']>['messages'];
  }> {
    if (!this.options.chatEngine) {
      throw new Error('没有配置流式 ChatEngine');
    }
    const content = input.content.trim();
    if (!content) throw new Error('消息不能为空');
    const thread = this.options.work.privateThread(
      input.projectId,
      input.agentId,
      input.userId,
    );
    this.options.work.appendPrivateUserMessage(
      thread.id,
      input.userId,
      content,
    );
    const history = this.options.work.agentHistory(
      input.projectId,
      input.agentId,
    );
    const recent = this.options.work
      .privateMessages(input.projectId, input.agentId, input.userId)
      .messages.slice(-16)
      .map((message) => `${message.actorId}：${message.content.slice(0, 400)}`);
    const historyText =
      history.length === 0
        ? '（还没有执行记录）'
        : history
            .map((assignment) => {
              const report = assignment.reports.at(-1);
              return `- [${assignment.state}] ${assignment.itemTitle}${
                report ? `：${report.summary.slice(0, 300)}` : ''
              }`;
            })
            .join('\n');
    const agent = this.options.resolveAgent?.(input.agentId);
    const memories = this.options.memories
      ? await this.options.memories.searchAsync({
      projectId: input.projectId,
      query: content,
      scopeIds: {
        project: input.projectId,
        agent: input.agentId,
        private: thread.id,
      },
      limit: 6,
        })
      : undefined;
    const memoryText =
      memories && memories.length > 0
        ? memories
            .map(
              (memory) =>
                `- [${memory.scopeType}/${memory.kind}] ${memory.content}`,
            )
            .join('\n')
        : '（没有相关记忆）';
    let streamed = '';
    let reasoning = '';
    let text = '';
    try {
      const result = await this.options.chatEngine.run({
        root: this.options.root,
        providerId: this.options.provider.id,
        model: this.options.model,
        permissionMode: 'read-only',
        prompt: [
          `你是 ${agent?.name ?? input.agentId}，正在和用户私聊。`,
          agent?.role ? `你的职责：${agent.role}` : '',
          '基于下面的执行记录回答；不要编造没有发生的任务。',
          input.agentId === 'assistant'
            ? '你可以在私聊里通过 mcp__spec_agent__create_agent 工具创建组织 Agent；但不能修改项目文件。'
            : '',
          '如果用户要求修改项目，说明可以点「提到群聊」；不要声称已经修改。',
          '',
          '## 最近执行记录',
          historyText,
          '',
          '## 相关记忆',
          memoryText,
          '',
          '## 最近私聊',
          recent.join('\n'),
          '',
          '## 当前消息',
          content,
        ]
          .filter(Boolean)
          .join('\n'),
        onStatus: hooks.onStatus,
        onDelta: (delta) => {
          if (delta.kind === 'reasoning' && delta.text) {
            reasoning += delta.text;
            hooks.onReasoning?.(delta.text);
          }
          if (delta.kind === 'text' && delta.text) {
            streamed += delta.text;
            hooks.onDelta?.(delta.text);
          }
        },
      });
      text = result.text?.trim() || streamed.trim();
    } catch {
      text = '';
    }
    if (!text) {
      text =
        history.length === 0
          ? '我还没有在这个项目里执行过 Work Item。'
          : `我最近做的事：\n${history
              .map(
                (assignment) =>
                  `- [${assignment.state}] ${assignment.itemTitle}`,
              )
              .join('\n')}`;
    }
    this.options.work.appendPrivateAgentMessage(
      thread.id,
      input.agentId,
      text.slice(0, 4000),
      reasoning ? { reasoning: reasoning.slice(0, 12_000) } : undefined,
    );
    return this.options.work.privateMessages(
      input.projectId,
      input.agentId,
      input.userId,
    );
  }
}

