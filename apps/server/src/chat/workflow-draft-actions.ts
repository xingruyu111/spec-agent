import { AppError } from '@spec-agent/kernel';
import type { ChatRepository } from './chat-store.js';
import type { ChatSessionDetail, PlannedTask } from './service-types.js';
import type { WorkflowDraftRow } from './store-types.js';

type WorkflowDraftOptions = {
  repo: ChatRepository;
  confirmTask?: (plan: PlannedTask) => Promise<{ taskId: string; title: string }>;
  autoMemory?: boolean;
  watchTask: (taskId: string, sessionId: string) => void;
  getSessionDetail: (sessionId: string) => ChatSessionDetail;
};

export class WorkflowDraftActions {
  constructor(private readonly options: WorkflowDraftOptions) {}

  async confirmWorkflowDraft(draftId: string): Promise<ChatSessionDetail> {
    const draft = this.options.repo.getWorkflowDraft(draftId);
    if (!draft) throw new AppError('E_WORKFLOW_DRAFT_NOT_FOUND', `工作流草案不存在：${draftId}`);
    if (draft.status !== 'pending') {
      throw new AppError('E_WORKFLOW_DRAFT_CLOSED', '工作流草案已经处理');
    }
    if (!this.options.confirmTask) {
      throw new AppError('E_WORKFLOW_DRAFT_UNAVAILABLE', '当前 host 不支持确认工作流草案');
    }
    try {
      const task = await this.options.confirmTask({
        goal: draft.goal,
        title: draft.title,
        assignee: draft.assignee,
        spec: draft.spec,
        planUsage: draft.planUsage,
        repoPath: draft.repoPath ?? undefined,
      });
      const updated = this.options.repo.updateWorkflowDraft(draftId, {
        status: 'applied',
        taskId: task.taskId,
        error: null,
      });
      this.options.repo.addMessage({
        sessionId: draft.sessionId,
        role: 'assistant',
        content: `已确认，任务已创建：${task.title}`,
        mode: 'task',
        taskId: task.taskId,
      });
      if (this.options.autoMemory !== false) this.options.watchTask(task.taskId, draft.sessionId);
      return this.options.getSessionDetail(updated.sessionId);
    } catch (error) {
      this.options.repo.updateWorkflowDraft(draftId, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  rejectWorkflowDraft(draftId: string): WorkflowDraftRow {
    const draft = this.options.repo.getWorkflowDraft(draftId);
    if (!draft) throw new AppError('E_WORKFLOW_DRAFT_NOT_FOUND', `工作流草案不存在：${draftId}`);
    if (draft.status !== 'pending') {
      throw new AppError('E_WORKFLOW_DRAFT_CLOSED', '工作流草案已经处理');
    }
    const updated = this.options.repo.updateWorkflowDraft(draftId, {
      status: 'rejected',
      error: null,
    });
    this.options.repo.addMessage({
      sessionId: draft.sessionId,
      role: 'assistant',
      content: '工作流草案已放弃，不会创建任务。',
      mode: 'task',
    });
    return updated;
  }

}

