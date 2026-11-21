import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventPayloadMap, EventType } from '@spec-agent/schema';
import type { Clock } from '@spec-agent/kernel';
import { Store } from '../store.js';
import type { NewEvent } from '../event-store.js';

let counter = 0;

export type EventOptions = {
  taskId?: string;
  runId?: string;
  nodeRunId?: string;
  id?: string;
  ts?: string;
  causationId?: string;
};

export function makeEvent<T extends EventType>(
  type: T,
  payload: EventPayloadMap[T],
  options: EventOptions = {},
): NewEvent {
  counter += 1;
  return {
    id: options.id ?? `evt_${String(counter).padStart(8, '0')}`,
    ts: options.ts ?? '2026-10-26T00:00:00.000Z',
    type,
    v: 1,
    actor: { type: 'runtime', id: 'test' },
    correlationId: options.taskId ?? 'corr',
    payload,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.nodeRunId ? { nodeRunId: options.nodeRunId } : {}),
    ...(options.causationId ? { causationId: options.causationId } : {}),
  } as NewEvent;
}

export function fixedClock(): Clock {
  return {
    now: () => Date.parse('2026-10-26T00:00:00.000Z'),
    iso: () => '2026-10-26T00:00:00.000Z',
    sleep: async () => {},
  };
}

/** 在临时目录里跑一个 Store，结束后清理。 */
export function withStore<T>(fn: (store: Store) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-store-'));
  const store = new Store({ path: join(dir, 'spec-agent.db'), clock: fixedClock() });
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function withStorePath<T>(fn: (path: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-store-'));
  try {
    return fn(join(dir, 'spec-agent.db'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function seedTask(store: Store, taskId = 'task_01'): void {
  store.events.append([
    makeEvent(
      'task.created',
      {
        assignee: 'pm' as never,
        caller: null,
        parentTaskId: null,
        title: '测试任务',
        brief: '做点什么',
        inputs: [],
      },
      { taskId },
    ),
  ]);
}

export function seedRun(store: Store, taskId = 'task_01', runId = 'run_01'): void {
  seedTask(store, taskId);
  store.events.append([
    makeEvent(
      'workflow.run.started',
      { specId: 'spec_x', params: {} },
      { taskId, runId },
    ),
  ]);
}
