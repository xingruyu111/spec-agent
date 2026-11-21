import type { ProjectConfig } from './types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function loadProjectsFile(file: string): ProjectConfig[] | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const raw = Array.isArray(parsed)
    ? parsed
    : (parsed as { projects?: unknown })?.projects;
  if (!Array.isArray(raw)) throw new Error(`项目注册表格式错误：${file}`);
  if (raw.length === 0) return [];
  const projects = raw.map((entry) => {
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const root = typeof item.root === 'string' ? item.root.trim() : '';
    if (!id || !name || !root) throw new Error(`项目注册表条目缺少 id/name/root：${file}`);
    return { id, name, root: resolve(root) };
  });
  assertProjects(projects);
  return projects;
}

export function saveProjectsFile(file: string, projects: ProjectConfig[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ projects }, null, 2), 'utf8');
}

export function assertProjects(projects: ProjectConfig[]): void {
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const project of projects) {
    if (!project.id || !project.name || !project.root) throw new Error('项目缺少 id/name/root');
    if (ids.has(project.id)) throw new Error(`项目 id 重复：${project.id}`);
    const root = resolve(project.root).toLowerCase();
    if (roots.has(root)) throw new Error(`项目目录重复：${project.root}`);
    ids.add(project.id);
    roots.add(root);
  }
}

export function projectErrorStatus(code: string): number {
  if (code === 'E_PROJECT_NOT_FOUND') return 404;
  if (code === 'E_PROJECT_INVALID' || code === 'E_IMPORT_INVALID' || code === 'E_BAD_JSON') return 400;
  if (code === 'E_BODY_TOO_LARGE') return 413;
  if (code === 'E_FOLDER_PICKER') return 503;
  return 409;
}
