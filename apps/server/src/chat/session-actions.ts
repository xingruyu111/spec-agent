import { AppError } from '@spec-agent/kernel';
import type { AgentConfig } from '@spec-agent/schema';
import type { ChatRepository } from './chat-store.js';
import type { ChatProjectRow, ChatSessionRow, ChatParticipantRow, ChatMode, ChatPermissionMode, ChatSessionKind, ChangeSetRow } from './store-types.js';
import type { ChangeSetDTO, ChatSessionDetail } from './service-types.js';

type SessionActionsOptions = {
  repo: ChatRepository;
  agents: () => AgentConfig[];
  resolveRoute: (providerId?: string, model?: string) => { providerId: string | null; model: string | null };
};

export class ChatSessionActions {
  constructor(private readonly options: SessionActionsOptions) {}

  listSessions(): ChatSessionRow[] {
    return this.options.repo.listSessions();
  }

  listProjects(): ChatProjectRow[] {
    return this.options.repo.listProjects();
  }

  getProject(id: string): ChatProjectRow | undefined {
    return this.options.repo.getProject(id);
  }

  createProject(input: {
    name: string;
    root?: string;
    repoPath?: string;
    description?: string;
  }): ChatProjectRow {
    const normalized = input.name.trim();
    if (!normalized) {
      throw new AppError('E_CHAT_PROJECT', '项目名称不能为空');
    }
    return this.options.repo.createProject({
      name: normalized,
      root: input.root,
      repoPath: input.repoPath,
      description: input.description,
    });
  }

  deleteProject(id: string): boolean {
    if (!this.options.repo.getProject(id)) {
      throw new AppError('E_CHAT_PROJECT', `项目不存在：${id}`);
    }
    return this.options.repo.deleteProject(id);
  }

  createSession(input: {
    title?: string;
    mode?: ChatMode;
    kind?: ChatSessionKind;
    primaryAgentId?: string | null;
    projectId?: string | null;
    participantAgentIds?: string[];
    providerId?: string | null;
    model?: string | null;
    permissionMode?: ChatPermissionMode;
  } = {}): ChatSessionRow {
    const route = this.options.resolveRoute(input.providerId ?? undefined, input.model ?? undefined);
    const participants = this.validateParticipants(input.participantAgentIds ?? []);
    if (
      input.projectId &&
      !this.options.repo.getProject(input.projectId)
    ) {
      throw new AppError('E_CHAT_PROJECT', `项目不存在：${input.projectId}`);
    }
    if (
      input.kind === 'direct' &&
      input.primaryAgentId &&
      !participants.includes(input.primaryAgentId)
    ) {
      participants.push(input.primaryAgentId);
    }
    return this.options.repo.createSession({
      title: input.title,
      mode: input.mode,
      kind: input.kind,
      primaryAgentId: input.primaryAgentId,
      projectId: input.projectId,
      participantAgentIds: participants,
      providerId: route.providerId,
      model: route.model,
      permissionMode: input.permissionMode,
    });
  }

  addParticipant(sessionId: string, agentId: string): ChatParticipantRow {
    const session = this.options.repo.getSession(sessionId);
    if (!session) throw new AppError('E_CHAT_NOT_FOUND', `对话不存在：${sessionId}`);
    this.validateParticipants([agentId]);
    return this.options.repo.addParticipant(sessionId, agentId, 'member');
  }

  removeParticipant(sessionId: string, agentId: string): boolean {
    const session = this.options.repo.getSession(sessionId);
    if (!session) throw new AppError('E_CHAT_NOT_FOUND', `对话不存在：${sessionId}`);
    return this.options.repo.removeParticipant(sessionId, agentId);
  }

  private validateParticipants(agentIds: string[]): string[] {
    const known = new Set(this.options.agents().map((agent) => String(agent.id)));
    const normalized = [...new Set(agentIds.map((id) => id.trim()).filter(Boolean))];
    for (const agentId of normalized) {
      if (!known.has(agentId)) {
        throw new AppError('E_CHAT_PARTICIPANT', `项目里没有 agent：${agentId}`);
      }
    }
    return normalized;
  }

  renameSession(sessionId: string, title: string): ChatSessionRow {
    const session = this.options.repo.getSession(sessionId);
    if (!session) throw new AppError('E_CHAT_NOT_FOUND', `对话不存在：${sessionId}`);
    const next = title.trim();
    if (!next) throw new AppError('E_CHAT_TITLE', '对话标题不能为空');
    if (next.length > 120) throw new AppError('E_CHAT_TITLE', '对话标题最多 120 字');
    return this.options.repo.updateSession(sessionId, { title: next });
  }

  setRoute(sessionId: string, providerId: string, model: string): ChatSessionRow {    const session = this.options.repo.getSession(sessionId);
    if (!session) throw new AppError('E_CHAT_NOT_FOUND', `对话不存在：${sessionId}`);
    const route = this.options.resolveRoute(providerId, model);
    const changed = session.providerId !== route.providerId || session.model !== route.model;
    return this.options.repo.updateSession(sessionId, {
      providerId: route.providerId,
      model: route.model,
      ...(changed ? { dshSessionId: null } : {}),
    });
  }

  getSessionDetail(id: string, toDTO: (row: ChangeSetRow | undefined) => ChangeSetDTO | null): ChatSessionDetail {
    const session = this.options.repo.getSession(id);
    if (!session) throw new AppError('E_CHAT_NOT_FOUND', `对话不存在：${id}`);
    const messages = this.options.repo.listMessages(id).map((message) => ({
      ...message,
      changeSet: message.changeSetId
        ? toDTO(this.options.repo.getChangeSet(message.changeSetId))
        : null,
      projectPlanDraft: message.projectPlanDraftId
        ? (this.options.repo.getProjectPlanDraft(message.projectPlanDraftId) ?? null)
        : null,
      workflowDraft: message.workflowDraftId
        ? (this.options.repo.getWorkflowDraft(message.workflowDraftId) ?? null)
        : null,
    }));
    return {
      session,
      participants: this.options.repo.listParticipants(id),
      messages,
    };
  }

}

