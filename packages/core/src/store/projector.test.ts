import { describe, expect, it } from 'vitest';
import { makeEvent, seedRun, seedTask, withStore } from './__fixtures__/index.js';

describe('任务投影', () => {
  it('走完 pending → running → waiting_* → succeeded', () => {
    withStore((store) => {
      store.events.append([
        makeEvent(
          'task.created',
          {
            assignee: 'pm' as never,
            caller: null,
            parentTaskId: null,
            title: '需求',
            brief: '做点什么',
            inputs: [],
            branch: 'agent/pm/t1',
          },
          { taskId: 'task_01' },
        ),
      ]);
      expect(store.getTask('task_01')).toMatchObject({
        status: 'pending',
        title: '需求',
        branch: 'agent/pm/t1',
      });

      const transitions = [
        makeEvent('task.claimed', { leaseUntil: '2026-10-26T01:00:00.000Z' }, { taskId: 'task_01' }),
        makeEvent('task.started', {}, { taskId: 'task_01' }),
        makeEvent('task.waiting_children', { pending: [] }, { taskId: 'task_01' }),
        makeEvent('task.waiting_gate', { gateId: 'gate_01' as never }, { taskId: 'task_01' }),
        makeEvent('task.waiting_input', { gateId: 'gate_02' as never }, { taskId: 'task_01' }),
      ];
      for (const event of transitions) {
        store.events.append([event]);
        expect(store.getTask('task_01')?.status).not.toBe('succeeded');
      }

      store.events.append([
        makeEvent(
          'task.finished',
          {
            result: {
              status: 'ok',
              summary: '做完了',
              artifacts: [],
              usage: { usd: 1.25 },
            },
          },
          { taskId: 'task_01', ts: '2026-10-26T02:00:00.000Z' },
        ),
      ]);

      expect(store.getTask('task_01')).toMatchObject({
        status: 'succeeded',
        costUsd: 1.25,
        finishedAt: '2026-10-26T02:00:00.000Z',
      });
      expect(store.getTask('task_01')?.result?.summary).toBe('做完了');
    });
  });

  it('失败与取消', () => {
    withStore((store) => {
      seedTask(store, 'task_01');
      seedTask(store, 'task_02');

      store.events.append([
        makeEvent(
          'task.failed',
          {
            error: { code: 'E_X', message: '坏了' },
            partial: { status: 'failed', summary: '做了一半', artifacts: [] },
          },
          { taskId: 'task_01' },
        ),
      ]);
      store.events.append([
        makeEvent('task.cancelled', { reason: '不做了', cascade: [] }, { taskId: 'task_02' }),
      ]);

      expect(store.getTask('task_01')).toMatchObject({ status: 'failed' });
      expect(store.getTask('task_01')?.result?.summary).toBe('做了一半');
      expect(store.getTask('task_02')).toMatchObject({ status: 'cancelled' });
    });
  });
});

describe('run 投影', () => {
  it('running → waiting → succeeded', () => {
    withStore((store) => {
      seedTask(store);
      store.events.append([
        makeEvent(
          'workflow.run.started',
          { specId: 'feature-dev@v3', params: { scope: 'auth' } },
          { taskId: 'task_01', runId: 'run_01' },
        ),
      ]);
      expect(store.getRun('run_01')).toMatchObject({
        status: 'running',
        specId: 'feature-dev@v3',
        params: { scope: 'auth' },
      });

      store.events.append([
        makeEvent('workflow.run.waiting', { reason: 'gate' }, { taskId: 'task_01', runId: 'run_01' }),
      ]);
      expect(store.getRun('run_01')?.status).toBe('waiting');

      store.events.append([
        makeEvent(
          'workflow.run.finished',
          { status: 'succeeded', costUsd: 2.5 },
          { taskId: 'task_01', runId: 'run_01', ts: '2026-10-26T03:00:00.000Z' },
        ),
      ]);
      expect(store.getRun('run_01')).toMatchObject({
        status: 'succeeded',
        costUsd: 2.5,
        finishedAt: '2026-10-26T03:00:00.000Z',
      });
    });
  });

  it('失败', () => {
    withStore((store) => {
      seedTask(store);
      store.events.append([
        makeEvent(
          'workflow.run.started',
          { specId: 's', params: {} },
          { taskId: 'task_01', runId: 'run_02' },
        ),
        makeEvent(
          'workflow.run.failed',
          { error: { code: 'E_X', message: '炸了' } },
          { taskId: 'task_01', runId: 'run_02' },
        ),
      ]);
      expect(store.getRun('run_02')?.status).toBe('failed');
    });
  });
});

