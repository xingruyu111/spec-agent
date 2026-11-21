import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toSourceRule } from './rows.js';
import type { WorkSourceRuleRow } from './types.js';

export class SourceRuleRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  listSourceRules(projectId: string): WorkSourceRuleRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM work_source_rules
         WHERE project_id = ? ORDER BY created_at`,
      )
      .all(projectId) as Array<Record<string, unknown>>;
    return rows.map(toSourceRule);
  }

  getSourceRule(
    projectId: string,
    groupId: string | null,
    source: string,
  ): WorkSourceRuleRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM work_source_rules
         WHERE project_id = ? AND source = ?
           AND (group_id = ? OR group_id IS NULL)
         ORDER BY group_id IS NULL ASC LIMIT 1`,
      )
      .get(projectId, source, groupId) as Record<string, unknown> | undefined;
    return row ? toSourceRule(row) : undefined;
  }

  upsertSourceRule(input: {
    projectId: string;
    groupId?: string | null;
    source: string;
    actions: string[];
    labels?: string[];
    authors?: string[];
    enabled?: boolean;
  }): WorkSourceRuleRow {
    const groupId = input.groupId ?? null;
    const existing = this.db
      .prepare(
        `SELECT * FROM work_source_rules
         WHERE project_id = ? AND source = ?
           AND ((group_id IS NULL AND ? IS NULL) OR group_id = ?)`,
      )
      .get(input.projectId, input.source, groupId, groupId) as
      | Record<string, unknown>
      | undefined;
    const actions = Array.from(
      new Set(input.actions.map((action) => action.trim()).filter(Boolean)),
    );
    const labels = Array.from(
      new Set((input.labels ?? []).map((label) => label.trim()).filter(Boolean)),
    );
    const authors = Array.from(
      new Set(
        (input.authors ?? []).map((author) => author.trim()).filter(Boolean),
      ),
    );
    const now = this.clock.iso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE work_source_rules
           SET actions = ?, labels = ?, authors = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(actions),
          JSON.stringify(labels),
          JSON.stringify(authors),
          input.enabled === false ? 0 : 1,
          now,
          String(existing.id),
        );
      return {
        ...toSourceRule(existing),
        actions,
        labels,
        authors,
        enabled: input.enabled !== false,
        updatedAt: now,
      };
    }
    const row: WorkSourceRuleRow = {
      id: `rule-${randomUUID()}`,
      projectId: input.projectId,
      groupId,
      source: input.source,
      actions,
      labels,
      authors,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO work_source_rules
           (id, project_id, group_id, source, actions, labels, authors,
            enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.groupId,
        row.source,
        JSON.stringify(row.actions),
        JSON.stringify(row.labels),
        JSON.stringify(row.authors),
        row.enabled ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  }

  deleteSourceRule(id: string, projectId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM work_source_rules WHERE id = ? AND project_id = ?')
      .run(id, projectId);
    return Number(result.changes) > 0;
  }

}
