import { randomUUID } from 'node:crypto';
import type { Database } from '@spec-agent/core';
import type { Clock } from '@spec-agent/kernel';
import { toProject } from './store-rows.js';
import type { ChatProjectRow } from './store-types.js';

export class ChatProjectRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  listProjects(): ChatProjectRow[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_projects ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(toProject);
  }

  getProject(id: string): ChatProjectRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM chat_projects WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? toProject(row) : undefined;
  }

  createProject(input: {
    name: string;
    description?: string | null;
    root?: string | null;
    repoPath?: string | null;
    status?: 'active' | 'archived';
  }): ChatProjectRow {
    const now = this.clock.iso();
    const project: ChatProjectRow = {
      id: randomUUID(),
      name: input.name.trim().slice(0, 80) || '新项目',
      description: input.description?.trim() || null,
      root: input.root?.trim() || null,
      repoPath: input.repoPath?.trim() || null,
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO chat_projects
           (id, name, description, root, repo_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.description,
        project.root,
        project.repoPath,
        project.status,
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  updateProject(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      root?: string | null;
      repoPath?: string | null;
      status?: 'active' | 'archived';
    },
  ): ChatProjectRow {
    const current = this.getProject(id);
    if (!current) throw new Error(`项目不存在：${id}`);
    const next: ChatProjectRow = {
      ...current,
      ...(patch.name !== undefined
        ? { name: patch.name.trim().slice(0, 80) || current.name }
        : {}),
      ...(patch.description !== undefined
        ? { description: patch.description?.trim() || null }
        : {}),
      ...(patch.root !== undefined
        ? { root: patch.root?.trim() || null }
        : {}),
      ...(patch.repoPath !== undefined
        ? { repoPath: patch.repoPath?.trim() || null }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: this.clock.iso(),
    };
    this.db
      .prepare(
        `UPDATE chat_projects
         SET name = ?, description = ?, root = ?, repo_path = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.root,
        next.repoPath,
        next.status,
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteProject(id: string): boolean {
    this.db
      .prepare('UPDATE chat_sessions SET project_id = NULL WHERE project_id = ?')
      .run(id);
    return (
      this.db.prepare('DELETE FROM chat_projects WHERE id = ?').run(id).changes > 0
    );
  }

}
