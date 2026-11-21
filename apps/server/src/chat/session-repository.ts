import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toParticipant, toSession } from './store-rows.js';
import type {
  ChatMode,
  ChatSessionKind,
  ChatSessionRow,
  ChatParticipantRow,
  ChatPermissionMode,
  ChatParticipantRole,
} from './store-types.js';

export class ChatSessionRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  createSession(input: {
    title?: string;
    mode?: ChatMode;
    kind?: ChatSessionKind;
    assistantAgentId?: string;
    primaryAgentId?: string | null;
    projectId?: string | null;
    providerId?: string | null;
    model?: string | null;
    permissionMode?: ChatPermissionMode;
    participantAgentIds?: string[];
  } = {}): ChatSessionRow {
    const now = this.clock.iso();
    const assistantAgentId = input.assistantAgentId?.trim() || 'assistant';
    const session: ChatSessionRow = {
      id: randomUUID(),
      title: (input.title ?? '新对话').trim().slice(0, 120) || '新对话',
      mode: input.mode ?? 'qa',
      kind: input.kind ?? 'assistant',
      assistantAgentId,
      primaryAgentId: input.primaryAgentId?.trim() || null,
      projectId: input.projectId?.trim() || null,
      dshSessionId: null,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? 'read-only',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO chat_sessions
          (id, title, mode, kind, assistant_agent_id, primary_agent_id,
           project_id, dsh_session_id, provider_id, model, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.mode,
        session.kind,
        session.assistantAgentId,
        session.primaryAgentId,
        session.projectId,
        session.dshSessionId,
        session.providerId,
        session.model,
        session.permissionMode,
        session.createdAt,
        session.updatedAt,
      );
    this.addParticipant(session.id, assistantAgentId, 'assistant');
    for (const agentId of new Set(input.participantAgentIds ?? [])) {
      if (agentId && agentId !== assistantAgentId) {
        this.addParticipant(session.id, agentId, 'member');
      }
    }
    return session;
  }

  listParticipants(sessionId: string): ChatParticipantRow[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_participants WHERE session_id = ? ORDER BY joined_at ASC')
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(toParticipant);
  }

  addParticipant(
    sessionId: string,
    agentId: string,
    role: ChatParticipantRole = 'member',
  ): ChatParticipantRow {
    const joinedAt = this.clock.iso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO chat_participants
          (session_id, agent_id, role, agent_session_id, joined_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(sessionId, agentId, role, joinedAt);
    const row = this.db
      .prepare('SELECT * FROM chat_participants WHERE session_id = ? AND agent_id = ?')
      .get(sessionId, agentId) as Record<string, unknown>;
    return toParticipant(row);
  }

  setParticipantSession(
    sessionId: string,
    agentId: string,
    agentSessionId: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE chat_participants SET agent_session_id = ?
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(agentSessionId, sessionId, agentId);
  }

  removeParticipant(sessionId: string, agentId: string): boolean {    const row = this.db
      .prepare('SELECT role FROM chat_participants WHERE session_id = ? AND agent_id = ?')
      .get(sessionId, agentId) as { role?: string } | undefined;
    if (!row || row.role === 'assistant') return false;
    return (
      this.db
        .prepare('DELETE FROM chat_participants WHERE session_id = ? AND agent_id = ?')
        .run(sessionId, agentId).changes > 0
    );
  }

  listSessions(limit = 30): ChatSessionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
    return rows.map(toSession);
  }

  getSession(id: string): ChatSessionRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM chat_sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toSession(row) : undefined;
  }

  updateSession(
    id: string,
    patch: {
      title?: string;
      mode?: ChatMode;
      projectId?: string | null;
      dshSessionId?: string | null;
      providerId?: string | null;
      model?: string | null;
      permissionMode?: ChatPermissionMode;
    },
  ): ChatSessionRow {
    const current = this.getSession(id);
    if (!current) throw new Error(`chat session 不存在：${id}`);
    const next: ChatSessionRow = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title.slice(0, 120) || current.title } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.projectId !== undefined
        ? { projectId: patch.projectId?.trim() || null }
        : {}),
      ...(patch.dshSessionId !== undefined ? { dshSessionId: patch.dshSessionId } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.permissionMode !== undefined
        ? { permissionMode: patch.permissionMode }
        : {}),
      updatedAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET title = ?, mode = ?, project_id = ?, dsh_session_id = ?, provider_id = ?, model = ?, permission_mode = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.mode,
        next.projectId,
        next.dshSessionId,
        next.providerId,
        next.model,
        next.permissionMode,
        next.updatedAt,
        id,
      );
    return next;
  }

}
