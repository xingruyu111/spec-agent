import type { AgentConfig } from '@spec-agent/schema';
import type { ChatRepository } from './chat-store.js';

type MentionDeps = {
  repo: ChatRepository;
  agents: () => AgentConfig[];
};

export function resolveMentions(
  deps: MentionDeps,
  sessionId: string,
  text: string,
  explicit: string[] = [],
): string[] {
    const participants = deps.repo.listParticipants(sessionId);
    const known = new Map(
      deps.agents().map((agent) => [String(agent.id), agent]),
    );
    const resolved = new Set(
      explicit
        .map((agentId) => agentId.trim())
        .filter((agentId) => agentId.length > 0),
    );
    for (const participant of participants) {
      if (participant.role !== 'member') continue;
      const agent = known.get(participant.agentId);
      if (!agent) continue;
      const aliases = [`@${agent.name}`, `@${agent.id}`];
      if (aliases.some((alias) => text.includes(alias))) {
        resolved.add(String(agent.id));
      }
    }
    // 显式 mentions 仍然保留，由 replyAsAgents 校验是否已加入会话。
    return [...resolved].slice(0, 3);
}

export function findAgentMentions(
  deps: MentionDeps,
  sessionId: string,
  text: string,
  fromAgentId: string,
  excluded: Set<string>,
): string[] {
    const participants = new Map(
      deps.repo
        .listParticipants(sessionId)
        .filter((item) => item.role === 'member')
        .map((item) => [item.agentId, item]),
    );
    const known = new Map(
      deps.agents().map((agent) => [String(agent.id), agent]),
    );
    const found: string[] = [];
    for (const [agentId] of participants) {
      if (agentId === fromAgentId || excluded.has(agentId)) continue;
      const agent = known.get(agentId);
      if (!agent) continue;
      if (text.includes(`@${agent.name}`) || text.includes(`@${agent.id}`)) {
        found.push(agentId);
      }
    }
    return found.slice(0, 3);
}