describe('node 投影', () => {
  it('ready → running → verifying → succeeded，再重试与失败', () => {
    withStore((store) => {
      seedRun(store);
      const node = { nodeId: 'plan' as never };
      const opts = { taskId: 'task_01', runId: 'run_01', nodeRunId: 'nrun_01' };

      store.events.append([makeEvent('node.ready', node, opts)]);
      expect(store.listNodeRuns('run_01')[0]).toMatchObject({ status: 'ready', attempt: 1 });

      store.events.append([makeEvent('node.started', { ...node, attempt: 1 }, opts)]);
      expect(store.listNodeRuns('run_01')[0]?.status).toBe('running');

      store.events.append([
        makeEvent('node.verifying', { ...node, attempt: 1, outputs: [] }, opts),
      ]);
      expect(store.listNodeRuns('run_01')[0]?.status).toBe('verifying');

      store.events.append([
        makeEvent('node.finished', { ...node, outputs: [], usage: { usd: 0.5 } }, opts),
      ]);
      expect(store.listNodeRuns('run_01')[0]).toMatchObject({
        status: 'succeeded',
        costUsd: 0.5,
      });

      store.events.append([makeEvent('node.retried', { ...node, from: 1, to: 2, reason: 'auto' }, opts)]);
      expect(store.listNodeRuns('run_01')[0]).toMatchObject({ status: 'ready', attempt: 2 });

      store.events.append([makeEvent('node.started', { ...node, attempt: 2 }, opts)]);
      store.events.append([
        makeEvent(
          'node.failed',
          { ...node, attempt: 2, error: { code: 'E_X', message: '挂了' }, willRetry: false },
          opts,
        ),
      ]);
      expect(store.listNodeRuns('run_01')[0]).toMatchObject({ status: 'failed', attempt: 2 });
    });
  });

  it('中断、跳过与 checkpoint', () => {
    withStore((store) => {
      seedRun(store);
      const opts = { taskId: 'task_01', runId: 'run_01', nodeRunId: 'nrun_02' };
      store.events.append([makeEvent('node.ready', { nodeId: 'x' as never }, opts)]);
      store.events.append([makeEvent('node.started', { nodeId: 'x' as never, attempt: 1 }, opts)]);
      store.events.append([makeEvent('node.interrupted', { nodeId: 'x' as never, reason: 'lease_expired' }, opts)]);
      expect(store.listNodeRuns('run_01')[0]?.status).toBe('ready');

      store.events.append([makeEvent('node.checkpoint', { nodeId: 'x' as never, ref: 'refs/x' }, opts)]);
      expect(store.listNodeRuns('run_01')[0]?.status).toBe('ready');

      store.events.append([makeEvent('node.skipped', { nodeId: 'x' as never, reason: 'upstream' }, opts)]);
      expect(store.listNodeRuns('run_01')[0]?.status).toBe('skipped');
    });
  });
});

