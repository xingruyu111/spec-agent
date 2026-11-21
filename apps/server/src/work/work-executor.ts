/**
 * Assignment 执行器。
 *
 * 把 Work Item 变成一次 AgentRuntime run；DSH/Claude 都通过同一个端口接入。
 * 执行完成或失败后，统一写 Report 回群聊，不让调用方等待长任务。
 */

import type {
  AgentRuntime,
  AgentRuntimeOutput,
  ProviderConfig,
} from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import type { WorkAssignmentRow } from './work-store.js';
import type { WorkService } from './work-service.js';
import type { ContextAssembler } from '../infra/context-assembler.js';
import type { WorkMemoryWriter } from './work-memory.js';
import { AssignmentScheduler } from './assignment-scheduler.js';

export type WorkExecutorOptions = {
  work: WorkService;
  runtime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  cwd: string;
  resolveAgent?: (agentId: string) => AgentConfig | undefined;
  assembler?: ContextAssembler;
  memoryWriter?: WorkMemoryWriter;
  /** 前置完成后自动运行满足依赖的后置 Assignment */
  autoSchedule?: boolean;
  /** 单 Agent 同时运行的 Assignment 上限 */
  maxConcurrentPerAgent?: number;
  timeoutMs?: number;
};

export class WorkExecutor {
  private readonly scheduler: AssignmentScheduler;
  private readonly active = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeByAgent = new Map<string, number>();

  constructor(private readonly options: WorkExecutorOptions) {
    this.scheduler = new AssignmentScheduler({
      work: options.work,
      autoSchedule: options.autoSchedule,
      execute: (id) => this.execute(id),
      hasCapacity: (agentId) => this.hasCapacity(agentId),
    });
  }

  isRunning(assignmentId: string): boolean {
    return this.active.has(assignmentId);
  }

  /**
   * 立即返回 running，实际执行在后台完成；结果通过 Report 落回群聊。
   */
  execute(assignmentId: string): WorkAssignmentRow {
    const assignment = this.options.work.getAssignment(assignmentId);
    if (!assignment) throw new Error(`assignment 不存在：${assignmentId}`);
    if (assignment.state === 'done' || assignment.state === 'cancelled') {
      throw new Error(`assignment 已结束：${assignment.state}`);
    }
    if (this.active.has(assignmentId)) return assignment;
    if (assignment.attempts >= assignment.maxAttempts) {
      throw new Error(
        `死信：已超过最大重试次数（${assignment.attempts}/${assignment.maxAttempts}）`,
      );
    }
    if (!this.hasCapacity(assignment.agentId)) {
      throw new Error(
        `Agent ${assignment.agentId} 并发已满（上限 ${this.maxPerAgent()}），请等待当前任务完成`,
      );
    }
    const attempted = this.options.work.incrementAttempts(assignmentId);
    const running = this.options.work.startAssignment(assignmentId);
    const controller = new AbortController();
    this.controllers.set(assignmentId, controller);
    this.active.add(assignmentId);
    this.activeByAgent.set(
      assignment.agentId,
      (this.activeByAgent.get(assignment.agentId) ?? 0) + 1,
    );
    void this.run(assignmentId, controller)
      .catch((error) => {
        console.error(`[work-executor] ${assignmentId}:`, error);
      })
      .finally(() => {
        this.active.delete(assignmentId);
        this.controllers.delete(assignmentId);
      });
    return { ...running, attempts: attempted.attempts };
  }

  cancel(assignmentId: string): WorkAssignmentRow {
    this.controllers.get(assignmentId)?.abort();
    const current = this.options.work.getAssignment(assignmentId);
    if (!current) throw new Error(`assignment 不存在：${assignmentId}`);
    if (current.state === 'cancelled') return current;
    return this.options.work.cancelAssignment(assignmentId);
  }

  retry(assignmentId: string): WorkAssignmentRow {
    return this.options.work.retryAssignment(assignmentId);
  }

  /** 启动 Work Item 中所有依赖已满足的 queued Assignment；返回启动的 id。 */
  startReady(workItemId: string): string[] {
    return this.scheduler.scheduleReady(workItemId);
  }

  private maxPerAgent(): number {
    const configured =
      this.options.maxConcurrentPerAgent ??
      Number(process.env.SPEC_AGENT_MAX_AGENT_CONCURRENCY ?? 2);
    return Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : 2;
  }

