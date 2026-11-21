import type {
  GitService,
  ProjectPlanItemRow,
  ProjectPlanRow,
  ShellRunner,
  Store,
  TaskRow,
} from '@spec-agent/core';
import type { ProjectPlanServiceOptions } from './project-plans.js';

export class ProjectPlanExecutor {
  private ticking = false;

  constructor(private readonly options: ProjectPlanServiceOptions) {}

  /** 同步任务状态、启动 ready workstream、增量集成、最终 verify。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const plan of this.options.store.listProjectPlans(100)) {
        if (!['running', 'waiting'].includes(plan.status)) continue;
        await this.tickPlan(plan);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickPlan(plan: ProjectPlanRow): Promise<void> {
    const items = this.options.store.listProjectPlanItems(plan.id);
    let failed = false;
    let changed = false;

    for (const item of items) {
      if (!item.taskId) {
        if (item.status === 'starting' || item.status === 'running') {
          this.options.store.updateProjectPlanItem(item.id, {
            status: 'pending',
            taskId: null,
            error: null,
          });
          changed = true;
        }
        continue;
      }
      const task = this.options.store.getTask(item.taskId);
      if (!task) {
        this.markItemFailed(item, '任务不存在');
        failed = true;
        changed = true;
        continue;
      }
      if (task.status === 'succeeded') {
        if (item.status !== 'done') {
          const merged = await this.mergeTask(plan, item, task);
          if (!merged) {
            failed = true;
          } else {
            this.options.store.updateProjectPlanItem(item.id, {
              status: 'done',
              error: null,
            });
            changed = true;
          }
        }
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        this.markItemFailed(item, task.result?.summary ?? task.status);
        failed = true;
        changed = true;
      } else if (task.status === 'waiting_gate' || task.status === 'waiting_input') {
        this.options.store.updateProjectPlanItem(item.id, { status: 'waiting' });
        changed = true;
      } else if (item.status !== 'running') {
        this.options.store.updateProjectPlanItem(item.id, { status: 'running' });
        changed = true;
      }
    }

    if (failed) {
      const current = this.options.store.getProjectPlan(plan.id);
      if (current?.integrationStatus !== 'failed') {
        this.options.store.setProjectIntegration(
          plan.id,
          'failed',
          'workstream failed',
        );
      }
      this.options.store.setProjectPlanStatus(plan.id, 'failed');
      return;
    }

    const freshItems = this.options.store.listProjectPlanItems(plan.id);
    for (const item of freshItems) {
      if (item.status !== 'pending') continue;
      const ready = item.dependsOn.every(
        (dep) => this.options.store.getProjectPlanItem(dep)?.status === 'done',
      );
      if (!ready) continue;
      this.options.store.updateProjectPlanItem(item.id, { status: 'starting' });
      try {
        const created = await this.options.createTask(
          `${plan.goal}\n\n当前 workstream：${item.goal}`,
          item.assignee,
          item.repoPath ?? undefined,
        );
        this.options.store.updateProjectPlanItem(item.id, {
          taskId: created.task.id,
          status: taskToItemStatus(created.task),
          error: null,
        });
      } catch (error) {
        this.markItemFailed(
          item,
          error instanceof Error ? error.message : String(error),
        );
        this.options.store.setProjectIntegration(plan.id, 'failed', 'workstream failed');
        this.options.store.setProjectPlanStatus(plan.id, 'failed');
        return;
      }
      changed = true;
    }

    const latest = this.options.store.listProjectPlanItems(plan.id);
    if (latest.some((item) => item.status === 'failed')) {
      this.options.store.setProjectPlanStatus(plan.id, 'failed');
      return;
    }
    if (latest.every((item) => item.status === 'done')) {
      if (plan.integrationStatus !== 'completed') {
        this.options.store.setProjectIntegration(plan.id, 'merging');
        const verify = await this.verify(plan);
        if (!verify.ok) {
          this.options.store.setProjectIntegration(plan.id, 'failed', verify.error);
          this.options.store.setProjectPlanStatus(plan.id, 'failed');
          return;
        }
        this.options.store.setProjectIntegration(plan.id, 'completed');
      }
      this.options.store.setProjectPlanStatus(plan.id, 'completed');
      return;
    }

    const status = latest.some((item) =>
      ['waiting', 'running', 'starting'].includes(item.status),
    )
      ? 'waiting'
      : 'running';
    if (changed || plan.status !== status) {
      this.options.store.setProjectPlanStatus(plan.id, status);
    }
  }

  private async mergeTask(
    plan: ProjectPlanRow,
    item: ProjectPlanItemRow,
    task: TaskRow,
  ): Promise<boolean> {
    const branch = task.branch ?? `agent/${task.assignee}/${task.id}`;
    this.options.store.setProjectIntegration(plan.id, 'merging');
    try {
      await this.options.git.merge({
        worktree: task.repoPath ?? item.repoPath ?? this.options.repoPath,
        branch,
        message: `集成 ${plan.title} / ${item.title}`,
        trailers: {
          'Spec-Agent-Plan': plan.id,
          'Spec-Agent-Workstream': item.id,
          'Spec-Agent-Task': task.id,
        },
        author: { name: 'hive', email: 'hive@localhost' },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.store.setProjectIntegration(plan.id, 'failed', message);
      this.markItemFailed(item, `集成失败：${message}`);
      return false;
    }
  }

  private async verify(plan: ProjectPlanRow): Promise<{ ok: boolean; error?: string }> {
    if (!plan.verifyCommand) return { ok: true };
    const repos = new Set<string>();
    for (const item of this.options.store.listProjectPlanItems(plan.id)) {
      const task = item.taskId ? this.options.store.getTask(item.taskId) : undefined;
      repos.add(task?.repoPath ?? item.repoPath ?? this.options.repoPath);
    }
    for (const repo of repos.size > 0 ? repos : new Set([this.options.repoPath])) {
      const result = await this.options.shell.run({
        command: plan.verifyCommand,
        cwd: repo,
        timeoutMs: 60 * 60 * 1000,
      });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          error: `${repo}: ${result.stderr.trim() || result.stdout.trim() || `verify exit ${result.exitCode}`}`,
        };
      }
    }
    return { ok: true };
  }

  private markItemFailed(item: ProjectPlanItemRow, error: string): void {
    this.options.store.updateProjectPlanItem(item.id, {
      status: 'failed',
      error: error.slice(0, 2000),
    });
  }
}

function taskToItemStatus(task: TaskRow): ProjectPlanItemRow['status'] {
  switch (task.status) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'waiting_gate':
    case 'waiting_input':
      return 'waiting';
    case 'pending':
      return 'ready';
    default:
      return 'running';
  }
}
