/**
 * I1 集成：domain + store。
 *
 * 证明三件事：
 * 1. 命令经 decide 产出事件草稿，补信封后能落库并投影；
 * 2. 非法命令抛稳定错误码，且事件表一条都不增加；
 * 3. 投影与事件始终一致（状态、级联、闸门决策）。
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentId,
  ArtifactRef,
  Command,
  GateId,
  NodeId,
  NodeRunId,
  RunId,
  TaskId,
} from '@spec-agent/schema';
import type { NewEvent } from '@spec-agent/core';
import { Store, decide, type DomainState } from '@spec-agent/core';
import { AppError, createSystemClock } from '@spec-agent/kernel';

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

const TS = '2026-10-26T00:00:00.000Z';

/** 用 store 的投影实现 DomainState。生产环境里这层属于 runtime。 */
function domainState(store: Store): DomainState {
  return {
    task(id) {
      const row = store.getTask(id);
      return row
        ? {
            id: row.id as TaskId,
            parentTaskId: row.parentId as TaskId | null,
            assignee: row.assignee,
            status: row.status,
          }
        : undefined;
    },
    run(id) {
      const row = store.getRun(id);
      return row
        ? { id: row.id as RunId, taskId: row.taskId as TaskId, status: row.status }
        : undefined;
    },
    nodeRun(id) {
      const row = store.getNodeRun(id);
      if (!row) return undefined;
      const run = store.getRun(row.runId);
      return {
        id: row.id as NodeRunId,
        runId: row.runId as RunId,
        taskId: (run?.taskId ?? '') as TaskId,
        nodeId: row.nodeId as NodeId,
        status: row.status,
        attempt: row.attempt,
        outputs: (row.outputs ?? []) as ArtifactRef[],
      };
    },
    gate(id) {
      const row = store.getGate(id);
      return row
        ? {
            id: row.id as GateId,
            status: row.status,
            taskId: row.taskId as TaskId | null,
            nodeRunId: row.nodeRunId as NodeRunId | null,
          }
        : undefined;
    },
    childTasks(id) {
      return store.listChildTasks(id).map((row) => row.id as TaskId);
    },
  };
}

let eventCounter = 0;

function commit(store: Store, state: DomainState, command: Command): number {
  const drafts = decide(command, state);
  const events = drafts.map((draft) => ({
    id: `evt_${String(++eventCounter).padStart(8, '0')}`,
    ts: TS,
    v: 1,
    actor: { type: 'runtime', id: 'integration' },
    correlationId: draft.taskId ?? 'corr',
    ...draft,
  })) as NewEvent[];

  store.events.append(events);
  return drafts.length;
}

