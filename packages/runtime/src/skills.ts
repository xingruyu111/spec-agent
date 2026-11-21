/** 项目技能解析：agents.yaml 的 skills id → SKILL.md 绝对路径。 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillRef } from '@spec-agent/core';
import { AppError } from '@spec-agent/kernel';

export function resolveProjectSkills(root: string, ids: string[]): SkillRef[] {
  return Array.from(new Set(ids)).map((id) => {
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new AppError('E_SKILL_INVALID', `skill id 不合法：${id}`);
    }
    const candidates = [
      join(root, '.spec-agent', 'skills', id, 'SKILL.md'),
      join(root, 'skills', id, 'SKILL.md'),
      join(root, '.claude', 'skills', id, 'SKILL.md'),
      join(root, '.spec-agent', 'skills', `${id}.md`),
    ];
    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) {
      throw new AppError('E_SKILL_NOT_FOUND', `找不到项目技能 ${id} 的 SKILL.md`);
    }
    const content = readFileSync(path, 'utf8');
    return {
      id,
      name: id,
      path,
      description: skillDescription(content),
    };
  });
}

function skillDescription(content: string): string | undefined {
  const frontmatter = /^description:\s*(.+)$/im.exec(content);
  if (frontmatter) return frontmatter[1]!.trim();
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('---'))
    ?.slice(0, 300);
}
