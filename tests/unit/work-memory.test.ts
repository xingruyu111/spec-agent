import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@spec-agent/core';
import { WorkMemoryStore, WorkMemoryWriter } from '../../apps/server/src/work/work-memory.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function setup(): { store: Store; memory: WorkMemoryStore } {
  const dir = mkdtempSync(join(tmpdir(), 'spec-agent-memory-'));
  dirs.push(dir);
  const store = new Store({ path: join(dir, 'db.sqlite') });
  return {
    store,
    memory: new WorkMemoryStore(store.db, store.clock),
  };
}

describe('WorkMemoryStore', () => {
  it('按词法相关度排序，并过滤过期记忆', () => {
    const { store, memory } = setup();
    try {
      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 BLUE-42',
        source: 'seed-1',
      });
      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '部署使用 Docker',
        source: 'seed-2',
      });
      memory.write({
        projectId: 'p1',
        scopeType: 'group',
        scopeId: 'g1',
        content: '项目代号是 OLD-1',
        source: 'expired',
        expiresAt: '2000-01-01T00:00:00.000Z',
      });

      const hits = memory.search({
        projectId: 'p1',
        query: '项目代号是什么',
        limit: 5,
      });
      expect(hits[0]?.content).toContain('BLUE-42');
      expect(hits[0]?.lexicalScore).toBeGreaterThan(0);
      expect(hits[0]?.vectorScore).toBeGreaterThan(0);
      expect(hits.some((hit) => hit.content.includes('Docker'))).toBe(false);
      expect(hits.some((hit) => hit.content.includes('OLD-1'))).toBe(false);
      expect(
        memory.search({
          projectId: 'p1',
          query: '完全不存在',
          fallback: false,
        }),
      ).toEqual([]);

      const conflicts = memory.findConflicts({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 GREEN-7',
      });
      expect(conflicts[0]?.memory.content).toContain('BLUE-42');
      expect(conflicts[0]?.score).toBeGreaterThan(0);

      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 ORANGE-3',
        source: 'auto',
        autoResolveConflicts: true,
      });
      expect(
        memory.search({
          projectId: 'p1',
          query: '项目代号',
          fallback: false,
        })[0]?.content,
      ).toContain('ORANGE-3');
      expect(hits[0]?.lastUsedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('同作用域相同内容合并，不重复插入', () => {
    const { store, memory } = setup();
    try {
      memory.write({
        projectId: 'p1',
        scopeType: 'group',
        scopeId: 'g1',
        content: '统一使用 pnpm',
        source: 'a',
      });
      memory.write({
        projectId: 'p1',
        scopeType: 'group',
        scopeId: 'g1',
        content: '统一使用   pnpm',
        source: 'b',
      });
      expect(
        memory.list({ projectId: 'p1', scopeType: 'group', scopeId: 'g1' }),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('supersede 使旧事实过期，并写入 private 记忆', () => {
    const { store, memory } = setup();
    try {
      const old = memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 BLUE-42',
        source: 'old',
      });
      const next = memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 GREEN-7',
        source: 'new',
        supersedes: [old.id],
      });
      const hits = memory.search({
        projectId: 'p1',
        query: '项目代号',
        limit: 10,
      });
      expect(hits[0]?.id).toBe(next.id);
      expect(hits.some((hit) => hit.id === old.id)).toBe(false);

      new WorkMemoryWriter(memory).recordCompletion({
        projectId: 'p1',
        privateThreadId: 'dm-1',
        agentId: 'assistant',
        assignmentId: 'asg-1',
        workItemId: 'wi-1',
        title: '私聊需求',
        kind: 'done',
        summary: '已完成',
      });
      expect(
        memory.list({
          projectId: 'p1',
          scopeType: 'private',
          scopeId: 'dm-1',
        }),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('TTL 过期记忆默认隐藏并可清理', () => {
    const { store, memory } = setup();
    try {
      memory.write({
        projectId: 'p1',
        scopeType: 'execution',
        scopeId: 'asg-1',
        content: '临时执行记忆',
        source: 'ttl',
        expiresAt: '2000-01-01T00:00:00.000Z',
      });
      expect(
        memory.list({
          projectId: 'p1',
          scopeType: 'execution',
          scopeId: 'asg-1',
        }),
      ).toHaveLength(0);
      expect(
        memory.list({
          projectId: 'p1',
          scopeType: 'execution',
          scopeId: 'asg-1',
          includeExpired: true,
        }),
      ).toHaveLength(1);
      expect(memory.cleanupExpired('p1')).toBe(1);
      expect(
        memory.list({
          projectId: 'p1',
          scopeType: 'execution',
          scopeId: 'asg-1',
          includeExpired: true,
        }),
      ).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('外部 embedding 按向量相关度排序', async () => {
    const { store } = setup();
    try {
      const memory = new WorkMemoryStore(store.db, store.clock, {
        embeddingProvider: {
          model: 'fake-embedding',
          async embed(texts) {
            return texts.map((text) =>
              text.includes('红') ? [1, 0] : [0, 1],
            );
          },
        },
      });
      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '主题色是红色',
        source: 'red',
      });
      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '部署使用 Docker',
        source: 'blue',
      });
      const hits = await memory.searchAsync({
        projectId: 'p1',
        query: '红色',
        limit: 2,
      });
      expect(hits[0]?.content).toContain('红色');
      expect(hits[0]?.vectorScore).toBeGreaterThan(0.9);
    } finally {
      store.close();
    }
  });

  it('外部 embedding 结果持久化，重建 store 不再重复请求', async () => {
    const { store } = setup();
    try {
      let calls = 0;
      const provider = {
        model: 'persist-embedding',
        async embed(texts: string[]) {
          calls += texts.length;
          return texts.map((text) => (text.includes('红') ? [1, 0] : [0, 1]));
        },
      };
      const first = new WorkMemoryStore(store.db, store.clock, {
        embeddingProvider: provider,
      });
      first.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '主题色是红色',
        source: 'persist-red',
      });
      await first.searchAsync({ projectId: 'p1', query: '红色', limit: 1 });
      expect(calls).toBeGreaterThan(0);
      expect(first.embeddingStats('p1').project?.calls).toBeGreaterThan(0);
      expect(first.embeddingStats('other').project).toBeNull();

      const second = new WorkMemoryStore(store.db, store.clock, {
        embeddingProvider: provider,
      });
      expect(second.embeddingStats().calls).toBeGreaterThan(0);
      const before = calls;
      const hits = await second.searchAsync({
        projectId: 'p1',
        query: '红色',
        limit: 1,
      });
      expect(hits[0]?.content).toContain('红色');
      expect(calls).toBe(before);
      expect(second.embeddingStats().vectors).toBeGreaterThan(0);
      expect(second.cleanupVectors({ olderThanDays: -1 })).toBeGreaterThan(0);
      expect(second.embeddingStats().vectors).toBe(0);
    } finally {
      store.close();
    }
  });

  it('provider 失败回退本地检索并记录指标', async () => {
    const { store } = setup();
    try {
      const memory = new WorkMemoryStore(store.db, store.clock, {
        embeddingProvider: {
          model: 'broken-embedding',
          async embed() {
            throw new Error('embedding down');
          },
        },
      });
      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 BLUE-42',
        source: 'fallback',
      });
      const hits = await memory.searchAsync({
        projectId: 'p1',
        query: '项目代号',
      });
      expect(hits[0]?.content).toContain('BLUE-42');
      const stats = memory.embeddingStats();
      expect(stats.failures).toBe(1);
      expect(stats.lastError).toContain('embedding down');
      const reopened = new WorkMemoryStore(store.db, store.clock, {
        embeddingProvider: {
          model: 'broken-embedding',
          async embed() {
            return [];
          },
        },
      });
      expect(reopened.embeddingStats().failures).toBe(1);
      expect(reopened.embeddingStats().lastError).toContain('embedding down');
    } finally {
      store.close();
    }
  });

  it('版本清理保留最近 N 条', () => {
    const { store } = setup();
    try {
      const memory = new WorkMemoryStore(store.db, store.clock);
      const row = memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: 'v0',
        source: 'versions',
      });
      memory.updateContent(row.id, 'p1', 'v1');
      memory.updateContent(row.id, 'p1', 'v2');
      memory.updateContent(row.id, 'p1', 'v3');
      expect(memory.listVersions(row.id, 'p1')).toHaveLength(3);
      const deleted = memory.cleanupVersions({
        keepPerMemory: 1,
        olderThanDays: -1,
      });
      expect(deleted).toBe(2);
      expect(memory.listVersions(row.id, 'p1')).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
