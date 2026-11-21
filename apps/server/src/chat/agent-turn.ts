import { AppError } from '@spec-agent/kernel';
import type { AgentRuntime, AgentRuntimeOutput, ProviderConfig } from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import type { ChatRepository } from './chat-store.js';
import type { AgentTurnItem } from './service-types.js';
import type { ChatParticipantRow } from './store-types.js';
import { composeGroupAgentPrompt, composePrivateAgentPrompt } from '../assistant/prompt-composer.js';

type AgentTurnDeps = {
  repo: ChatRepository;
  agentRuntime: AgentRuntime | undefined;
  provider: ProviderConfig | undefined;
  root: string;
  model?: () => string;
  findMentions: (sessionId: string, text: string, agentId: string, excluded: Set<string>) => string[];
};

export async function runAgentTurn(
  deps: AgentTurnDeps,
  input: {
    sessionId: string;
    text: string;
    item: AgentTurnItem;
    participants: Set<string>;
    participantRows: Map<string, ChatParticipantRow>;
    known: Map<string, AgentConfig>;
    onStatus?: (status: string) => void;
    excluded: Set<string>;
    deferWrite: boolean;
  },
): Promise<{ content: string; next: string[]; error: boolean }> {
    const { sessionId, text, item, participants, participantRows, known, onStatus } =
      input;
    const agent = item.agent;
    const agentId = String(agent.id);
    onStatus?.(
      item.relay
        ? `${item.relay.from} @ 了 ${agent.name}，正在回复…`
        : `${agent.name} 正在回复…`,
    );
    const participant = participantRows.get(agentId);
    const allowedTools = (agent.tools?.allow ?? []).filter((tool) =>
      /read|list|glob|grep|search|fetch|todo/i.test(tool),
    );
    const model =
      agent.model?.model && agent.model.model !== 'inherit'
        ? agent.model.model
        : deps.model?.() ?? 'claude-sonnet-4-5';
    const history = deps.repo
      .listMessages(sessionId, 24)
      .map((message) => {
        const who =
          message.senderType === 'user'
            ? '用户'
            : message.senderAgentId ??
              (message.senderType === 'assistant' ? '助理' : '系统');
        return `${who}: ${message.content.slice(0, 1200)}`;
      })
      .join('\n');
    const roster = [...participants]
      .map((id) => {
        const member = known.get(id);
        return member ? `${member.name} (@${id})` : id === 'assistant' ? '助理' : id;
      })
      .join('、');
    const session = deps.repo.getSession(sessionId);
    const systemPrompt =
      session?.kind === 'direct'
        ? composePrivateAgentPrompt(
            agent,
            session?.permissionMode ?? 'read-only',
          )
        : composeGroupAgentPrompt(
            agent,
            session?.permissionMode ?? 'read-only',
          );
    try {
      const output: AgentRuntimeOutput = await deps.agentRuntime!.run({
        systemPrompt,
        task: [
          '以下是当前项目会话的最近上下文：',
          history || '（暂无历史）',
          '',
          `当前会话参与者：${roster}`,
          '',
          ...(item.relay
            ? [`${item.relay.from} 刚刚回复并 @ 了你：`, item.relay.content, '']
            : []),
          `用户最初说：${text}`,
          '',
          '请以你的职责回复用户。需要其他 agent 参与时，可以在回复里 @ 对方。',
        ].join('\n'),
        cwd: deps.root,
        allowedTools,
        skills: [],
        resumeSessionId: participant?.agentSessionId ?? undefined,
        provider: deps.provider!,
        model,
        permissionMode: session?.permissionMode ?? 'read-only',
        budget: { maxTurns: 4, maxUsd: 0.25 },
        signal: new AbortController().signal,
      });
      if (output.stopReason !== 'finished') {
        throw new AppError(
          'E_CHAT_AGENT_FAILED',
          `${agent.name} 返回 ${output.stopReason}${
            output.error?.message ? `：${output.error.message}` : ''
          }`,
        );
      }
      if (output.transcriptRef) {
        deps.repo.setParticipantSession(
          sessionId,
          agentId,
          output.transcriptRef,
        );
      }
      const content = output.text?.trim() || `（${agent.name} 没有返回文本）`;
      const next = deps.findMentions(
        sessionId,
        content,
        agentId,
        input.excluded,
      );
      if (!input.deferWrite) {
        deps.repo.addMessage({
          sessionId,
          role: 'assistant',
          content,
          mode: 'qa',
          senderType: 'agent',
          senderAgentId: agentId,
          mentions: next,
        });
      }
      return { content, next, error: false };
    } catch (error) {
      const content = `${agent.name} 回复失败：${
        error instanceof Error ? error.message : String(error)
      }`;
      if (!input.deferWrite) {
        deps.repo.addMessage({
          sessionId,
          role: 'assistant',
          content,
          mode: 'qa',
          status: 'error',
          senderType: 'agent',
          senderAgentId: agentId,
        });
      }
      return { content, next: [], error: true };
    }
  }

