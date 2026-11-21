import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@spec-agent/core';
import { ContextAssembler } from '../../apps/server/src/infra/context-assembler.js';
import { WorkMemoryStore, WorkMemoryWriter } from '../../apps/server/src/work/work-memory.js';
import { WorkService } from '../../apps/server/src/work/work-service.js';
import { WorkStore } from '../../apps/server/src/work/work-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('ContextAssembler', () => {
  it('装配 Work Item、群聊近况、项目和 Agent 记忆', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-context-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const workStore = new WorkStore(store.db, store.clock);
      const work = new WorkService(workStore);
      const group = workStore.createGroup({ projectId: 'p1', name: '#前端' });
      const intake = work.intakeGroupMessage({
        groupId: group.id,
        author: { type: 'user', id: 'u1' },
        content: '登录页按钮要改成蓝色',
      });
      const triaged = work.triageMessage({
        groupId: group.id,
        eventId: intake.event.id,
      });
      const assignment = workStore.createAssignment({
        workItemId: triaged.item.id,
        agentId: 'fe',
        groupId: group.id,
      });
      store.createMemory({
        scope: 'project',
        content: '项目统一使用 pnpm',
        source: 'test',
      });
      store.createMemory({
        scope: 'agent',
        agentId: 'fe',
        content: '前端偏好小步提交',
        source: 'test',
      });

      work.addWorkItemComment({
        workItemId: triaged.item.id,
        authorType: 'user',
        authorId: 'u1',
        content: '补充：移动端 375px 也要正常',
      });

      const workMemory = new WorkMemoryStore(store.db, store.clock, {
        embeddingProvider: {
          model: 'fake-context-embedding',
          async embed(texts) {
            return texts.map((text) =>
              /蓝|配色/.test(text) ? [1, 0] : [0, 1],
            );
          },
        },
      });
      workMemory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '主题配色是 COBALT-8',
        source: 'semantic',
      });
      new WorkMemoryWriter(workMemory).recordCompletion({
        projectId: 'p1',
        groupId: group.id,
        agentId: 'fe',
        assignmentId: assignment.id,
        workItemId: triaged.item.id,
        title: triaged.item.title,
        kind: 'done',
        summary: '按钮已改为蓝色并验证',
      });

      const context = await new ContextAssembler({
        work,
        store,
        projectId: 'p1',
        memories: workMemory,
      }).assembleAsync(assignment.id);

      expect(context.text).toContain('登录页按钮要改成蓝色');
      expect(context.text).toContain('## 当前群聊近况');
      expect(context.text).toContain('项目统一使用 pnpm');
      expect(context.text).toContain('前端偏好小步提交');
      expect(context.text).toContain('## 群聊记忆');
      expect(context.text).toContain('按钮已改为蓝色并验证');
      expect(context.text).toContain('## Work Item 评论');
      expect(context.text).toContain('移动端 375px 也要正常');
      expect(context.text).toContain('COBALT-8');
      expect(context.text.length).toBeLessThanOrEqual(12_000);
    } finally {
      store.close();
    }
  });
});