  private hasCapacity(agentId: string): boolean {
    return (this.activeByAgent.get(agentId) ?? 0) < this.maxPerAgent();
  }

  private async run(
    assignmentId: string,
    controller: AbortController,
  ): Promise<void> {
    const assignment = this.options.work.getAssignment(assignmentId);
    if (!assignment) return;
    const item = this.options.work.getWorkItem(assignment.workItemId);
    if (!item) return;
    const agent = this.options.resolveAgent?.(assignment.agentId);
    const origin = item.originEventId
      ? this.options.work.getEvent(item.originEventId)
      : undefined;
    const privateThreadId =
      typeof origin?.payload.privateThreadId === 'string'
        ? origin.payload.privateThreadId
        : null;
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 10 * 60_000,
    );
    let shouldSchedule = false;
    try {
      const context = (
      await this.options.assembler?.assembleAsync(assignmentId)
    )?.text;
      const output = await this.options.runtime.run({
        systemPrompt: [
          `你是 ${agent?.name ?? assignment.agentId}，正在为项目群聊完成一个 Work Item。`,
          agent?.role ? `你的职责：${agent.role}` : '',
          '直接在允许的项目工作区内执行；完成后用简洁的中文总结结果。',
          '不要声称创建了任务、Agent 或计划；这些由应用层负责。',
        ]
          .filter(Boolean)
          .join('\n'),
        task: [
          `Work Item：${item.title}`,
          item.intent ? `原始需求：${item.intent}` : '',
          context ? `上下文：\n${context}` : '',
          '请完成这个工作项。需要时先读取项目文件，再修改并验证。',
        ]
          .filter(Boolean)
          .join('\n\n'),
        cwd: this.options.cwd,
        allowedTools: agent?.tools.allow ?? ['Read', 'Grep', 'Glob'],
        skills: [],
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: 'workspace-write',
        budget: { maxTurns: 12, maxUsd: 0.5 },
        signal: controller.signal,
        onToolEvent: (event) => {
          this.options.work.recordProgress(assignment.id, event);
        },
      });
      this.report(assignment, output, item, privateThreadId);
      shouldSchedule = output.stopReason === 'finished';
    } catch (error) {
      const latest = this.options.work.getAssignment(assignmentId);
      if (latest?.state === 'cancelled') return;
      const summary = `执行失败：${
        error instanceof Error ? error.message : String(error)
      }`;
      this.options.work.reportAssignment({
        assignmentId,
        kind: 'blocked',
        summary,
      });
      this.options.memoryWriter?.recordCompletion({
        projectId: item.projectId,
        groupId: item.groupId,
        privateThreadId,
        agentId: assignment.agentId,
        assignmentId: assignment.id,
        workItemId: item.id,
        title: item.title,
        kind: 'blocked',
        summary,
      });
    } finally {
      clearTimeout(timer);
      const remaining = (this.activeByAgent.get(assignment.agentId) ?? 1) - 1;
      if (remaining <= 0) this.activeByAgent.delete(assignment.agentId);
      else this.activeByAgent.set(assignment.agentId, remaining);
      if (shouldSchedule) this.scheduler.scheduleProjectReady(item.projectId);
    }
  }

  private report(
    assignment: WorkAssignmentRow,
    output: AgentRuntimeOutput,
    item: { id: string; projectId: string; groupId: string | null; title: string },
    privateThreadId: string | null,
  ): void {
    const text = output.text?.trim();
    const summary = text
      ? text.slice(0, 4000)
      : output.stopReason === 'finished'
        ? '执行完成（没有文本输出）'
        : `执行结束：${output.stopReason}`;
    const kind = output.stopReason === 'finished' ? 'done' : 'blocked';
    this.options.work.reportAssignment({
      assignmentId: assignment.id,
      kind,
      summary,
      artifacts: output.outputs,
    });
    this.options.memoryWriter?.recordCompletion({
      projectId: item.projectId,
      groupId: item.groupId,
      privateThreadId,
      agentId: assignment.agentId,
      assignmentId: assignment.id,
      workItemId: item.id,
      title: item.title,
      kind,
      summary,
    });
  }

  /**
   * 前置完成后，自动启动所有依赖已满足的 queued Assignment。
   * 多个 ready 节点会并行启动；失败只记录，不阻塞其他节点。
   */
}
