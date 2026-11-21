/**
 * Work Item → Assignment DAG 自动规划。
 *
 * LLM 只负责给出分派方案；创建 Assignment、依赖映射和校验由应用层完成。
 * 输出非法或调用失败时回退为单 Assignment，避免 Work Item 无法执行。
 */

import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';
import type { WorkAssignmentRow, WorkItemRow } from './work-store.js';
import type { WorkService } from './work-service.js';

export type PlannedAssignment = {
  agentId: string;
  dependsOn: number[];
};

export type WorkPlanResult = {
  item: WorkItemRow;
  assignments: WorkAssignmentRow[];
  planned: PlannedAssignment[];
  fallback: boolean;
};

export type WorkPlanPreview = {
  item: WorkItemRow;
  planned: PlannedAssignment[];
  fallback: boolean;
};

export type WorkPlannerOptions = {
  work: WorkService;
  runtime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  cwd: string;
  listAgents: () => Array<{ id: string; name: string; role: string }>;
  timeoutMs?: number;
};

export class WorkPlanner {
  constructor(private readonly options: WorkPlannerOptions) {}

  async propose(workItemId: string): Promise<WorkPlanPreview> {
    const item = this.options.work.getWorkItem(workItemId);
    if (!item) throw new Error(`work item 不存在：${workItemId}`);
    const agents = this.options.listAgents();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 60_000,
    );
    let planned: PlannedAssignment[] = [];
    let fallback = false;
    try {
      const output = await this.options.runtime.run({
        systemPrompt: [
          '你是 Spec Agent 的项目助理，负责把一个 Work Item 拆成可执行的 Assignment DAG。',
          '只输出一个 JSON 对象，不要 Markdown，不要解释。',
          '格式：',
          '{"assignments":[{"agentId":"agent-id","dependsOn":[0]}]}',
          '规则：',
          '- 1 到 5 个 Assignment；',
          '- dependsOn 使用本次数组的下标，只能引用前面的 Assignment；',
          '- 只使用可用 Agent 的 id；',
          '- 第一个一般无依赖；',
          '- 不要声称已经执行。',
          agents.length > 0
            ? `可用 Agent：${agents
                .map((agent) => `${agent.id}(${agent.name}:${agent.role})`)
                .join('；')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        task: [
          `Work Item：${item.title}`,
          item.intent ? `需求：${item.intent}` : '',
          '请给出分派 DAG。',
        ]
          .filter(Boolean)
          .join('\n'),
        cwd: this.options.cwd,
        allowedTools: ['Read', 'Grep', 'Glob'],
        skills: [],
        provider: this.options.provider,
        model: this.options.model,
        permissionMode: 'read-only',
        budget: { maxTurns: 3, maxUsd: 0.08 },
        signal: controller.signal,
      });
      planned = parsePlan(
        output.text ?? '',
        new Set(agents.map((agent) => agent.id)),
      );
      if (planned.length === 0) {
        planned = [{ agentId: agents[0]?.id ?? 'assistant', dependsOn: [] }];
        fallback = true;
      }
    } catch {
      planned = [{ agentId: agents[0]?.id ?? 'assistant', dependsOn: [] }];
      fallback = true;
    } finally {
      clearTimeout(timer);
    }
    return { item, planned, fallback };
  }

  apply(workItemId: string, plannedInput: PlannedAssignment[]): WorkPlanResult {
    const item = this.options.work.getWorkItem(workItemId);
    if (!item) throw new Error(`work item 不存在：${workItemId}`);
    const agents = new Set(this.options.listAgents().map((agent) => agent.id));
    const planned = plannedInput
      .slice(0, 5)
      .map((assignment, index) => ({
        agentId: agents.has(assignment.agentId)
          ? assignment.agentId
          : this.options.listAgents()[0]?.id ?? 'assistant',
        dependsOn: assignment.dependsOn.filter(
          (dependency) =>
            Number.isInteger(dependency) &&
            dependency >= 0 &&
            dependency < index,
        ),
      }))
      .filter((assignment) => Boolean(assignment.agentId));
    if (planned.length === 0) {
      planned.push({
        agentId: this.options.listAgents()[0]?.id ?? 'assistant',
        dependsOn: [],
      });
    }

    const created: WorkAssignmentRow[] = [];
    const ids: string[] = [];
    for (const [index, assignment] of planned.entries()) {
      const dependsOn = assignment.dependsOn
        .filter((dependency) => dependency >= 0 && dependency < index)
        .map((dependency) => ids[dependency])
        .filter((id): id is string => Boolean(id));
      const result = this.options.work.assignWorkItem(
        workItemId,
        assignment.agentId,
        dependsOn,
      );
      created.push(result.assignment);
      ids.push(result.assignment.id);
    }
    return { item, assignments: created, planned, fallback: false };
  }

  async plan(workItemId: string): Promise<WorkPlanResult> {
    const preview = await this.propose(workItemId);
    return {
      ...this.apply(workItemId, preview.planned),
      fallback: preview.fallback,
    };
  }
}

function parsePlan(text: string, validAgents: Set<string>): PlannedAssignment[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      assignments?: unknown;
    };
    if (!Array.isArray(parsed.assignments)) return [];
    return parsed.assignments
      .filter(
        (value): value is { agentId: string; dependsOn?: unknown } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { agentId?: unknown }).agentId === 'string',
      )
      .slice(0, 5)
      .map((value) => ({
        agentId: validAgents.has(value.agentId)
          ? value.agentId
          : 'assistant',
        dependsOn: Array.isArray(value.dependsOn)
          ? value.dependsOn.filter(
              (dependency): dependency is number =>
                typeof dependency === 'number' && Number.isInteger(dependency),
            )
          : [],
      }));
  } catch {
    return [];
  }
}
