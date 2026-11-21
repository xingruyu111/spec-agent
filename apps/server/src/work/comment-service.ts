import type { WorkStore } from './work-store.js';

export class CommentService {
  constructor(private readonly store: WorkStore) {}

  listWorkItemComments(workItemId: string) {
    if (!this.store.getWorkItem(workItemId)) {
      throw new Error(`work item 不存在：${workItemId}`);
    }
    return this.store.listWorkItemComments(workItemId);
  }

  addWorkItemComment(input: {
    workItemId: string;
    authorType: 'user' | 'agent' | 'system';
    authorId: string;
    content: string;
  }) {    const item = this.store.getWorkItem(input.workItemId);
    if (!item) throw new Error(`work item 不存在：${input.workItemId}`);
    const content = input.content.trim().slice(0, 4000);
    if (!content) throw new Error('评论不能为空');
    const comment = this.store.addWorkItemComment({
      ...input,
      content,
    });
    this.store.appendEvent({
      projectId: item.projectId,
      groupId: item.groupId,
      type: 'workitem.commented',
      actor: { type: input.authorType, id: input.authorId },
      payload: {
        workItemId: item.id,
        commentId: comment.id,
        content,
      },
      correlationId: `workitem:${item.id}`,
    });
    return comment;
  }

  editWorkItemComment(input: {
    workItemId: string;
    commentId: string;
    content: string;
  }) {
    const item = this.store.getWorkItem(input.workItemId);
    if (!item) throw new Error(`work item 不存在：${input.workItemId}`);
    const existing = this.store
      .listWorkItemComments(input.workItemId)
      .find((comment) => comment.id === input.commentId);
    if (!existing) throw new Error(`评论不存在：${input.commentId}`);
    const content = input.content.trim().slice(0, 4000);
    if (!content) throw new Error('评论不能为空');
    const comment = this.store.updateWorkItemComment(input.commentId, content);
    this.store.appendEvent({
      projectId: item.projectId,
      groupId: item.groupId,
      type: 'workitem.comment_updated',
      actor: { type: 'user', id: 'local-user' },
      payload: { workItemId: item.id, commentId: input.commentId, content },
      correlationId: `workitem:${item.id}`,
    });
    return comment;
  }

  deleteWorkItemComment(workItemId: string, commentId: string): boolean {
    const item = this.store.getWorkItem(workItemId);
    if (!item) throw new Error(`work item 不存在：${workItemId}`);
    const deleted = this.store.deleteWorkItemComment(commentId);
    if (deleted) {
      this.store.appendEvent({
        projectId: item.projectId,
        groupId: item.groupId,
        type: 'workitem.comment_deleted',
        actor: { type: 'user', id: 'local-user' },
        payload: { workItemId: item.id, commentId },
        correlationId: `workitem:${item.id}`,
      });
    }
    return deleted;
  }

}
