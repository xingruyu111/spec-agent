import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKnowledgeIndex,
  resolveProjectSkills,
} from '../../packages/runtime/src/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('project capabilities', () => {
  it('把 agents.skills 解析为真实 SKILL.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-skills-'));
    roots.push(root);
    const dir = join(root, '.spec-agent', 'skills', 'game');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'description: 游戏开发与验收\n');
    const [skill] = resolveProjectSkills(root, ['game']);
    expect(skill).toMatchObject({ id: 'game', name: 'game', description: '游戏开发与验收' });
    expect(skill!.path).toContain('SKILL.md');
    expect(() => resolveProjectSkills(root, ['missing'])).toThrowError(/找不到/);
  });

  it('知识索引按任务返回相关文件片段，而不是整个仓库', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-knowledge-'));
    roots.push(root);
    writeFileSync(join(root, 'game.md'), '# 游戏\n\n碰撞、计分、暂停和重开规则。');
    writeFileSync(join(root, 'network.md'), '# 网络\n\nWebSocket 重连和限流。');
    const index = createKnowledgeIndex(root);
    const result = index.search('实现游戏碰撞与计分', 2);
    expect(result.join('\n')).toContain('game.md');
    expect(result.join('\n')).toContain('碰撞');
    expect(result.join('\n')).not.toContain('network.md');
  });
});
