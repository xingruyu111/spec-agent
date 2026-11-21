import { AppError } from '@spec-agent/kernel';
import type { ProjectPlanDraftItem } from '@spec-agent/runtime';
import type { ChatRepository } from './chat-store.js';
import type { ProjectPlanDraftRow } from './store-types.js';

type PlanDraftOptions = {
  repo: ChatRepository;
  createProjectPlan?: (draft: {
    title: string;
    goal: string;
    verifyCommand: string | null;
    workstreams: ProjectPlanDraftItem[];
  }, context?: { projectId?: string; repoPath?: string }) => Promise<{ id: string }>;
};

export class ChatPlanDraftActions {
  constructor(private readonly options: PlanDraftOptions) {}

  getProjectPlanDraft(id: string): ProjectPlanDraftRow {
    const draft = this.options.repo.getProjectPlanDraft(id);
    if (!draft) {
      throw new AppError('E_PROJECT_PLAN_DRAFT_NOT_FOUND', `项目计划草案不存在：${id}`);
    }
    return draft;
  }

  async applyProjectPlanDraft(id: string): Promise<ProjectPlanDraftRow> {
    const draft = this.getProjectPlanDraft(id);
    if (draft.status !== 'pending') {
      throw new AppError('E_PROJECT_PLAN_DRAFT_CLOSED', '这个项目计划草案已经处理过了');
    }
    if (!this.options.createProjectPlan) {
      throw new AppError('E_PLANNER_UNAVAILABLE', '项目计划服务未启动');
    }
    try {
      const session = this.options.repo.getSession(draft.sessionId);
      const project = session?.projectId
        ? this.options.repo.getProject(session.projectId)
        : undefined;
      const created = await this.options.createProjectPlan({
        title: draft.title,
        goal: draft.goal,
        verifyCommand: draft.verifyCommand,
        workstreams: draft.workstreams,
      }, {
        ...(project ? { projectId: project.id } : {}),
        ...(project?.repoPath ? { repoPath: project.repoPath } : {}),
      });
      const updated = this.options.repo.updateProjectPlanDraft(id, {
        status: 'applied',
        planId: created.id,
        error: null,
      });
      this.options.repo.addMessage({
        sessionId: draft.sessionId,
        role: 'system',
        content: `已保存项目计划草案：${draft.title}。计划仍为 draft，尚未启动。`,
        mode: 'qa',
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.repo.updateProjectPlanDraft(id, { error: message });
      throw error instanceof AppError
        ? error
        : new AppError('E_PROJECT_PLAN_DRAFT_INVALID', message);
    }
  }

  rejectProjectPlanDraft(id: string): ProjectPlanDraftRow {
    const draft = this.getProjectPlanDraft(id);
    if (draft.status === 'pending') {
      const updated = this.options.repo.updateProjectPlanDraft(id, {
        status: 'rejected',
      });
      this.options.repo.addMessage({
        sessionId: draft.sessionId,
        role: 'system',
        content: `已拒绝项目计划草案：${draft.title}`,
        mode: 'qa',
      });
      return updated;
    }
    return draft;
  }

}
