import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from './store.js';

const roots: string[] = [];

function makeStore(): Store {
  const root = mkdtempSync(join(tmpdir(), 'hive-memory-'));
  roots.push(root);
  mkdirSync(join(root, '.spec-agent'), { recursive: true });
  return new Store({ path: join(root, '.spec-agent', 'spec-agent.db') });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('Store memory', () => {
  it('保存 project/agent 记忆，支持过滤、搜索和删除', () => {
    const store = makeStore();
    try {
      const project = store.createMemory({
        scope: 'project',
        content: '组件统一使用 CSS Modules',
        tags: ['frontend', 'frontend'],
        confidence: 0.8,
      });
      const agent = store.createMemory({
        scope: 'agent',
        agentId: 'fe',
        content: '登录页使用 JWT',
        source: 'chat',
      });
      const anonymousAgent = store.createMemory({
        scope: 'agent',
        content: '没有 agent id 时会归一为 null',
      });

      expect(project.tags).toEqual(['frontend']);
      expect(project.confidence).toBe(0.8);
      expect(anonymousAgent.agentId).toBeNull();
      expect(store.listMemories({ scope: 'project' })).toHaveLength(1);
      expect(store.listMemories({ agentId: 'fe' })).toEqual([agent]);
      expect(store.listMemories({ agentId: null }).length).toBe(2);
      expect(store.searchMemories('CSS Modules')).toEqual(
        expect.arrayContaining([project]),
      );
      expect(store.searchMemories('JWT', { agentId: 'fe' })).toEqual([
        agent,
      ]);
      expect(store.searchMemories('不存在的东西')).toEqual([]);
      expect(store.memoryDigest('fe', 'JWT')).toEqual(
        expect.arrayContaining(['登录页使用 JWT']),
      );
      expect(store.deleteMemory(project.id)).toBe(true);
      expect(store.deleteMemory('missing')).toBe(false);
      expect(() => store.createMemory({ scope: 'project', content: '  ' })).toThrow();
    } finally {
      store.close();
    }
  });

  it('没有关键词时返回最近的记忆', () => {
    const store = makeStore();
    try {
      const memory = store.createMemory({
        scope: 'project',
        content: '项目使用 pnpm',
      });
      expect(store.searchMemories('')).toEqual([memory]);
      expect(store.memoryDigest(null, '')).toEqual(['项目使用 pnpm']);
    } finally {
      store.close();
    }
  });
});
