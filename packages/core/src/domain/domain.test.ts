import { describe, expect, it } from 'vitest';
import type {
  AgentId,
  CreateTaskCommand,
  GateId,
  NodeId,
  NodeRunId,
  RunId,
  TaskId,
  TaskStatus,
} from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';
import { decide } from './decide.js';
import type { DomainState } from './state.js';
import type { GateSnapshot, NodeSnapshot, RunSnapshot, TaskSnapshot } from './snapshots.js';

const T = (s: string) => s as TaskId;
const R = (s: string) => s as RunId;
const N = (s: string) => s as NodeRunId;
const ND = (s: string) => s as NodeId;
const G = (s: string) => s as GateId;
const AG = (s: string) => s as AgentId;

const TASK = T('task_01');
const RUN = R('run_01');
const NODE = N('nrun_01');
const NODE_ID = ND('plan');
const GATE = G('gate_01');
const AGENT = AG('pm');

class FakeState implements DomainState {
  tasks = new Map<string, TaskSnapshot>();
  runs = new Map<string, RunSnapshot>();
  nodes = new Map<string, NodeSnapshot>();
  gates = new Map<string, GateSnapshot>();

  task(id: TaskId) {
    return this.tasks.get(id);
  }
  run(id: RunId) {
    return this.runs.get(id);
  }
  nodeRun(id: NodeRunId) {
    return this.nodes.get(id);
  }
  gate(id: GateId) {
    return this.gates.get(id);
  }
  childTasks(id: TaskId) {
    return [...this.tasks.values()].filter((t) => t.parentTaskId === id).map((t) => t.id);
  }

  withTask(status: TaskStatus, id: TaskId = TASK, parent: TaskId | null = null) {
    this.tasks.set(id, { id, parentTaskId: parent, assignee: AGENT, status });
    return this;
  }
  withRun(status: RunSnapshot['status'] = 'running', id: RunId = RUN) {
    this.runs.set(id, { id, taskId: TASK, status });
    return this;
  }
  withNode(
    status: NodeSnapshot['status'],
    attempt = 1,
    id: NodeRunId = NODE,
    outputs: NodeSnapshot['outputs'] = [],
  ) {
    this.nodes.set(id, {
      id,
      runId: RUN,
      taskId: TASK,
      nodeId: NODE_ID,
      status,
      attempt,
      outputs,
    });
    return this;
  }
  withGate(status: GateSnapshot['status'], id: GateId = GATE, over: Partial<GateSnapshot> = {}) {
    this.gates.set(id, { id, status, taskId: TASK, nodeRunId: NODE, ...over });
    return this;
  }
}

const nodeCtx = {
  taskId: TASK,
  runId: RUN,
  nodeRunId: NODE,
  nodeId: NODE_ID,
};

