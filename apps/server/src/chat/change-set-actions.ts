import type { AgentConfig } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';
import { applyOperations } from './parsers.js';
import { saveAgents } from '@spec-agent/runtime';
import type { ChatRepository } from './chat-store.js';
import type { ChangeSetRow } from './store-types.js';
import type { ChangeSetDTO, ChatSessionDetail } from './service-types.js';
import type { ChatEngine, ChatEngineRunResult } from '../dsh/dsh-chat.js';
import type { ChatMode } from './store-types.js';

type ChangeSetOptions = {
  repo: ChatRepository;
  agents: () => AgentConfig[];
  root: string;
  reloadAgents: (agents: AgentConfig[]) => void;
  toDTO: (row: ChangeSetRow | undefined) => ChangeSetDTO | null;
  engine: ChatEngine;
  resolveRoute: (providerId?: string, model?: string) => { providerId: string | null; model: string | null };
  buildQaPrompt: (sessionId: string, text: string) => Promise<string>;
  recordAssistantResult: (sessionId: string, text: string, mode: ChatMode, result: ChatEngineRunResult, opts: { updateTitle: boolean }) => Promise<void>;
  getSessionDetail: (id: string) => ChatSessionDetail;
};

export class ChangeSetActions {
  constructor(private readonly options: ChangeSetOptions) {}

  getChangeSet(id: string): ChangeSetDTO {
    const row = this.options.repo.getChangeSet(id);
    if (!row) throw new AppError('E_CHANGE_SET_NOT_FOUND', `变更草案不存在：${id}`);
    return this.options.toDTO(row)!;
  }

  applyChangeSet(id: string): {
    changeSet: ChangeSetDTO;
    agents: AgentConfig[];
  } {
    const changeSet = this.options.repo.getChangeSet(id);
    if (!changeSet) throw new AppError('E_CHANGE_SET_NOT_FOUND', `变更草案不存在：${id}`);
    if (changeSet.status !== 'pending') {
      throw new AppError('E_CHANGE_SET_CLOSED', '这个变更草案已经处理过了');
    }

    try {
      const next = applyOperations(this.options.agents(), changeSet.operations);
      const saved = saveAgents(this.options.root, next);
      this.options.reloadAgents(saved);
      const updated = this.options.repo.updateChangeSet(id, { status: 'applied' });
      this.options.repo.addMessage({
        sessionId: changeSet.sessionId,
        role: 'system',
        content: `已应用配置变更：${changeSet.summary}`,
        mode: 'qa',
      });
      return { changeSet: this.options.toDTO(updated)!, agents: saved };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.repo.updateChangeSet(id, { error: message });
      throw error instanceof AppError
        ? error
        : new AppError('E_CHANGE_SET_INVALID', message);
    }
  }

  rejectChangeSet(id: string): ChangeSetDTO {
    const changeSet = this.options.repo.getChangeSet(id);
    if (!changeSet) throw new AppError('E_CHANGE_SET_NOT_FOUND', `变更草案不存在：${id}`);
    if (changeSet.status === 'pending') {
      this.options.repo.updateChangeSet(id, { status: 'rejected' });
      this.options.repo.addMessage({
        sessionId: changeSet.sessionId,
        role: 'system',
        content: `已拒绝配置变更：${changeSet.summary}`,
        mode: 'qa',
      });
    }
    return this.options.toDTO(this.options.repo.getChangeSet(id))!;
  }

  async continueAfterChangeSet(id: string): Promise<ChatSessionDetail | null> {
    const changeSet = this.options.repo.getChangeSet(id);
    if (!changeSet || changeSet.status !== 'applied') return null;
    const session = this.options.repo.getSession(changeSet.sessionId);
    if (!session) return null;
    const route = this.options.resolveRoute(
      session.providerId ?? undefined,
      session.model ?? undefined,
    );
    const routeChanged =
      session.providerId !== route.providerId || session.model !== route.model;
    const lastUser =
      [...this.options.repo.listMessages(session.id, 50)]
        .reverse()
        .find((message) => message.role === 'user')?.content ?? changeSet.summary;
    const instruction = [
      `配置变更已应用：${changeSet.summary}`,
      '继续完成你在上一条回复中说明的下一步。',
      '如果下一步是任务拆解或项目计划，直接生成 hive-project-plan 草案；不要重复已经应用的配置变更。',
      '如果不需要后续动作，简短说明配置已生效即可。',
    ].join('\n');
    try {
      const prompt = await this.options.buildQaPrompt(session.id, instruction);
      const result = await this.options.engine.run({
        root: this.options.root,
        sessionId: routeChanged ? null : session.dshSessionId,
        providerId: route.providerId ?? undefined,
        model: route.model ?? undefined,
        permissionMode: session.permissionMode,
        prompt,
      });
      await this.options.recordAssistantResult(session.id, lastUser, 'qa', result, {
        updateTitle: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.repo.addMessage({
        sessionId: session.id,
        role: 'assistant',
        content: `配置已应用，但自动继续执行失败：${message}`,
        mode: 'qa',
        status: 'error',
      });
    }
    return this.options.getSessionDetail(session.id);
  }

}

