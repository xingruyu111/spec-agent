/**
 * 项目级计划执行器。
 *
 * plan 负责 workstream / milestone / 跨任务依赖；每个 workstream 仍由任务
 * planner 生成自己的 workflow。任务成功后在 main 上按完成顺序集成，
 * 最后执行项目级 verify。
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  AgentRuntime,
  GitService,
  ProjectPlanItemRow,
  ProjectPlanRow,
  ProviderConfig,
  ShellRunner,
  Store,
  TaskRow,
} from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';
import { planProject, validateProjectPlanDraft } from '@spec-agent/runtime';
import type { ProjectPlanDraftItem } from '@spec-agent/runtime';
import { ProjectPlanExecutor } from './project-plan-executor.js';

export type ProjectPlanDetail = {
  plan: ProjectPlanRow;
  items: Array<ProjectPlanItemRow & { task: TaskRow | null }>;
};

export type ProjectPlanServiceOptions = {
  root: string;
  repoPath: string;
  store: Store;
  git: GitService;
  shell: ShellRunner;
  planner: {
    agentRuntime?: AgentRuntime;
    provider: ProviderConfig;
    model: string;
    limits?: { maxAgents?: number };
  };
  agents: () => AgentConfig[];
  createTask: (goal: string, assignee: string, repoPath?: string) => Promise<{ task: TaskRow }>;
  cancelTask?: (taskId: string, reason: string) => Promise<void>;
  maxWorkstreams?: number;
  pollMs?: number;
};

export class ProjectPlanService {
  private readonly pollMs: number;
  private readonly executor: ProjectPlanExecutor;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: ProjectPlanServiceOptions) {
    this.pollMs = options.pollMs ?? 2000;
    this.executor = new ProjectPlanExecutor(options);
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        console.error(
          'project plan tick failed:',
          error instanceof Error ? error.message : error,
        );
      });
    }, this.pollMs);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async create(input: {
    goal: string;
    verifyCommand?: string | null;
    projectId?: string | null;
    repoPath?: string | null;
  }): Promise<ProjectPlanDetail> {
    if (!this.options.planner.agentRuntime) {
      throw new AppError('E_PLANNER_UNAVAILABLE', '没有配置 AgentRuntime');
    }
    const agents = this.options.agents();
    const draft = await planProject({
      goal: input.goal,
      agentRuntime: this.options.planner.agentRuntime,
      provider: this.options.planner.provider,
      model: this.options.planner.model,
      agents,
      defaultAgent: agents.find((agent) => agent.parent === null)?.id,
      maxWorkstreams: this.options.maxWorkstreams,
      cwd: input.repoPath ? dirname(input.repoPath) : this.options.root,
    });

    return this.saveDraft(
      { title: draft.title, items: draft.items },
      input.goal.trim(),
      input.verifyCommand?.trim() || null,
      input.projectId ?? null,
      input.repoPath ?? null,
    );
  }

  /** 聊天草案 → 正式 draft；只保存，不启动、不调用 LLM。 */
  createFromDraft(input: {
    title: string;
    goal: string;
    verifyCommand: string | null;
    workstreams: ProjectPlanDraftItem[];
    projectId?: string | null;
    repoPath?: string | null;
  }): ProjectPlanDetail {
    const agents = this.options.agents();
    const defaultAgent = agents.find((agent) => agent.parent === null)?.id ?? '';
    const items = validateProjectPlanDraft(
      {
        workstreams: input.workstreams.map((item, index) => ({
          id: `ws-${index + 1}`,
          title: item.title,
          brief: item.goal,
          assignee: item.assignee,
          milestone: item.milestone,
          dependsOn: item.dependsOn,
          ...(item.repoPath ? { repoPath: item.repoPath } : {}),
        })),
      },
      agents,
      defaultAgent,
      this.options.maxWorkstreams,
    );
    return this.saveDraft(
      { title: input.title, items },
      input.goal.trim(),
      input.verifyCommand?.trim() || null,
      input.projectId ?? null,
      input.repoPath ?? null,
    );
  }

  private saveDraft(
    draft: { title: string; items: ProjectPlanDraftItem[] },
    goal: string,
    verifyCommand: string | null,
    projectId: string | null,
    defaultRepoPath: string | null,
  ): ProjectPlanDetail {
    for (const item of draft.items) {
      const repoPath = item.repoPath ?? defaultRepoPath;
      if (!repoPath) continue;
      if (!isAbsolute(repoPath) || !existsSync(join(repoPath, '.git'))) {
        throw new AppError(
          'E_REPOSITORY_INVALID',
          `workstream ${item.title} 的仓库必须是已有 Git 目录：${repoPath}`,
        );
      }
    }
    const planId = `plan-${randomUUID()}`;
    this.options.store.createProjectPlan({
      id: planId,
      projectId,
      title: draft.title,
      goal,
      verifyCommand,
    });
    const itemIds = draft.items.map(() => `planitem-${randomUUID()}`);
    const canonical = new Map(
      draft.items.map((_, index) => [`ws-${index + 1}`, itemIds[index]!]),
    );
    draft.items.forEach((item, index) => {
      this.options.store.createProjectPlanItem({
        id: itemIds[index]!,
        planId,
        title: item.title,
        goal: item.goal,
        assignee: item.assignee,
        milestone: item.milestone,
        repoPath: item.repoPath ?? defaultRepoPath,
        dependsOn: item.dependsOn.map((dep) => canonical.get(dep) ?? dep),
        position: index,
      });
    });
    return this.detail(planId);
  }

  list(limit = 30, projectId?: string | null): ProjectPlanRow[] {
    return this.options.store.listProjectPlans(limit, projectId);
  }

  get(planId: string, projectId?: string | null): ProjectPlanDetail {
    const detail = this.detail(planId);
    if (projectId && detail.plan.projectId !== projectId) {
      throw new AppError('E_PLAN_NOT_FOUND', '项目计划不存在');
    }
    return detail;
  }

  async start(planId: string): Promise<ProjectPlanDetail> {
    const plan = this.requirePlan(planId);
    if (plan.status !== 'draft') {
      throw new AppError(
        'E_PLAN_STATE',
        `只有 draft 计划可以启动，当前是 ${plan.status}`,
      );
    }
    this.options.store.setProjectPlanStatus(planId, 'running');
    await this.tick();
    return this.detail(planId);
  }

  async cancel(planId: string, reason = 'user cancelled plan'): Promise<ProjectPlanDetail> {
    const plan = this.requirePlan(planId);
    if (['completed', 'failed', 'cancelled'].includes(plan.status)) {
      return this.detail(planId);
    }
    const items = this.options.store.listProjectPlanItems(planId);
    for (const item of items) {
      if (item.taskId && this.options.cancelTask) {
        await this.options.cancelTask(item.taskId, reason);
      }
      if (!['done', 'failed'].includes(item.status)) {
        this.options.store.updateProjectPlanItem(item.id, {
          status: 'failed',
          error: reason,
        });
      }
    }
    this.options.store.setProjectPlanStatus(planId, 'cancelled');
    return this.detail(planId);
  }

  setVerifyCommand(planId: string, command: string | null): ProjectPlanDetail {
    this.requirePlan(planId);
    this.options.store.setProjectVerifyCommand(planId, command?.trim() || null);
    return this.detail(planId);
  }

  async tick(): Promise<void> {
    await this.executor.tick();
  }

  private detail(planId: string): ProjectPlanDetail {
    const plan = this.requirePlan(planId);
    return {
      plan,
      items: this.options.store.listProjectPlanItems(planId).map((item) => ({
        ...item,
        task: item.taskId ? (this.options.store.getTask(item.taskId) ?? null) : null,
      })),
    };
  }

  private requirePlan(planId: string): ProjectPlanRow {
    const plan = this.options.store.getProjectPlan(planId);
    if (!plan) throw new AppError('E_PLAN_NOT_FOUND', `项目计划不存在：${planId}`);
    return plan;
  }
}

