import { AppError } from '@spec-agent/kernel';
import type { AgentConfig } from '@spec-agent/schema';
import type { ChatRepository } from './chat-store.js';
import type { AgentTurnItem } from './service-types.js';
import type { ChatParticipantRow } from './store-types.js';

type AgentTurnInput = {
  sessionId: string;
  text: string;
  item: AgentTurnItem;
  participants: Set<string>;
  participantRows: Map<string, ChatParticipantRow>;
  known: Map<string, AgentConfig>;
  onStatus?: (status: string) => void;
  excluded: Set<string>;
  deferWrite: boolean;
};

type AgentReplyOptions = {
  repo: ChatRepository;
  agents: () => AgentConfig[];
  hasRuntime: boolean;
  hasProvider: boolean;
  runTurn: (input: AgentTurnInput) => Promise<{ content: string; next: string[]; error: boolean }>;
};

export class AgentReplyCoordinator {
  constructor(private readonly options: AgentReplyOptions) {}

  async reply(
    sessionId: string,
    text: string,
    mentions: string[],
    onStatus?: (status: string) => void,
    parallel = false,
  ): Promise<void> {
    if (!this.options.hasRuntime) {
      throw new AppError('E_CHAT_AGENT_UNAVAILABLE', '当前 host 没有可用的 AgentRuntime');
    }
    if (!this.options.hasProvider) {
      throw new AppError('E_CHAT_AGENT_UNAVAILABLE', '当前项目没有配置模型供应商');
    }
    const participants = new Set(
      this.options.repo.listParticipants(sessionId).map((item) => item.agentId),
    );
    const participantRows = new Map(
      this.options.repo
        .listParticipants(sessionId)
        .map((item) => [item.agentId, item]),
    );
    const known = new Map(
      this.options.agents().map((agent) => [String(agent.id), agent]),
    );
    const resolveAgent = (agentId: string): AgentConfig => {
      if (!participants.has(agentId)) {
        throw new AppError(
          'E_CHAT_PARTICIPANT',
          `${agentId} 还没有加入当前会话，请先拉入 agent`,
        );
      }
      const agent = known.get(agentId);
      if (!agent) throw new AppError('E_CHAT_PARTICIPANT', `项目里没有 agent：${agentId}`);
      return agent;
    };

    type Pending = AgentTurnItem;
    const maxTurns = 3;
    const queue: Pending[] = mentions
      .slice(0, maxTurns)
      .map((agentId) => ({ agent: resolveAgent(agentId), relay: null }));
    const queued = new Set(queue.map((item) => String(item.agent.id)));
    const visited = new Set<string>();

    const enqueueNext = (
      item: Pending,
      result: { content: string; next: string[] },
    ): void => {
      for (const nextId of result.next) {
        if (visited.has(nextId) || queued.has(nextId)) continue;
        const nextAgent = known.get(nextId);
        if (!nextAgent) continue;
        queue.push({
          agent: nextAgent,
          relay: { from: item.agent.name, content: result.content },
        });
        queued.add(nextId);
      }
    };

    const runOne = async (item: Pending): Promise<void> => {
      const agentId = String(item.agent.id);
      if (visited.has(agentId)) return;
      visited.add(agentId);
      const result = await this.options.runTurn({
        sessionId,
        text,
        item,
        participants,
        participantRows,
        known,
        onStatus,
        excluded: new Set([...visited, ...queued]),
        deferWrite: false,
      });
      enqueueNext(item, result);
    };

    // 并行只作用于本轮初始 @ 的第一批 agent；接力仍按队列串行。
    if (parallel && queue.length > 1) {
      const batch = queue.splice(0, queue.length);
      for (const item of batch) visited.add(String(item.agent.id));
      const results = await Promise.all(
        batch.map((item) =>
          this.options.runTurn({
            sessionId,
            text,
            item,
            participants,
            participantRows,
            known,
            onStatus,
            excluded: new Set([...visited, ...queued]),
            deferWrite: true,
          }),
        ),
      );
      results.forEach((result, index) => {
        const item = batch[index];
        if (!item) return;
        this.options.repo.addMessage({
          sessionId,
          role: 'assistant',
          content: result.content,
          mode: 'qa',
          ...(result.error ? { status: 'error' as const } : {}),
          senderType: 'agent',
          senderAgentId: String(item.agent.id),
          mentions: result.next,
        });
        enqueueNext(item, result);
      });
    }

    while (queue.length > 0 && visited.size < maxTurns) {
      const item = queue.shift()!;
      await runOne(item);
    }
  }

}
