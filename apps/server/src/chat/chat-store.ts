/**
 * Chat / change-set persistence.
 *
 * 每个项目已经有一个 SQLite store；聊天表也放在同一个库里，事务和备份边界一致。
 * DSH 的原生 session 只是上下文缓存，Hive 的 chat_messages 才是可审计的源数据。
 */

import { randomUUID } from 'node:crypto';
import type { Clock } from '@spec-agent/kernel';
import type { Database } from '@spec-agent/core';

export type * from './store-types.js';
import { ChatProjectRepository } from './project-repository.js';
import { ChatDraftRepository } from './draft-repository.js';
import { ChatSessionRepository } from './session-repository.js';
import { toMessage } from './store-rows.js';
import type { ChatMode, ChatMessageRow } from './store-types.js';

export class ChatRepository {
  private readonly projects: ChatProjectRepository;
  private readonly drafts: ChatDraftRepository;
  private readonly sessions: ChatSessionRepository;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.projects = new ChatProjectRepository(db, clock);
    this.drafts = new ChatDraftRepository(db, clock);
    this.sessions = new ChatSessionRepository(db, clock);
  }

  createSession(...args: Parameters<ChatSessionRepository['createSession']>) {
    return this.sessions.createSession(...args);
  }

  listParticipants(...args: Parameters<ChatSessionRepository['listParticipants']>) {
    return this.sessions.listParticipants(...args);
  }

  addParticipant(...args: Parameters<ChatSessionRepository['addParticipant']>) {
    return this.sessions.addParticipant(...args);
  }

  setParticipantSession(...args: Parameters<ChatSessionRepository['setParticipantSession']>) {
    return this.sessions.setParticipantSession(...args);
  }

  removeParticipant(...args: Parameters<ChatSessionRepository['removeParticipant']>) {
    return this.sessions.removeParticipant(...args);
  }

  listSessions(...args: Parameters<ChatSessionRepository['listSessions']>) {
    return this.sessions.listSessions(...args);
  }

  getSession(...args: Parameters<ChatSessionRepository['getSession']>) {
    return this.sessions.getSession(...args);
  }

  updateSession(...args: Parameters<ChatSessionRepository['updateSession']>) {
    return this.sessions.updateSession(...args);
  }

  listProjects(...args: Parameters<ChatProjectRepository['listProjects']>) {
    return this.projects.listProjects(...args);
  }

  getProject(...args: Parameters<ChatProjectRepository['getProject']>) {
    return this.projects.getProject(...args);
  }

  createProject(...args: Parameters<ChatProjectRepository['createProject']>) {
    return this.projects.createProject(...args);
  }

  updateProject(...args: Parameters<ChatProjectRepository['updateProject']>) {
    return this.projects.updateProject(...args);
  }

  deleteProject(...args: Parameters<ChatProjectRepository['deleteProject']>) {
    return this.projects.deleteProject(...args);
  }

  addMessage(input: {
    sessionId: string;
    role: ChatMessageRow['role'];
    content: string;
    mode: ChatMode;
    status?: ChatMessageRow['status'];
    reasoning?: string | null;
    taskId?: string | null;
    changeSetId?: string | null;
    projectPlanDraftId?: string | null;
    workflowDraftId?: string | null;
    senderType?: ChatMessageRow['senderType'];
    senderAgentId?: string | null;
    mentions?: string[];
  }): ChatMessageRow {
    const senderType =
      input.senderType ??
      (input.role === 'user'
        ? 'user'
        : input.role === 'system'
          ? 'system'
          : 'assistant');
    const senderAgentId =
      input.senderAgentId !== undefined
        ? input.senderAgentId
        : senderType === 'assistant'
          ? 'assistant'
          : null;
    const message: ChatMessageRow = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      senderType,
      senderAgentId,
      content: input.content,
      reasoning: input.reasoning?.trim() || null,
      mode: input.mode,
      status: input.status ?? 'complete',
      taskId: input.taskId ?? null,
      changeSetId: input.changeSetId ?? null,
      projectPlanDraftId: input.projectPlanDraftId ?? null,
      workflowDraftId: input.workflowDraftId ?? null,
      mentions: [...new Set(input.mentions ?? [])].filter(Boolean),
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO chat_messages
          (id, session_id, role, sender_type, sender_agent_id, content, reasoning,
           mode, status, task_id, change_set_id, project_plan_draft_id,
           workflow_draft_id, mentions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.senderType,
        message.senderAgentId,
        message.content,
        message.reasoning,
        message.mode,
        message.status,
        message.taskId,
        message.changeSetId,
        message.projectPlanDraftId,
        message.workflowDraftId,
        JSON.stringify(message.mentions),
        message.createdAt,
      );
    this.updateSession(input.sessionId, {});
    return message;
  }

  listMessages(sessionId: string, limit = 200): ChatMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(sessionId, Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>;
    return rows.map(toMessage);
  }

  createChangeSet(...args: Parameters<ChatDraftRepository['createChangeSet']>) {
    return this.drafts.createChangeSet(...args);
  }

  getChangeSet(...args: Parameters<ChatDraftRepository['getChangeSet']>) {
    return this.drafts.getChangeSet(...args);
  }

  updateChangeSet(...args: Parameters<ChatDraftRepository['updateChangeSet']>) {
    return this.drafts.updateChangeSet(...args);
  }

  createProjectPlanDraft(...args: Parameters<ChatDraftRepository['createProjectPlanDraft']>) {
    return this.drafts.createProjectPlanDraft(...args);
  }

  getProjectPlanDraft(...args: Parameters<ChatDraftRepository['getProjectPlanDraft']>) {
    return this.drafts.getProjectPlanDraft(...args);
  }

  updateProjectPlanDraft(...args: Parameters<ChatDraftRepository['updateProjectPlanDraft']>) {
    return this.drafts.updateProjectPlanDraft(...args);
  }

  createWorkflowDraft(...args: Parameters<ChatDraftRepository['createWorkflowDraft']>) {
    return this.drafts.createWorkflowDraft(...args);
  }

  getWorkflowDraft(...args: Parameters<ChatDraftRepository['getWorkflowDraft']>) {
    return this.drafts.getWorkflowDraft(...args);
  }

  updateWorkflowDraft(...args: Parameters<ChatDraftRepository['updateWorkflowDraft']>) {
    return this.drafts.updateWorkflowDraft(...args);
  }

  claimMemoryExtraction(taskId: string, sessionId: string): boolean {
    const now = this.clock.iso();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_extractions
          (task_id, session_id, status, error, created_at, updated_at)
         VALUES (?, ?, 'running', NULL, ?, ?)`,
      )
      .run(taskId, sessionId, now, now);
    return result.changes > 0;
  }

  finishMemoryExtraction(taskId: string, error?: string): void {
    this.db
      .prepare(
        `UPDATE memory_extractions
         SET status = ?, error = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(error ? 'failed' : 'done', error ?? null, this.clock.iso(), taskId);
  }

  /** 已结束但还没有 claim 的聊天任务。 */
  listPendingMemoryExtractions(limit = 20): Array<{ taskId: string; sessionId: string }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.task_id AS task_id, m.session_id AS session_id
         FROM chat_messages m
         JOIN tasks t ON t.id = m.task_id
         LEFT JOIN memory_extractions e ON e.task_id = m.task_id
         WHERE m.task_id IS NOT NULL
           AND e.task_id IS NULL
           AND t.status IN ('succeeded', 'failed', 'cancelled')
         ORDER BY m.created_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      taskId: String(row.task_id),
      sessionId: String(row.session_id),
    }));
  }
}