function createTask(over: Partial<CreateTaskCommand> = {}): CreateTaskCommand {
  return {
    type: 'task.create',
    taskId: TASK,
    assignee: AGENT,
    caller: null,
    title: '测试任务',
    brief: '做点什么',
    ...over,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`应该抛出 ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe('task 状态机', () => {
  it('create 产出 task.created', () => {
    const state = new FakeState();
    const drafts = decide(createTask({ parentTaskId: T('task_00') }), state);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: 'task.created',
      taskId: TASK,
      payload: {
        assignee: AGENT,
        parentTaskId: 'task_00',
        title: '测试任务',
        inputs: [],
      },
    });
  });

  it('重复 create 报 E_TASK_EXISTS', () => {
    const state = new FakeState().withTask('pending');
    expectCode(() => decide(createTask(), state), 'E_TASK_EXISTS');
  });

  it('claim 只能从 pending 发起', () => {
    const state = new FakeState().withTask('pending');
    const drafts = decide({ type: 'task.claim', taskId: TASK, leaseUntil: '2026-01-01T00:00:00Z' }, state);
    expect(drafts[0]).toMatchObject({ type: 'task.claimed' });

    const running = new FakeState().withTask('running');
    expectCode(
      () => decide({ type: 'task.claim', taskId: TASK, leaseUntil: 'x' }, running),
      'E_TASK_BAD_STATE',
    );
  });

  it('wait 覆盖三种等待态', () => {
    const state = new FakeState().withTask('running');
    expect(
      decide({ type: 'task.wait', taskId: TASK, reason: 'children', pending: [T('c')] }, state)[0],
    ).toMatchObject({ type: 'task.waiting_children', payload: { pending: ['c'] } });
    expect(
      decide({ type: 'task.wait', taskId: TASK, reason: 'gate', refId: 'gate_01' }, state)[0],
    ).toMatchObject({ type: 'task.waiting_gate' });
    expect(
      decide({ type: 'task.wait', taskId: TASK, reason: 'input', refId: 'gate_02' }, state)[0],
    ).toMatchObject({ type: 'task.waiting_input' });
  });

  it('wait 缺 refId 或状态不对都会拒绝', () => {
    const running = new FakeState().withTask('running');
    expectCode(() => decide({ type: 'task.wait', taskId: TASK, reason: 'gate' }, running), 'E_TASK_BAD_STATE');

    const pending = new FakeState().withTask('pending');
    expectCode(
      () => decide({ type: 'task.wait', taskId: TASK, reason: 'children' }, pending),
      'E_TASK_BAD_STATE',
    );
  });

  it('resume 只能从等待态发起', () => {
    for (const status of ['waiting_children', 'waiting_gate', 'waiting_input'] as const) {
      const state = new FakeState().withTask(status);
      expect(decide({ type: 'task.resume', taskId: TASK }, state)[0]).toMatchObject({
        type: 'task.resumed',
        payload: { from: status },
      });
    }
    const running = new FakeState().withTask('running');
    expectCode(() => decide({ type: 'task.resume', taskId: TASK }, running), 'E_TASK_BAD_STATE');
  });

  it('finish / fail 只能从活动态发起', () => {
    const state = new FakeState().withTask('waiting_gate');
    const result = { status: 'ok' as const, summary: 'done', artifacts: [] };
    expect(decide({ type: 'task.finish', taskId: TASK, result }, state)[0]).toMatchObject({
      type: 'task.finished',
    });
    expect(
      decide({ type: 'task.fail', taskId: TASK, error: { code: 'E_X', message: 'x' } }, state)[0],
    ).toMatchObject({ type: 'task.failed' });

    const pending = new FakeState().withTask('pending');
    expectCode(() => decide({ type: 'task.finish', taskId: TASK, result }, pending), 'E_TASK_BAD_STATE');
  });

  it('fail 只能从活动态发起', () => {
    const pending = new FakeState().withTask('pending');
    expectCode(
      () => decide({ type: 'task.fail', taskId: TASK, error: { code: 'E_X', message: 'x' } }, pending),
      'E_TASK_BAD_STATE',
    );
  });

  it('cancel 级联到所有后代', () => {
    const state = new FakeState()
      .withTask('running', TASK)
      .withTask('running', T('child_1'), TASK)
      .withTask('running', T('child_2'), TASK)
      .withTask('running', T('grand_1'), T('child_1'));

    const drafts = decide({ type: 'task.cancel', taskId: TASK, reason: '不做了' }, state);
    expect(drafts[0]).toMatchObject({ type: 'task.cancelled', payload: { reason: '不做了' } });
    const cascade = (drafts[0] as { payload: { cascade: string[] } }).payload.cascade;
    expect(cascade.sort()).toEqual(['child_1', 'child_2', 'grand_1']);
  });

  it('reopen 只能从 failed 发起', () => {
    const failed = new FakeState().withTask('failed');
    expect(decide({ type: 'task.reopen', taskId: TASK, reason: 'retry' }, failed)[0]).toMatchObject({
      type: 'task.reopened',
      payload: { reason: 'retry' },
    });
    expectCode(
      () => decide({ type: 'task.reopen', taskId: TASK }, new FakeState().withTask('running')),
      'E_TASK_BAD_STATE',
    );
    expectCode(
      () => decide({ type: 'task.reopen', taskId: R('missing') as never }, new FakeState()),
      'E_TASK_NOT_FOUND',
    );
  });

  it('终态与不存在的任务被拒绝', () => {
    const done = new FakeState().withTask('succeeded');
    expectCode(() => decide({ type: 'task.cancel', taskId: TASK }, done), 'E_TASK_TERMINAL');
    expectCode(
      () =>
        decide(
          {
            type: 'task.finish',
            taskId: TASK,
            result: { status: 'ok', summary: '', artifacts: [] },
          },
          done,
        ),
      'E_TASK_TERMINAL',
    );

    const empty = new FakeState();
    expectCode(
      () => decide({ type: 'task.cancel', taskId: TASK }, empty),
      'E_TASK_NOT_FOUND',
    );
  });
});

describe('gate 状态机', () => {
  const request = {
    type: 'gate.request' as const,
    gateId: GATE,
    taskId: TASK,
    nodeRunId: NODE,
    kind: 'human' as const,
    ask: 'approve' as const,
    attempt: 1,
    payload: { title: '审批', summary: '看看' },
  };

  it('request 产出 gate.requested', () => {
    const drafts = decide(request, new FakeState());
    expect(drafts[0]).toMatchObject({
      type: 'gate.requested',
      taskId: TASK,
      nodeRunId: NODE,
      payload: { gateId: 'gate_01', kind: 'human', attempt: 1 },
    });
  });

  it('重复 request 报 E_GATE_EXISTS', () => {
    expectCode(() => decide(request, new FakeState().withGate('pending')), 'E_GATE_EXISTS');
  });

  it('四种决策映射到 passed / failed', () => {
    for (const [action, expected] of [
      ['approve', 'gate.passed'],
      ['edit', 'gate.passed'],
      ['respond', 'gate.passed'],
      ['reject', 'gate.failed'],
    ] as const) {
      const state = new FakeState().withGate('pending');
      const drafts = decide(
        {
          type: 'gate.decide',
          gateId: GATE,
          action,
          by: 'me',
          comment: action === 'reject' ? '不行' : undefined,
          content: action === 'respond' ? '用 A 方案' : undefined,
        },
        state,
      );
      expect(drafts[0]?.type).toBe(expected);
    }
  });

  it('决策校验：决策者、打回原因、状态', () => {
    const pending = new FakeState().withGate('pending');
    expectCode(
      () => decide({ type: 'gate.decide', gateId: GATE, action: 'approve', by: '' }, pending),
      'E_GATE_ACTOR_MISSING',
    );
    expectCode(
      () => decide({ type: 'gate.decide', gateId: GATE, action: 'reject', by: 'me' }, pending),
      'E_GATE_REJECT_REASON',
    );

    const passed = new FakeState().withGate('passed');
    expectCode(
      () => decide({ type: 'gate.decide', gateId: GATE, action: 'approve', by: 'me' }, passed),
      'E_GATE_NOT_PENDING',
    );
    expectCode(
      () => decide({ type: 'gate.decide', gateId: G('nope'), action: 'approve', by: 'me' }, pending),
      'E_GATE_NOT_FOUND',
    );
  });

  it('无关联任务的闸门也能决策，信封不带 taskId', () => {
    const state = new FakeState().withGate('pending', GATE, { taskId: null, nodeRunId: null });
    const passed = decide(
      { type: 'gate.decide', gateId: GATE, action: 'approve', by: 'me' },
      state,
    );
    expect(passed[0]).toMatchObject({ type: 'gate.passed' });
    expect((passed[0] as { taskId?: string }).taskId).toBeUndefined();

    const failed = decide(
      { type: 'gate.decide', gateId: GATE, action: 'reject', by: 'me', comment: 'no' },
      state,
    );
    expect(failed[0]).toMatchObject({ type: 'gate.failed' });
    expect((failed[0] as { nodeRunId?: string }).nodeRunId).toBeUndefined();
  });

  it('cancel 只能取消 pending', () => {
    const pending = new FakeState().withGate('pending');
    expect(decide({ type: 'gate.cancel', gateId: GATE, reason: '不做了' }, pending)[0]).toMatchObject({
      type: 'gate.cancelled',
    });
    const failed = new FakeState().withGate('failed');
    expectCode(
      () => decide({ type: 'gate.cancel', gateId: GATE, reason: 'x' }, failed),
      'E_GATE_NOT_PENDING',
    );
  });
});

describe('node 状态机', () => {
  it('ready 只能创建一次', () => {
    expect(decide({ type: 'node.ready', ...nodeCtx }, new FakeState())[0]).toMatchObject({
      type: 'node.ready',
    });
    expectCode(
      () => decide({ type: 'node.ready', ...nodeCtx }, new FakeState().withNode('ready')),
      'E_NODE_EXISTS',
    );
  });

  it('start 只能从 ready 发起', () => {
    expect(decide({ type: 'node.start', ...nodeCtx }, new FakeState().withNode('ready'))[0]).toMatchObject({
      type: 'node.started',
      payload: { attempt: 1 },
    });
    expectCode(
      () => decide({ type: 'node.start', ...nodeCtx }, new FakeState().withNode('running')),
      'E_NODE_BAD_STATE',
    );
    expectCode(() => decide({ type: 'node.start', ...nodeCtx }, new FakeState()), 'E_NODE_NOT_FOUND');
  });

  it('produced → verifying，complete → finished', () => {
    const running = new FakeState().withNode('running');
    expect(
      decide({ type: 'node.produced', ...nodeCtx, outputs: [] }, running)[0],
    ).toMatchObject({ type: 'node.verifying', payload: { outputs: [] } });

    const verifying = new FakeState().withNode('verifying', 2, NODE, []);
    expect(decide({ type: 'node.complete', ...nodeCtx }, verifying)[0]).toMatchObject({
      type: 'node.finished',
    });
    expectCode(() => decide({ type: 'node.complete', ...nodeCtx }, running), 'E_NODE_BAD_STATE');
  });

  it('retry 递增 attempt，fail 是终结失败', () => {
    const retryable = new FakeState().withNode('running', 2);
    expect(
      decide({ type: 'node.retry', ...nodeCtx, reason: 'auto' }, retryable)[0],
    ).toMatchObject({ type: 'node.retried', payload: { from: 2, to: 3 } });

    const fail = decide(
      { type: 'node.fail', ...nodeCtx, error: { code: 'E_X', message: 'x' } },
      retryable,
    );
    expect(fail[0]).toMatchObject({ type: 'node.failed', payload: { willRetry: false } });

    const done = new FakeState().withNode('succeeded');
    expectCode(
      () => decide({ type: 'node.retry', ...nodeCtx, reason: 'auto' }, done),
      'E_NODE_BAD_STATE',
    );
  });

  it('skip / interrupt / cancel', () => {
    const ready = new FakeState().withNode('ready');
    expect(decide({ type: 'node.skip', ...nodeCtx, reason: 'upstream' }, ready)[0]).toMatchObject({
      type: 'node.skipped',
    });

    const running = new FakeState().withNode('running');
    expect(
      decide({ type: 'node.interrupt', ...nodeCtx, reason: 'lease_expired' }, running)[0],
    ).toMatchObject({ type: 'node.interrupted' });
    expect(decide({ type: 'node.cancel', ...nodeCtx, reason: 'task cancelled' }, running)[0]).toMatchObject({
      type: 'node.cancelled',
    });
    expect(
      decide({ type: 'node.reset', ...nodeCtx, reason: 'manual retry' }, new FakeState().withNode('failed', 2))[0],
    ).toMatchObject({
      type: 'node.reset',
      payload: { attempt: 3, reason: 'manual retry' },
    });
    expectCode(
      () => decide({ type: 'node.reset', ...nodeCtx, reason: 'x' }, running),
      'E_NODE_BAD_STATE',
    );
    expectCode(
      () => decide({ type: 'node.reset', ...nodeCtx, reason: 'x' }, new FakeState()),
      'E_NODE_NOT_FOUND',
    );

    const done = new FakeState().withNode('failed');
    expectCode(
      () => decide({ type: 'node.cancel', ...nodeCtx, reason: 'x' }, done),
      'E_NODE_TERMINAL',
    );
  });

  it('produced / fail / skip 的状态守卫', () => {
    const ready = new FakeState().withNode('ready');
    expectCode(
      () => decide({ type: 'node.produced', ...nodeCtx, outputs: [] }, ready),
      'E_NODE_BAD_STATE',
    );
    expectCode(
      () =>
        decide(
          { type: 'node.fail', ...nodeCtx, error: { code: 'E_X', message: 'x' } },
          ready,
        ),
      'E_NODE_BAD_STATE',
    );

    const running = new FakeState().withNode('running');
    expectCode(
      () => decide({ type: 'node.skip', ...nodeCtx, reason: 'x' }, running),
      'E_NODE_BAD_STATE',
    );
  });
});

describe('run 状态机', () => {
  const start = {
    type: 'run.start' as const,
    runId: RUN,
    taskId: TASK,
    specId: 'feature-dev@v3',
    params: {},
  };

  it('start 只能创建一次', () => {
    expect(decide(start, new FakeState())[0]).toMatchObject({
      type: 'workflow.run.started',
      payload: { specId: 'feature-dev@v3' },
    });
    expectCode(() => decide(start, new FakeState().withRun('running')), 'E_RUN_EXISTS');
  });

  it('wait / finish / fail', () => {
    const running = new FakeState().withRun('running');
    expect(decide({ type: 'run.wait', runId: RUN, reason: 'gate' }, running)[0]).toMatchObject({
      type: 'workflow.run.waiting',
    });
    expect(
      decide({ type: 'run.finish', runId: RUN, status: 'succeeded', costUsd: 1 }, running)[0],
    ).toMatchObject({ type: 'workflow.run.finished' });
    expect(
      decide({ type: 'run.fail', runId: RUN, error: { code: 'E_X', message: 'x' } }, running)[0],
    ).toMatchObject({ type: 'workflow.run.failed' });

    const finished = new FakeState().withRun('succeeded');
    expectCode(
      () => decide({ type: 'run.finish', runId: RUN, status: 'succeeded', costUsd: 1 }, finished),
      'E_RUN_TERMINAL',
    );
    expectCode(() => decide({ type: 'run.cancel', runId: R('nope') }, running), 'E_RUN_NOT_FOUND');
  });

  it('cancel / pause / resume', () => {
    const running = new FakeState().withRun('running');
    expect(decide({ type: 'run.cancel', runId: RUN }, running)[0]).toMatchObject({
      type: 'run.cancelled',
    });
    expect(decide({ type: 'run.pause', runId: RUN, reason: 'budget' }, running)[0]).toMatchObject({
      type: 'run.paused',
    });
    expect(decide({ type: 'run.resume', runId: RUN }, running)[0]).toMatchObject({
      type: 'run.resumed',
    });

    expect(
      decide({ type: 'run.reopen', runId: RUN, reason: 'retry' }, new FakeState().withRun('failed'))[0],
    ).toMatchObject({ type: 'workflow.run.reopened' });
    expectCode(
      () => decide({ type: 'run.reopen', runId: RUN }, running),
      'E_RUN_BAD_STATE',
    );
    expectCode(
      () => decide({ type: 'run.reopen', runId: R('missing') }, new FakeState()),
      'E_RUN_NOT_FOUND',
    );
  });

  it('wait 只能从 running 发起', () => {
    const waiting = new FakeState().withRun('waiting');
    expectCode(
      () => decide({ type: 'run.wait', runId: RUN, reason: 'gate' }, waiting),
      'E_RUN_BAD_STATE',
    );
  });

  it('finish / fail 在未启动的 run 上被拒绝', () => {
    const pending = new FakeState().withRun('pending');
    expectCode(
      () => decide({ type: 'run.finish', runId: RUN, status: 'succeeded', costUsd: 0 }, pending),
      'E_RUN_BAD_STATE',
    );
    expectCode(
      () => decide({ type: 'run.fail', runId: RUN, error: { code: 'E_X', message: 'x' } }, pending),
      'E_RUN_BAD_STATE',
    );
  });
});
