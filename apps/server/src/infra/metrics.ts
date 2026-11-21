/**
 * 观测聚合：从事件投影出的表里算任务/节点/队列指标。
 *
 * 这里不做额外写入，指标始终可从 SQLite 重建；HTTP 计数器是进程内的。
 */

import type { Store } from '@spec-agent/core';

const TASK_STATUSES = [
  'pending',
  'running',
  'waiting_children',
  'waiting_gate',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled',
] as const;

const NODE_STATUSES = [
  'pending',
  'ready',
  'running',
  'verifying',
  'waiting_gate',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'interrupted',
] as const;

const RUN_STATUSES = ['pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'] as const;

export type ProjectMetrics = {
  id: string;
  name: string;
  migrationVersion: number;
  tasks: Record<string, number>;
  nodes: Record<string, number>;
  runs: Record<string, number>;
  taskCount: number;
  workflowCount: number;
  activeWorkflowCount: number;
  terminalTaskCount: number;
  failedTaskCount: number;
  failureRate: number;
  avgTaskDurationMs: number;
  totalCostUsd: number;
  planCostUsd: number;
  pendingGates: number;
  notifications: Record<string, number>;
  merges: Record<string, number>;
};

export type HttpMetrics = {
  requests: number;
  errors: number;
  durationMs: number;
};

export function createHttpMetrics(): HttpMetrics {
  return { requests: 0, errors: 0, durationMs: 0 };
}

export function recordHttp(
  metrics: HttpMetrics,
  status: number,
  durationMs: number,
): void {
  metrics.requests += 1;
  metrics.durationMs += Math.max(0, durationMs);
  if (status >= 500) metrics.errors += 1;
}

function counts<T extends string>(
  values: readonly T[],
  actual: Iterable<string>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = 0;
  for (const value of actual) {
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}

export function collectProjectMetrics(
  project: { id: string; name: string; store: Store },
): ProjectMetrics {
  const { store } = project;
  const tasks = store.listTasks(2000);
  const taskIds = new Set(tasks.map((task) => task.id));
  const runs = tasks.flatMap((task) => store.listRuns(task.id));
  const nodes = runs.flatMap((run) => store.listNodeRuns(run.id));
  const rootTasks = tasks.filter((task) => !task.parentId);
  const terminalRoot = rootTasks.filter((task) =>
    ['succeeded', 'failed', 'cancelled'].includes(task.status),
  );
  const failedRoot = terminalRoot.filter((task) => task.status === 'failed');
  const childrenByParent = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const children = childrenByParent.get(task.parentId) ?? [];
    children.push(task);
    childrenByParent.set(task.parentId, children);
  }
  const costCache = new Map<string, number>();
  const taskCost = (task: (typeof tasks)[number]): number => {
    const cached = costCache.get(task.id);
    if (cached !== undefined) return cached;
    const total =
      task.costUsd +
      (childrenByParent.get(task.id) ?? []).reduce(
        (sum, child) => sum + taskCost(child),
        0,
      );
    costCache.set(task.id, total);
    return total;
  };
  const durations = terminalRoot
    .map((task) =>
      task.finishedAt
        ? Date.parse(task.finishedAt) - Date.parse(task.createdAt)
        : Number.NaN,
    )
    .filter((duration) => Number.isFinite(duration) && duration >= 0);

  const notifications = counts(
    ['pending', 'sent', 'failed', 'skipped'],
    store
      .listOverallNotifications()
      .filter((notification) =>
        taskIds.has(store.getGate(notification.gateId)?.taskId ?? ''),
      )
      .map((notification) => notification.status),
  );
  const merges = counts(
    ['pending', 'merged', 'failed'],
    store
      .listMerges()
      .filter((merge) => taskIds.has(merge.taskId))
      .map((merge) => merge.status),
  );

  return {
    id: project.id,
    name: project.name,
    migrationVersion: store.migration.currentVersion,
    tasks: counts(TASK_STATUSES, tasks.map((task) => task.status)),
    nodes: counts(NODE_STATUSES, nodes.map((node) => node.status)),
    runs: counts(RUN_STATUSES, runs.map((run) => run.status)),
    taskCount: tasks.length,
    workflowCount: rootTasks.length,
    activeWorkflowCount: rootTasks.length - terminalRoot.length,
    terminalTaskCount: terminalRoot.length,
    failedTaskCount: failedRoot.length,
    failureRate:
      terminalRoot.length === 0 ? 0 : failedRoot.length / terminalRoot.length,
    avgTaskDurationMs:
      durations.length === 0
        ? 0
        : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    totalCostUsd: rootTasks.reduce((sum, task) => sum + taskCost(task), 0),
    planCostUsd: rootTasks.reduce((sum, task) => sum + task.planCostUsd, 0),
    pendingGates: store
      .listPendingGates()
      .filter((gate) => taskIds.has(gate.taskId ?? '')).length,
    notifications,
    merges,
  };
}

