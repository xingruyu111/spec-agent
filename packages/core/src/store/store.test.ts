import { describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { fixedClock, makeEvent, seedRun, seedTask, withStore, withStorePath } from './__fixtures__/index.js';

describe('Store 查询', () => {
  it('按创建时间倒序列任务', () => {
    withStore((store) => {
      store.events.append([
        makeEvent(
          'task.created',
          {
            assignee: 'pm' as never,
            caller: null,
            parentTaskId: null,
            title: '早的',
            brief: 'b',
            inputs: [],
          },
          { taskId: 'task_01', ts: '2026-10-26T01:00:00.000Z' },
        ),
        makeEvent(
          'task.created',
          {
            assignee: 'pm' as never,
            caller: null,
            parentTaskId: null,
            title: '晚的',
            brief: 'b',
            inputs: [],
          },
          { taskId: 'task_02', ts: '2026-10-26T02:00:00.000Z' },
        ),
      ]);

      expect(store.listTasks().map((t) => t.title)).toEqual(['晚的', '早的']);
      expect(store.listTasks(1)).toHaveLength(1);
    });
  });

  it('查询不存在的 id 返回 undefined', () => {
    withStore((store) => {
      expect(store.getTask('nope')).toBeUndefined();
      expect(store.getRun('nope')).toBeUndefined();
      expect(store.getGate('nope')).toBeUndefined();
      expect(store.listRuns('nope')).toEqual([]);
      expect(store.listNodeRuns('nope')).toEqual([]);
    });
  });

  it('合并队列去重、失败和成功状态', () => {
    withStore((store) => {
      const first = store.ensureMerge('task_01', 'node_run_01', 'child_01');
      const second = store.ensureMerge('task_01', 'node_run_01', 'child_01');
      expect(second.id).toBe(first.id);
      expect(first.status).toBe('pending');
      expect(first.attempts).toBe(0);

      store.markMergeAttempt('node_run_01', 'conflict');
      expect(store.getMerge('node_run_01')).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'conflict',
      });

      store.markMergeFailed('node_run_01', 'still conflict');
      expect(store.getMerge('node_run_01')).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: 'still conflict',
      });

      store.markMergePending('node_run_01');
      store.markMergeMerged('node_run_01');
      expect(store.getMerge('node_run_01')).toMatchObject({
        status: 'merged',
        lastError: null,
      });
      expect(store.listMerges('task_01')).toHaveLength(1);
    });
  });

  it('通知 outbox 去重、重试和发送标记', () => {
    withStore((store) => {
      const first = store.ensureNotification('gate_01', 'webhook');
      const second = store.ensureNotification('gate_01', 'webhook');
      expect(second.id).toBe(first.id);
      expect(store.listDueNotifications()).toHaveLength(1);

      store.markNotificationFailed(first.id, null, 'boom');
      const failed = store.getNotification(first.id)!;
      expect(failed.status).toBe('failed');
      expect(failed.attempts).toBe(1);
      expect(failed.lastError).toBe('boom');

      const retry = store.ensureNotification('gate_01', 'feishu');
      store.markNotificationFailed(retry.id, '2099-01-01T00:00:00.000Z', 'later');
      expect(store.getNotification(retry.id)?.status).toBe('pending');
      expect(store.listDueNotifications()).toHaveLength(0);

      store.markNotificationSent(first.id);
      expect(store.getNotification(first.id)?.status).toBe('sent');

      const skipped = store.ensureNotification('gate_01', 'email');
      store.markNotificationSkipped(skipped.id, 'gate 已结束');
      expect(store.getNotification(skipped.id)?.status).toBe('skipped');
      expect(store.listOverallNotifications('gate_01')).toHaveLength(3);
    });
  });

  it('按任务查 run，按 run 查 node', () => {
    withStore((store) => {
      seedRun(store);
      store.events.append([
        makeEvent(
          'node.ready',
          { nodeId: 'plan' as never },
          { taskId: 'task_01', runId: 'run_01', nodeRunId: 'nrun_01' },
        ),
      ]);

      expect(store.listRuns('task_01')).toHaveLength(1);
      expect(store.listRuns('task_01')[0]?.id).toBe('run_01');
      expect(store.listNodeRuns('run_01')).toHaveLength(1);
      expect(store.listNodeRuns('run_01')[0]?.nodeId).toBe('plan');
    });
  });

  it('损坏的 JSON 列不会让查询抛异常', () => {
    withStore((store) => {
      seedTask(store);
      store.db.prepare("UPDATE tasks SET result = '{not json' WHERE id = 'task_01'").run();
      expect(store.getTask('task_01')?.result).toBeNull();
    });
  });

  it('非字符串列也按原值返回', () => {
    withStore((store) => {
      seedTask(store);
      store.db.prepare("UPDATE tasks SET result = 123 WHERE id = 'task_01'").run();
      expect(store.getTask('task_01')?.result).toBe(123);
    });
  });
});

describe('Store 生命周期', () => {
  it('关闭后重开，数据仍在，迁移不重复跑', () => {
    withStorePath((path) => {
      const first = new Store({ path, clock: fixedClock() });
      seedTask(first);
      first.close();

      const second = new Store({ path, clock: fixedClock() });
      try {
        expect(second.getTask('task_01')?.title).toBe('测试任务');
        expect(second.events.count()).toBe(1);
        expect(second.migration.applied).toEqual([]);
        expect(second.migration.currentVersion).toBe(42);
      } finally {
        second.close();
      }
    });
  });

  it('迁移失败时关闭连接并抛出', () => {
    withStorePath((path) => {
      expect(
        () =>
          new Store({
            path,
            clock: fixedClock(),
            migrations: [{ version: 1, name: 'bad', up: 'NOT SQL' }],
          }),
      ).toThrow();

      // 上一次打开失败后连接已关闭，文件还能被正常打开
      const again = new Store({ path, clock: fixedClock() });
      expect(again.migration.currentVersion).toBe(42);
      again.close();
    });
  });
});























