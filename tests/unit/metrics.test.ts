import { describe, expect, it } from 'vitest';
import type { Store } from '@spec-agent/core';
import { collectProjectMetrics } from '../../apps/server/src/infra/metrics.js';

const task = (over: Record<string, unknown>) => ({
  id: 't',
  parentId: null,
  assignee: 'pm',
  caller: null,
  title: 'task',
  brief: '',
  status: 'succeeded',
  costUsd: 0,
  planCostUsd: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  ...over,
});

describe('collectProjectMetrics', () => {
  it('工作流数只算根任务，成本递归包含内部执行任务', () => {
    const store = {
      listTasks: () => [
        task({ id: 'root', costUsd: 0.1 }),
        task({ id: 'child-a', parentId: 'root', costUsd: 0.2 }),
        task({ id: 'child-b', parentId: 'root', costUsd: 0.3 }),
      ],
      listRuns: () => [],
      listNodeRuns: () => [],
      listOverallNotifications: () => [],
      listMerges: () => [],
      listPendingGates: () => [],
      getGate: () => undefined,
      migration: { currentVersion: 7 },
    } as unknown as Store;

    const metrics = collectProjectMetrics({ id: 'p', name: 'P', store });
    expect(metrics.taskCount).toBe(3);
    expect(metrics.workflowCount).toBe(1);
    expect(metrics.activeWorkflowCount).toBe(0);
    expect(metrics.totalCostUsd).toBeCloseTo(0.6);
    expect(metrics.failureRate).toBe(0);
  });
});
