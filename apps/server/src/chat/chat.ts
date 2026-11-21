/**
 * Chat orchestration: DSH for conversation, Hive for project state and writes.
 *
 * 关键边界：
 * - DSH 可以读项目、回答问题和生成变更草案；
 * - 真正写 agents.yaml 必须经过 ChangeSet + 用户 apply；
 * - 任务模式只负责派发到现有 Hive engine，不重新实现 planner。
 */

import type { AgentConfig } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';
import { parseAgents, saveAgents, validateProjectPlanDraft } from '@spec-agent/runtime';
import type {
  ChangeSetRow,
  ChatMode,
  ChatParticipantRow,
  ChatPermissionMode,
  ChatSessionRow,
} from './chat-store.js';
import type { ChatDelta, ChatEngineRunResult } from '../dsh/dsh-chat.js';

export type * from './service-types.js';
import { MemoryExtraction } from './memory-extraction.js';
import { recordAssistantResult } from './assistant-result.js';
import { buildQaPrompt } from './qa-prompt.js';
import { resolveRoute } from './routing.js';
import { findAgentMentions, resolveMentions } from './mentions.js';
import { AgentReplyCoordinator } from './agent-replies.js';
import { runAgentTurn } from './agent-turn.js';
import { sendMessage } from './send-message.js';
import { TaskDispatcher } from './task-dispatch.js';
import { ChatPlanDraftActions } from './plan-draft-actions.js';
import { WorkflowDraftActions } from './workflow-draft-actions.js';
import { ChangeSetActions } from './change-set-actions.js';
import { ChatSessionActions } from './session-actions.js';
import type { AgentTurnItem, ChatServiceOptions, ChatSessionDetail, ChangeSetDTO, MemoryDTO } from './service-types.js';