describe('缺失 id 的事件', () => {
  it('run 事件缺少 runId', () => {
    withStore((store) => {
      seedTask(store);
      expect(() =>
        store.events.append([
          makeEvent(
            'workflow.run.started',
            { specId: 'spec', params: {} },
            { taskId: 'task_01' },
          ),
        ]),
      ).toThrowError(/缺少 runId/);
      expect(store.events.count()).toBe(1);
    });
  });

  it('node 事件缺少 nodeRunId', () => {
    withStore((store) => {
      seedRun(store);
      expect(() =>
        store.events.append([
          makeEvent(
            'node.ready',
            { nodeId: 'plan' as never },
            { taskId: 'task_01', runId: 'run_01' },
          ),
        ]),
      ).toThrowError(/缺少 nodeRunId/);
    });
  });

  it('gate 事件缺少 gateId', () => {
    withStore((store) => {
      seedTask(store);
      expect(() =>
        store.events.append([
          makeEvent('gate.cancelled', {} as never, { taskId: 'task_01' }),
        ]),
      ).toThrowError(/缺少 gateId/);
    });
  });
});

describe('gate 投影', () => {
  it('pending → passed，并进入收件箱', () => {
    withStore((store) => {
      seedTask(store);
      store.events.append([
        makeEvent(
          'gate.requested',
          {
            gateId: 'gate_01' as never,
            kind: 'human',
            ask: 'approve',
            attempt: 1,
            payload: { title: '审批 implement', summary: '看看 diff' },
          },
          { taskId: 'task_01', nodeRunId: 'nrun_01' },
        ),
      ]);
      expect(store.getGate('gate_01')).toMatchObject({
        status: 'pending',
        kind: 'human',
        attempt: 1,
        nodeRunId: 'nrun_01',
      });
      expect(store.inboxCount()).toBe(1);
      expect(store.listPendingGates()).toHaveLength(1);

      store.events.append([
        makeEvent(
          'gate.passed',
          { gateId: 'gate_01' as never, decision: 'approve', by: 'me', comment: 'OK' },
          { taskId: 'task_01', ts: '2026-10-26T04:00:00.000Z' },
        ),
      ]);
      expect(store.getGate('gate_01')).toMatchObject({
        status: 'passed',
        decision: 'approve',
        decidedBy: 'me',
        decidedAt: '2026-10-26T04:00:00.000Z',
      });
      expect(store.inboxCount()).toBe(0);
    });
  });

  it('failed / cancelled / overridden / reminded', () => {
    withStore((store) => {
      seedTask(store);
      const request = (gateId: string) =>
        makeEvent(
          'gate.requested',
          {
            gateId: gateId as never,
            kind: 'human',
            ask: 'approve',
            attempt: 1,
            payload: { title: gateId, summary: 's' },
          },
          { taskId: 'task_01' },
        );

      store.events.append([request('gate_a'), request('gate_b'), request('gate_c'), request('gate_d')]);

      store.events.append([
        makeEvent('gate.failed', { gateId: 'gate_a' as never, decision: 'reject', comment: 'no' }, { taskId: 'task_01' }),
        makeEvent('gate.cancelled', { gateId: 'gate_b' as never, reason: 'task cancelled' }, { taskId: 'task_01' }),
        makeEvent('gate.overridden', { gateId: 'gate_c' as never, by: 'me', reason: 'flaky' }, { taskId: 'task_01' }),
        makeEvent('gate.reminded', { gateId: 'gate_d' as never, level: 1 }, { taskId: 'task_01' }),
        makeEvent('gate.passed', { gateId: 'gate_d' as never, decision: 'approve' }, { taskId: 'task_01' }),
      ]);

      expect(store.getGate('gate_a')?.status).toBe('failed');
      expect(store.getGate('gate_b')?.status).toBe('cancelled');
      expect(store.getGate('gate_c')).toMatchObject({
        status: 'passed',
        decision: 'approve',
        decidedBy: 'me',
      });
      expect(store.getGate('gate_d')?.status).toBe('passed');
      expect(store.getGate('gate_d')?.decidedBy).toBeNull();
      expect(store.inboxCount()).toBe(0);
    });
  });
});

