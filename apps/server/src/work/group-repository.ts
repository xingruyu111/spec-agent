import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toEvent, toGroup } from './rows.js';
import type { WorkActorType, WorkEventRow, WorkEventType, WorkGroupMemberRow, WorkGroupRow } from './types.js';

export class WorkGroupRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  createGroup(input: {
    projectId: string;
    name: string;
    topic?: string | null;
    members?: Array<{
      type: WorkActorType;
      id: string;
      role?: string;
    }>;
  }): WorkGroupRow {
    const now = this.clock.iso();
    const id = `group-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO work_groups (id, project_id, name, topic, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.name, input.topic ?? null, now, now);
    for (const member of input.members ?? []) {
      this.addMember(id, member.type, member.id, member.role);
    }
    return this.getGroup(id)!;
  }

  getGroup(id: string): WorkGroupRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM work_groups WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toGroup(row) : undefined;
  }

  listGroups(projectId: string): WorkGroupRow[] {
    const rows = this.db
      .prepare('SELECT * FROM work_groups WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(toGroup);
  }

  addMember(
    groupId: string,
    type: WorkActorType,
    memberId: string,
    role = 'member',
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO work_group_members
           (group_id, member_type, member_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(groupId, type, memberId, role, this.clock.iso());
  }

  listMembers(groupId: string): WorkGroupMemberRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_group_members
         WHERE group_id = ? ORDER BY created_at`,
      )
      .all(groupId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      groupId: String(row.group_id),
      memberType: row.member_type as WorkActorType,
      memberId: String(row.member_id),
      role: String(row.role ?? 'member'),
      createdAt: String(row.created_at),
    }));
  }

  findEventByDedupeKey(dedupeKey: string): WorkEventRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM domain_events WHERE dedupe_key = ?')
      .get(dedupeKey) as Record<string, unknown> | undefined;
    return row ? toEvent(row) : undefined;
  }

  appendEvent(input: {    projectId?: string | null;
    groupId?: string | null;
    type: WorkEventType;
    actor: { type: WorkActorType; id: string };
    payload: Record<string, unknown>;
    correlationId?: string;
    causationId?: string | null;
    dedupeKey?: string;
    depth?: number;
  }): { event: WorkEventRow; duplicate: boolean } {
    const dedupeKey = input.dedupeKey ?? `evt-${randomUUID()}`;
    const existing = this.db
      .prepare('SELECT * FROM domain_events WHERE dedupe_key = ?')
      .get(dedupeKey) as Record<string, unknown> | undefined;
    if (existing) {
      return { event: toEvent(existing), duplicate: true };
    }
    const row: WorkEventRow = {
      id: `evt-${randomUUID()}`,
      projectId: input.projectId ?? null,
      groupId: input.groupId ?? null,
      type: input.type,
      actorType: input.actor.type,
      actorId: input.actor.id,
      payload: input.payload,
      correlationId: input.correlationId ?? `corr-${randomUUID()}`,
      causationId: input.causationId ?? null,
      dedupeKey,
      depth: input.depth ?? 0,
      createdAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `INSERT INTO domain_events
           (id, project_id, group_id, type, actor_type, actor_id, payload,
            correlation_id, causation_id, dedupe_key, depth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.groupId,
        row.type,
        row.actorType,
        row.actorId,
        JSON.stringify(row.payload),
        row.correlationId,
        row.causationId,
        row.dedupeKey,
        row.depth,
        row.createdAt,
      );
    return { event: row, duplicate: false };
  }

  listEvents(groupId: string, limit = 100): WorkEventRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM domain_events WHERE group_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(groupId, Math.min(Math.max(limit, 1), 500)) as Array<
      Record<string, unknown>
    >;
    return rows.reverse().map(toEvent);
  }

  getEvent(id: string): WorkEventRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM domain_events WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toEvent(row) : undefined;
  }

}

