import { describe, expect, it } from 'vitest';
import { AppError } from '@spec-agent/kernel';
import { makeEvent, seedTask, withStore } from './__fixtures__/index.js';

describe('EventStore.append', () => {
  it('分配连续递增的 seq', () => {
    withStore((store) => {
      const seqs = store.events.append([
        makeEvent('task.started', {}, { taskId: 'task_01' }),
        makeEvent('run.paused', { reason: 'x' }),
        makeEvent('run.resumed', {}),
      ]);
      expect(seqs).toEqual([1, 2, 3]);
      expect(store.events.lastSeq()).toBe(3);
      expect(store.events.count()).toBe(3);
    });
  });

  it('空数组不写任何东西', () => {
    withStore((store) => {
      expect(store.events.append([])).toEqual([]);
      expect(store.events.lastSeq()).toBe(0);
    });
  });

  it('重复事件 id 会整体回滚', () => {
    withStore((store) => {
      const event = makeEvent(
        'task.created',
        {
          assignee: 'pm' as never,
          caller: null,
          parentTaskId: null,
          title: 't',
          brief: 'b',
          inputs: [],
        },
        { taskId: 'task_01', id: 'evt_same' },
      );
      expect(() => store.events.append([event, { ...event, taskId: undefined } as never])).toThrow(
        AppError,
      );
      expect(store.events.count()).toBe(0);
      expect(store.listTasks()).toEqual([]);
    });
  });

  it('expectedSeq 不一致时拒绝写入', () => {
    withStore((store) => {
      store.events.append([makeEvent('run.paused', { reason: 'x' })]);
      expect(() =>
        store.events.append([makeEvent('run.resumed', {})], { expectedSeq: 0 }),
      ).toThrowError(/期望 seq 0/);
      expect(store.events.count()).toBe(1);
    });
  });

  it('投影失败时事件也不落库', () => {
    withStore((store) => {
      const good = makeEvent(
        'task.created',
        {
          assignee: 'pm' as never,
          caller: null,
          parentTaskId: null,
          title: 'ok',
          brief: 'b',
          inputs: [],
        },
        { taskId: 'task_01' },
      );
      // 缺 taskId，投影会抛 E_PROJECTION
      const bad = makeEvent('task.created', {
        assignee: 'pm' as never,
        caller: null,
        parentTaskId: null,
        title: 'bad',
        brief: 'b',
        inputs: [],
      });

      expect(() => store.events.append([good, bad])).toThrowError(/缺少 taskId/);
      expect(store.events.count()).toBe(0);
      expect(store.listTasks()).toEqual([]);
    });
  });

  it('失败后连接仍可继续使用', () => {
    withStore((store) => {
      expect(() =>
        store.events.append([makeEvent('task.created', {} as never)]),
      ).toThrow();
      seedTask(store);
      expect(store.events.count()).toBe(1);
      expect(store.getTask('task_01')?.title).toBe('测试任务');
    });
  });
});

describe('EventStore.read', () => {
  it('按 taskId 过滤', () => {
    withStore((store) => {
      seedTask(store, 'task_01');
      seedTask(store, 'task_02');
      store.events.append([makeEvent('run.paused', { reason: 'x' }, { taskId: 'task_02' })]);

      const events = store.events.read({ taskId: 'task_02' });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.taskId === 'task_02')).toBe(true);
    });
  });

  it('afterSeq 与 limit 生效', () => {
    withStore((store) => {
      store.events.append([
        makeEvent('run.paused', { reason: 'a' }),
        makeEvent('run.paused', { reason: 'b' }),
        makeEvent('run.paused', { reason: 'c' }),
      ]);
      const afterFirst = store.events.read({ afterSeq: 1 });
      expect(afterFirst.map((e) => e.seq)).toEqual([2, 3]);

      const limited = store.events.read({ limit: 2 });
      expect(limited.map((e) => e.seq)).toEqual([1, 2]);
    });
  });

  it('按 runId 和 nodeRunId 过滤', () => {
    withStore((store) => {
      seedTask(store);
      store.events.append([
        makeEvent(
          'workflow.run.started',
          { specId: 'spec', params: {} },
          { taskId: 'task_01', runId: 'run_01' },
        ),
        makeEvent(
          'node.ready',
          { nodeId: 'plan' as never },
          { taskId: 'task_01', runId: 'run_01', nodeRunId: 'nrun_01' },
        ),
      ]);

      expect(store.events.read({ runId: 'run_01' }).map((e) => e.type)).toEqual([
        'workflow.run.started',
        'node.ready',
      ]);
      expect(store.events.read({ nodeRunId: 'nrun_01' })).toHaveLength(1);
    });
  });

  it('因果链字段往返', () => {
    withStore((store) => {
      store.events.append([
        makeEvent('run.paused', { reason: 'a' }, { id: 'evt_root' }),
        makeEvent('run.resumed', {}, { causationId: 'evt_root' }),
      ]);
      expect(store.events.read()[1]?.causationId).toBe('evt_root');
    });
  });

  it('payload 往返不丢字段', () => {
    withStore((store) => {
      seedTask(store);
      store.events.append([
        makeEvent(
          'gate.requested',
          {
            gateId: 'gate_01' as never,
            kind: 'human',
            ask: 'approve',
            attempt: 2,
            payload: { title: '审批', summary: '看看', diff: '+ a' },
          },
          { taskId: 'task_01' },
        ),
      ]);
      const [event] = store.events.read({ taskId: 'task_01' }).filter((e) => e.type === 'gate.requested');
      expect(event).toMatchObject({
        type: 'gate.requested',
        payload: {
          gateId: 'gate_01',
          attempt: 2,
          payload: { title: '审批', summary: '看看', diff: '+ a' },
        },
      });
    });
  });

  it('未知事件类型也能读出来，但投影忽略', () => {
    withStore((store) => {
      const event = makeEvent('tool.called', {
        tool: 'read_file',
        argsHash: 'abc',
      });
      store.events.append([event]);
      expect(store.events.read()).toHaveLength(1);
      expect(store.listTasks()).toEqual([]);
    });
  });

  it('limit 会被夹在合理范围内', () => {
    withStore((store) => {
      store.events.append([makeEvent('run.paused', { reason: 'a' })]);
      expect(store.events.read({ limit: 0 })).toHaveLength(1);
      expect(store.events.read({ limit: 999_999 })).toHaveLength(1);
    });
  });
});