function memoryStore(): Store {
  return new Store({ path: ':memory:', clock: createSystemClock() });
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

const createTask: Command = {
  type: 'task.create',
  taskId: TASK,
  assignee: AGENT,
  caller: null,
  title: '做一个登录页',
  brief: '带校验',
};

describe('I1: domain + store', () => {
  it('完整命令链：建任务 → 跑节点 → 人审 → 完成', () => {
    const store = memoryStore();
    const state = domainState(store);
    try {
      commit(store, state, createTask);
      expect(store.getTask(TASK)?.status).toBe('pending');

      commit(store, state, { type: 'task.claim', taskId: TASK, leaseUntil: TS });
      expect(store.getTask(TASK)?.status).toBe('running');

      commit(store, state, {
        type: 'run.start',
        runId: RUN,
        taskId: TASK,
        specId: 'feature-dev@v3',
        params: { scope: 'auth' },
      });
      expect(store.getRun(RUN)?.status).toBe('running');

      commit(store, state, { type: 'node.ready', taskId: TASK, runId: RUN, nodeRunId: NODE, nodeId: NODE_ID });
      expect(store.getNodeRun(NODE)?.status).toBe('ready');

      commit(store, state, { type: 'node.start', taskId: TASK, runId: RUN, nodeRunId: NODE, nodeId: NODE_ID });
      expect(store.getNodeRun(NODE)?.status).toBe('running');

      commit(store, state, {
        type: 'node.produced',
        taskId: TASK,
        runId: RUN,
        nodeRunId: NODE,
        nodeId: NODE_ID,
        outputs: [{ name: 'plan', kind: 'file', path: 'artifacts/plan.md' }],
        usage: { usd: 0.5 },
      });
      expect(store.getNodeRun(NODE)?.status).toBe('verifying');
      expect(store.getNodeRun(NODE)?.costUsd).toBe(0.5);

      commit(store, state, {
        type: 'gate.request',
        gateId: GATE,
        taskId: TASK,
        nodeRunId: NODE,
        kind: 'human',
        ask: 'approve',
        attempt: 1,
        payload: { title: '审批计划', summary: '看看计划' },
      });
      expect(store.inboxCount()).toBe(1);

      commit(store, state, {
        type: 'gate.decide',
        gateId: GATE,
        action: 'approve',
        by: 'me',
        comment: 'OK',
      });
      expect(store.getGate(GATE)?.status).toBe('passed');
      expect(store.inboxCount()).toBe(0);

      commit(store, state, { type: 'node.complete', taskId: TASK, runId: RUN, nodeRunId: NODE, nodeId: NODE_ID });
      expect(store.getNodeRun(NODE)?.status).toBe('succeeded');

      commit(store, state, { type: 'run.finish', runId: RUN, status: 'succeeded', costUsd: 0.5 });
      expect(store.getRun(RUN)?.status).toBe('succeeded');

      commit(store, state, {
        type: 'task.finish',
        taskId: TASK,
        result: {
          status: 'ok',
          summary: '做完了',
          artifacts: [{ name: 'plan', kind: 'file', path: 'artifacts/plan.md' }],
          usage: { usd: 0.5 },
        },
      });
      expect(store.getTask(TASK)?.status).toBe('succeeded');
      expect(store.events.count()).toBe(11);
    } finally {
      store.close();
    }
  });

  it('终态任务拒绝新命令，且不写事件', () => {
    const store = memoryStore();
    const state = domainState(store);
    try {
      commit(store, state, createTask);
      commit(store, state, { type: 'task.claim', taskId: TASK, leaseUntil: TS });
      commit(store, state, {
        type: 'task.finish',
        taskId: TASK,
        result: { status: 'ok', summary: 'done', artifacts: [] },
      });
      const before = store.events.count();

      expectCode(
        () => commit(store, state, { type: 'task.cancel', taskId: TASK }),
        'E_TASK_TERMINAL',
      );
      expect(store.events.count()).toBe(before);
      expect(store.getTask(TASK)?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('闸门不能被决策两次', () => {
    const store = memoryStore();
    const state = domainState(store);
    try {
      commit(store, state, createTask);
      commit(store, state, {
        type: 'gate.request',
        gateId: GATE,
        taskId: TASK,
        kind: 'human',
        ask: 'approve',
        attempt: 1,
        payload: { title: 't', summary: 's' },
      });
      commit(store, state, { type: 'gate.decide', gateId: GATE, action: 'approve', by: 'me' });
      const before = store.events.count();

      expectCode(
        () => commit(store, state, { type: 'gate.decide', gateId: GATE, action: 'reject', by: 'me', comment: 'x' }),
        'E_GATE_NOT_PENDING',
      );
      expect(store.events.count()).toBe(before);
      expect(store.getGate(GATE)?.decision).toBe('approve');
    } finally {
      store.close();
    }
  });

  it('取消父任务时给出级联清单（由 engine 逐个执行）', () => {
    const store = memoryStore();
    const state = domainState(store);
    try {
      const parent = TASK;
      const child = T('task_02');
      const grand = T('task_03');

      commit(store, state, { ...createTask, taskId: parent });
      commit(store, state, { ...createTask, taskId: child, parentTaskId: parent });
      commit(store, state, { ...createTask, taskId: grand, parentTaskId: child });

      commit(store, state, { type: 'task.cancel', taskId: parent, reason: '需求取消' });

      expect(store.getTask(parent)?.status).toBe('cancelled');
      expect(store.getTask(child)?.status).toBe('pending');
      expect(store.getTask(grand)?.status).toBe('pending');

      const cancelled = store.events
        .read({ taskId: parent })
        .find((event) => event.type === 'task.cancelled');
      expect(cancelled).toBeDefined();
      if (cancelled?.type === 'task.cancelled') {
        expect([...cancelled.payload.cascade].sort()).toEqual(['task_02', 'task_03']);
      }
    } finally {
      store.close();
    }
  });
});