function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metric(
  lines: string[],
  name: string,
  help: string,
  type: 'gauge' | 'counter',
  samples: Array<{ labels?: Record<string, string>; value: number }>,
): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const sample of samples) {
    const labels = sample.labels
      ? `{${Object.entries(sample.labels)
          .map(([key, value]) => `${key}="${label(value)}"`)
          .join(',')}}`
      : '';
    lines.push(`${name}${labels} ${sample.value}`);
  }
}

export function renderPrometheus(
  projects: ProjectMetrics[],
  http: HttpMetrics,
  uptimeSeconds: number,
): string {
  const lines: string[] = [];

  metric(
    lines,
    'spec_agent_tasks',
    '任务数（按项目与状态）',
    'gauge',
    projects.flatMap((project) =>
      Object.entries(project.tasks).map(([status, value]) => ({
        labels: { project: project.id, status },
        value,
      })),
    ),
  );
  metric(
    lines,
    'spec_agent_nodes',
    '节点运行数（按项目与状态）',
    'gauge',
    projects.flatMap((project) =>
      Object.entries(project.nodes).map(([status, value]) => ({
        labels: { project: project.id, status },
        value,
      })),
    ),
  );
  metric(
    lines,
    'spec_agent_runs',
    'run 数（按项目与状态）',
    'gauge',
    projects.flatMap((project) =>
      Object.entries(project.runs).map(([status, value]) => ({
        labels: { project: project.id, status },
        value,
      })),
    ),
  );
  metric(
    lines,
    'spec_agent_task_failure_ratio',
    '根任务失败率（failed / terminal）',
    'gauge',
    projects.map((project) => ({
      labels: { project: project.id },
      value: project.failureRate,
    })),
  );
  metric(
    lines,
    'spec_agent_task_duration_seconds_avg',
    '根任务平均总耗时（创建到结束）',
    'gauge',
    projects.map((project) => ({
      labels: { project: project.id },
      value: project.avgTaskDurationMs / 1000,
    })),
  );
  metric(
    lines,
    'spec_agent_task_cost_usd',
    '根任务累计成本',
    'gauge',
    projects.map((project) => ({
      labels: { project: project.id },
      value: project.totalCostUsd,
    })),
  );
  metric(
    lines,
    'spec_agent_planner_cost_usd',
    '根任务累计规划成本',
    'gauge',
    projects.map((project) => ({
      labels: { project: project.id },
      value: project.planCostUsd,
    })),
  );
  metric(
    lines,
    'spec_agent_pending_gates',
    '待审批闸门数',
    'gauge',
    projects.map((project) => ({
      labels: { project: project.id },
      value: project.pendingGates,
    })),
  );
  metric(
    lines,
    'spec_agent_notifications',
    '通知 outbox 数（按状态）',
    'gauge',
    projects.flatMap((project) =>
      Object.entries(project.notifications).map(([status, value]) => ({
        labels: { project: project.id, status },
        value,
      })),
    ),
  );
  metric(
    lines,
    'spec_agent_merge_queue',
    '合并队列数（按状态）',
    'gauge',
    projects.flatMap((project) =>
      Object.entries(project.merges).map(([status, value]) => ({
        labels: { project: project.id, status },
        value,
      })),
    ),
  );
  metric(
    lines,
    'spec_agent_schema_version',
    'SQLite schema 版本',
    'gauge',
    projects.map((project) => ({
      labels: { project: project.id },
      value: project.migrationVersion,
    })),
  );
  metric(lines, 'spec_agent_uptime_seconds', '进程运行秒数', 'gauge', [
    { value: uptimeSeconds },
  ]);
  metric(lines, 'spec_agent_http_requests_total', 'HTTP 请求数', 'counter', [
    { value: http.requests },
  ]);
  metric(lines, 'spec_agent_http_errors_total', 'HTTP 5xx 数', 'counter', [
    { value: http.errors },
  ]);
  metric(
    lines,
    'spec_agent_http_request_duration_seconds_sum',
    'HTTP 请求累计耗时',
    'counter',
    [{ value: http.durationMs / 1000 }],
  );
  const memory = process.memoryUsage();
  metric(lines, 'spec_agent_process_resident_memory_bytes', 'Node RSS', 'gauge', [
    { value: memory.rss },
  ]);
  metric(lines, 'spec_agent_process_heap_used_bytes', 'Node heap used', 'gauge', [
    { value: memory.heapUsed },
  ]);

  return `${lines.join('\n')}\n`;
}
