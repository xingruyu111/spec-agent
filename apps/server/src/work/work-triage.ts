/**
 * 助理 LLM triage。
 *
 * 只做判断，不直接执行：
 * - create_work_item：建 Work Item 草案
 * - reply / needs_info：直接回复或追问
 * 解析失败时退化为“建工作项”，避免消息静默丢失。
 */

import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import type { WorkItemRow } from './work-store.js';
import type { WorkService } from './work-service.js';

type TriageAction = 'create_work_item' | 'reply' | 'needs_info';
type TriageDecision = {
  action: TriageAction;
  title?: string;
  intent?: string;
  assignee?: string;
  reply: string;
};

export type TriageResult = {
  decision: TriageDecision;
  item: WorkItemRow | null;
  replyEventId: string;
};

export type WorkTriageOptions = {
  work: WorkService;
  runtime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  cwd: string;
  root?: string;
  resolveAgent?: (agentId: string) => AgentConfig | undefined;
  listAgents?: () => Array<{ id: string; name: string; role: string }>;
  timeoutMs?: number;
};

export class WorkTriage {
  constructor(private readonly options: WorkTriageOptions) {}

  async triage(groupId: string, eventId: string): Promise<TriageResult> {
    const event = this.options.work.getEvent(eventId);
    if (!event || event.groupId !== groupId) {
      throw new Error('需要一条属于该群聊的消息事件');
    }
    const content = String(event.payload.content ?? '').trim();
    if (!content) throw new Error('消息不能为空');

    const agents = this.options.listAgents?.() ?? [];
    const group = this.options.work.getGroup(groupId);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60_000,
    );
    const toolResults: Array<{
      tool: string;
      output: string;
      ok: boolean;
    }> = [];
    let text = '';
    try {
      const output = await this.options.runtime.run({
        systemPrompt: [
          '你是 Spec Agent 的项目群聊助理。',
          '通过工具处理消息；不要输出 JSON，不要伪造工具结果。',
          '',
          '可用动作：',
          '- 明确要修改代码/排查/交付：调用 mcp__spec_agent__create_work_item，参数 groupId、eventId、title、可选 assignee。',
          '- 需要回复或追问：调用 mcp__spec_agent__reply_in_group，参数 groupId、content。',
          '- 用户要求把 Agent 拉进群：调用 mcp__spec_agent__add_group_member，参数 groupId、agentName，再用 reply_in_group 告知结果。',
          `- 当前 groupId：${groupId}${group ? `（${group.name}）` : ''}，当前 eventId：${eventId}。`,
          '- 不要声称创建了没有调用工具创建的工作项。',
          agents.length > 0
            ? `可用 Agent：${agents
                .map((agent) => `${agent.id}(${agent.name}:${agent.role})`)
                .join('；')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        task: content,
        cwd: this.options.cwd,
        ...(this.options.root ? { workspaceRoot: this.options.root } : {}),
        allowedTools: [
          'mcp__spec_agent__create_work_item',
          'mcp__spec_agent__reply_in_group',
          'mcp__spec_agent__add_group_member',
          'mcp__spec_agent__list_agents',
        ],
        skills: [],
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: 'read-only',
        budget: { maxTurns: 4, maxUsd: 0.1 },
        signal: controller.signal,
        onToolEvent: (toolEvent) => {
          if (toolEvent.phase !== 'result') return;
          toolResults.push({
            tool: toolEvent.tool,
            output: toolEvent.outputPreview ?? '',
            ok: toolEvent.ok !== false,
          });
        },
      });
      text = output.text?.trim() ?? '';
    } finally {
      clearTimeout(timer);
    }

    const createResult = toolResults.find(
      (result) => result.ok && result.tool.endsWith('create_work_item'),
    );
    const replyResult = toolResults.find(
      (result) => result.ok && result.tool.endsWith('reply_in_group'),
    );
    const memberResult = toolResults.find(
      (result) => result.ok && result.tool.endsWith('add_group_member'),
    );

    let item: WorkItemRow | null = null;
    if (createResult) {
      const parsed = parseToolJson(createResult.output);
      const itemId =
        typeof parsed?.item === 'object' &&
        parsed.item &&
        typeof (parsed.item as { id?: unknown }).id === 'string'
          ? (parsed.item as { id: string }).id
          : null;
      item = itemId
        ? (this.options.work.getWorkItem(itemId) ?? null)
        : null;
    }

    let replyEventId = '';
    if (replyResult) {
      const parsed = parseToolJson(replyResult.output);
      replyEventId =
        typeof parsed?.event === 'object' &&
        parsed.event &&
        typeof (parsed.event as { id?: unknown }).id === 'string'
          ? (parsed.event as { id: string }).id
          : '';
    }

    if (!replyResult) {
      const fallback =
        text ||
        (memberResult
          ? '已处理群成员。'
          : item
            ? `已建工作项：${item.title}`
            : '我在。请补充一下目标或验收标准。');
      const reply = this.options.work.postAssistantMessage({
        groupId,
        content: fallback,
        mentions: [event.actorId],
        causationId: event.id,
        correlationId: event.correlationId,
      });
      replyEventId = reply.id;
    }

    return {
      decision: {
        action: item ? 'create_work_item' : 'reply',
        reply:
          text ||
          (item
            ? `已建工作项：${item.title}`
            : memberResult
              ? '已处理群成员。'
              : '我在。请补充一下目标或验收标准。'),
        ...(item ? { title: item.title } : {}),
      },
      item,
      replyEventId,
    };
  }
}

function parseToolJson(preview: string): Record<string, unknown> | null {
  const start = preview.indexOf('{');
  const end = preview.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(preview.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

