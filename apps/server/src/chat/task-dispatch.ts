import type { AgentConfig } from '@spec-agent/schema';
import type { ChatRepository } from './chat-store.js';
import type { ChatTaskCreator, PlannedTask } from './service-types.js';
import { firstTitle } from './parsers.js';

type TaskDispatcherOptions = {
  repo: ChatRepository;
  agents: () => AgentConfig[];
  createTask: ChatTaskCreator;
  planTask?: (goal: string, assignee?: string, repoPath?: string) => Promise<PlannedTask>;
  confirmTask?: (plan: PlannedTask) => Promise<{ taskId: string; title: string }>;
  autoMemory?: boolean;
  watchTask: (taskId: string, sessionId: string) => void;
};

export class TaskDispatcher {
  constructor(private readonly options: TaskDispatcherOptions) {}

  sessionRepoPath(sessionId: string): string | undefined {
    const session = this.options.repo.getSession(sessionId);
    if (!session?.projectId) return undefined;
    return this.options.repo.getProject(session.projectId)?.repoPath ?? undefined;
  }

  async dispatch(sessionId: string, goal: string): Promise<void> {
    const defaultAgent = this.options.agents().find((agent) => agent.parent === null);
    if (!defaultAgent) {
      this.options.repo.addMessage({
        sessionId,
        role: 'assistant',
        content: '还没有可派发的 agent。先到组织画布创建 agent 和节点。',
        mode: 'task',
      });
      return;
    }
    try {
      const repoPath = this.sessionRepoPath(sessionId);
      if (this.options.planTask && this.options.confirmTask) {
        const plan = await this.options.planTask(
          goal,
          String(defaultAgent.id),
          repoPath,
        );
        const draft = this.options.repo.createWorkflowDraft({
          sessionId,
          goal: plan.goal,
          title: plan.title,
          assignee: plan.assignee,
          spec: plan.spec,
          planUsage: plan.planUsage,
          repoPath: plan.repoPath ?? null,
        });
        this.options.repo.addMessage({
          sessionId,
          role: 'assistant',
          content: [
            `工作流草案已生成：${plan.title}`,
            `共 ${plan.spec.nodes.length} 个节点，负责人 ${defaultAgent.name}。`,
            '确认后才会创建任务并开始执行。',
          ].join('\n'),
          mode: 'task',
          workflowDraftId: draft.id,
        });
        this.options.repo.updateSession(sessionId, {
          mode: 'task',
          ...(this.options.repo.getSession(sessionId)?.title === '新对话'
            ? { title: firstTitle(goal) }
            : {}),
        });
        return;
      }

      const task = await this.options.createTask(
        goal,
        defaultAgent.id,
        repoPath,
      );
      this.options.repo.addMessage({
        sessionId,
        role: 'assistant',
        content: `已派发给 ${defaultAgent.name}。计划生成和执行状态会显示在任务卡片里。`,
        mode: 'task',
        taskId: task.taskId,
      });
      this.options.repo.updateSession(sessionId, {
        mode: 'task',
        ...(this.options.repo.getSession(sessionId)?.title === '新对话'
          ? { title: firstTitle(goal) }
          : {}),
      });
      if (this.options.autoMemory !== false) this.options.watchTask(task.taskId, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.repo.addMessage({
        sessionId,
        role: 'assistant',
        content: `${
          this.options.planTask ? '生成工作流草案失败' : '派发任务失败'
        }：${message}`,
        mode: 'task',
        status: 'error',
      });
    }
  }

}