export class ChatService {
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  private readonly memoryExtraction: MemoryExtraction;
  private readonly taskDispatcher: TaskDispatcher;
  private readonly planDrafts: ChatPlanDraftActions;
  private readonly workflowDrafts: WorkflowDraftActions;
  private readonly changeSets: ChangeSetActions;
  private readonly sessionActions: ChatSessionActions;
  private readonly agentReplies: AgentReplyCoordinator;
  private readonly sweeper?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: ChatServiceOptions) {
    this.agentReplies = new AgentReplyCoordinator({
      repo: options.repo,
      agents: options.agents,
      hasRuntime: Boolean(options.agentRuntime),
      hasProvider: Boolean(options.provider),
      runTurn: (input) => this.runAgentTurn(input),
    });
    this.sessionActions = new ChatSessionActions({
      repo: options.repo,
      agents: options.agents,
      resolveRoute: (providerId, model) => this.resolveRoute(providerId, model),
    });
    this.changeSets = new ChangeSetActions({
      repo: options.repo,
      agents: options.agents,
      root: options.root,
      reloadAgents: options.reloadAgents,
      toDTO: (row) => this.toChangeSetDTO(row),
      engine: options.engine,
      resolveRoute: (providerId, model) => this.resolveRoute(providerId, model),
      buildQaPrompt: (sessionId, text) => this.buildQaPrompt(sessionId, text),
      recordAssistantResult: (sessionId, text, mode, result, opts) =>
        this.recordAssistantResult(sessionId, text, mode, result, opts),
      getSessionDetail: (id) => this.getSessionDetail(id),
    });
    this.workflowDrafts = new WorkflowDraftActions({
      repo: options.repo,
      confirmTask: options.confirmTask,
      autoMemory: options.autoMemory,
      watchTask: (taskId, sessionId) => this.memoryExtraction.watchTask(taskId, sessionId),
      getSessionDetail: (id) => this.getSessionDetail(id),
    });
    this.planDrafts = new ChatPlanDraftActions({
      repo: options.repo,
      createProjectPlan: options.createProjectPlan,
    });
    this.taskDispatcher = new TaskDispatcher({
      repo: options.repo,
      agents: options.agents,
      createTask: options.createTask,
      planTask: options.planTask,
      confirmTask: options.confirmTask,
      autoMemory: options.autoMemory,
      watchTask: (taskId, sessionId) => this.memoryExtraction.watchTask(taskId, sessionId),
    });
    this.memoryExtraction = new MemoryExtraction({
      repo: options.repo,
      store: options.store,
      engine: options.engine,
      root: options.root,
      projectId: options.projectId,
      memory: options.memory,
      watchers: this.watchers,
      isClosed: () => this.closed,
    });
    if (options.autoMemory !== false) {
      this.sweeper = setInterval(() => {
        void this.sweepMemoryExtractions().catch((error) => {
          if (this.closed) return;
          console.warn(
            'memory sweep failed:',
            error instanceof Error ? error.message : error,
          );
        });
      }, 15_000);
      this.sweeper.unref?.();
    }
  }

  listSessions(...args: Parameters<ChatSessionActions['listSessions']>) {
    return this.sessionActions.listSessions(...args);
  }

  listProjects(...args: Parameters<ChatSessionActions['listProjects']>) {
    return this.sessionActions.listProjects(...args);
  }

  getProject(...args: Parameters<ChatSessionActions['getProject']>) {
    return this.sessionActions.getProject(...args);
  }

  createProject(...args: Parameters<ChatSessionActions['createProject']>) {
    return this.sessionActions.createProject(...args);
  }

  deleteProject(...args: Parameters<ChatSessionActions['deleteProject']>) {
    return this.sessionActions.deleteProject(...args);
  }

  createSession(...args: Parameters<ChatSessionActions['createSession']>) {
    return this.sessionActions.createSession(...args);
  }

  addParticipant(...args: Parameters<ChatSessionActions['addParticipant']>) {
    return this.sessionActions.addParticipant(...args);
  }

  removeParticipant(...args: Parameters<ChatSessionActions['removeParticipant']>) {
    return this.sessionActions.removeParticipant(...args);
  }

  renameSession(...args: Parameters<ChatSessionActions['renameSession']>) {
    return this.sessionActions.renameSession(...args);
  }

  setRoute(...args: Parameters<ChatSessionActions['setRoute']>) {
    return this.sessionActions.setRoute(...args);
  }

  private resolveRoute(
    providerId?: string,
    model?: string,
  ): { providerId: string | null; model: string | null } {
    return resolveRoute(
      {
        defaultRoute: this.options.defaultRoute,
        providers: this.options.providers,
      },
      providerId,
      model,
    );
  }

  getSessionDetail(id: string): ChatSessionDetail {
    return this.sessionActions.getSessionDetail(
      id,
      (row) => this.toChangeSetDTO(row),
    );
  }

  async sendMessage(
    sessionId: string,
    content: string,
    mode: ChatMode,
    hooks: {
      onStatus?: (status: string) => void;
      onDelta?: (delta: ChatDelta) => void;
      mentions?: string[];
      parallel?: boolean;
    } = {},
  ): Promise<ChatSessionDetail> {
    return sendMessage(
      {
        repo: this.options.repo,
        engine: this.options.engine,
        root: this.options.root,
        resolveRoute: (providerId, model) => this.resolveRoute(providerId, model),
        resolveMentions: (sessionId, text, explicit) =>
          this.resolveMentions(sessionId, text, explicit),
        dispatchTask: (sessionId, text) => this.dispatchTask(sessionId, text),
        replyAsAgents: (sessionId, text, mentions, onStatus, parallel) =>
          this.replyAsAgents(sessionId, text, mentions, onStatus, parallel),
        buildQaPrompt: (sessionId, text) => this.buildQaPrompt(sessionId, text),
        recordAssistantResult: (sessionId, text, mode, result, options) =>
          this.recordAssistantResult(sessionId, text, mode, result, options),
        getSessionDetail: (id) => this.getSessionDetail(id),
      },
      sessionId,
      content,
      mode,
      hooks,
    );
  }

  private resolveMentions(
    sessionId: string,
    text: string,
    explicit: string[] = [],
  ): string[] {
    return resolveMentions(
      { repo: this.options.repo, agents: this.options.agents },
      sessionId,
      text,
      explicit,
    );
  }

  private async replyAsAgents(
    sessionId: string,
    text: string,
    mentions: string[],
    onStatus?: (status: string) => void,
    parallel = false,
  ): Promise<void> {
    await this.agentReplies.reply(sessionId, text, mentions, onStatus, parallel);
  }

  private async runAgentTurn(input: {
    sessionId: string;
    text: string;
    item: AgentTurnItem;
    participants: Set<string>;
    participantRows: Map<string, ChatParticipantRow>;
    known: Map<string, AgentConfig>;
    onStatus?: (status: string) => void;
    excluded: Set<string>;
    deferWrite: boolean;
  }): Promise<{ content: string; next: string[]; error: boolean }> {
    return runAgentTurn(
      {
        repo: this.options.repo,
        agentRuntime: this.options.agentRuntime,
        provider: this.options.provider,
        root: this.options.root,
        model: this.options.model,
        findMentions: (sessionId, text, agentId, excluded) =>
          this.findAgentMentions(sessionId, text, agentId, excluded),
      },
      input,
    );
  }

  private findAgentMentions(
    sessionId: string,
    text: string,
    fromAgentId: string,
    excluded: Set<string>,
  ): string[] {
    return findAgentMentions(
      { repo: this.options.repo, agents: this.options.agents },
      sessionId,
      text,
      fromAgentId,
      excluded,
    );
  }

  setMode(sessionId: string, mode: ChatMode): ChatSessionRow {
    return this.options.repo.updateSession(sessionId, { mode });
  }

  setPermissionMode(
    sessionId: string,
    permissionMode: ChatPermissionMode,
  ): ChatSessionRow {
    if (
      permissionMode !== 'read-only' &&
      permissionMode !== 'workspace-write' &&
      permissionMode !== 'danger-full-access'
    ) {
      throw new AppError('E_CHAT_PERMISSION', '无效的聊天权限模式');
    }
    return this.options.repo.updateSession(sessionId, { permissionMode });
  }

  getChangeSet(...args: Parameters<ChangeSetActions['getChangeSet']>) {
    return this.changeSets.getChangeSet(...args);
  }

  applyChangeSet(...args: Parameters<ChangeSetActions['applyChangeSet']>) {
    return this.changeSets.applyChangeSet(...args);
  }

  async continueAfterChangeSet(id: string): Promise<ChatSessionDetail | null> {
    return this.changeSets.continueAfterChangeSet(id);
  }

  rejectChangeSet(...args: Parameters<ChangeSetActions['rejectChangeSet']>) {
    return this.changeSets.rejectChangeSet(...args);
  }

  getProjectPlanDraft(...args: Parameters<ChatPlanDraftActions['getProjectPlanDraft']>) {
    return this.planDrafts.getProjectPlanDraft(...args);
  }

  applyProjectPlanDraft(...args: Parameters<ChatPlanDraftActions['applyProjectPlanDraft']>) {
    return this.planDrafts.applyProjectPlanDraft(...args);
  }

  rejectProjectPlanDraft(...args: Parameters<ChatPlanDraftActions['rejectProjectPlanDraft']>) {
    return this.planDrafts.rejectProjectPlanDraft(...args);
  }

  listMemories(agentId?: string | null): MemoryDTO[] {
    return this.options.store
      .listMemories(agentId ? { agentId } : {})
      .map(toMemoryDTO);
  }

  /** 自动提取的显式入口；watcher、sweeper 和集成测试共用。 */
  async extractMemoriesForTask(taskId: string, sessionId: string): Promise<void> {
    await this.memoryExtraction.run(taskId, sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const timer of this.watchers.values()) clearInterval(timer);
    this.watchers.clear();
    await this.options.engine.close();
  }

  private async dispatchTask(sessionId: string, goal: string): Promise<void> {
    await this.taskDispatcher.dispatch(sessionId, goal);
  }

  confirmWorkflowDraft(...args: Parameters<WorkflowDraftActions['confirmWorkflowDraft']>) {
    return this.workflowDrafts.confirmWorkflowDraft(...args);
  }

  rejectWorkflowDraft(...args: Parameters<WorkflowDraftActions['rejectWorkflowDraft']>) {
    return this.workflowDrafts.rejectWorkflowDraft(...args);
  }

  private async recordAssistantResult(
    sessionId: string,
    userText: string,
    mode: ChatMode,
    result: ChatEngineRunResult,
    options: { updateTitle: boolean },
  ): Promise<void> {
    await recordAssistantResult(
      {
        repo: this.options.repo,
        agents: this.options.agents,
        maxWorkstreams: this.options.maxWorkstreams,
        memory: this.options.memory,
        projectId: this.options.projectId,
      },
      sessionId,
      userText,
      mode,
      result,
      options,
    );
  }

  private async buildQaPrompt(sessionId: string, content: string): Promise<string> {
    return buildQaPrompt(
      {
        root: this.options.root,
        projectName: this.options.projectName,
        projectId: this.options.projectId,
        memory: this.options.memory,
        store: this.options.store,
        repo: this.options.repo,
        agents: this.options.agents,
      },
      sessionId,
      content,
    );
  }

  private async sweepMemoryExtractions(): Promise<void> {
    await this.memoryExtraction.sweep();
  }

  private toChangeSetDTO(row: ChangeSetRow | undefined): ChangeSetDTO | null {
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      summary: row.summary,
      operations: row.operations,
      status: row.status,
      error: row.error,
      createdAt: row.createdAt,
      appliedAt: row.appliedAt,
    };
  }
}

function toMemoryDTO(memory: {
  id: string;
  scope: string;
  agentId: string | null;
  content: string;
  source: string | null;
  tags: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}): MemoryDTO {
  return { ...memory };
}
