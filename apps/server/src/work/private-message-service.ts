import type { WorkStore } from './work-store.js';
import type { WorkEventRow } from './types.js';

export class PrivateMessageService {
  constructor(
    private readonly store: WorkStore,
    private readonly assistantAgentId: string,
  ) {}

  privateThread(projectId: string, agentId: string, userId: string) {
    return this.store.getOrCreatePrivateThread({ projectId, agentId, userId });
  }

  privateMessages(projectId: string, agentId: string, userId: string) {
    const thread = this.privateThread(projectId, agentId, userId);
    return {
      thread,
      messages: this.store.listPrivateMessages(thread.id),
    };
  }

  privateMessagesByThread(threadId: string) {
    const thread = this.store.getPrivateThread(threadId);
    return thread
      ? {
          thread,
          messages: this.store.listPrivateMessages(thread.id, 50),
        }
      : undefined;
  }

  appendPrivateUserMessage(
    threadId: string,
    userId: string,
    content: string,
  ): void {
    this.store.addPrivateMessage({
      threadId,
      actorType: 'user',
      actorId: userId,
      content,
    });
  }

  appendPrivateAgentMessage(
    threadId: string,
    agentId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.store.addPrivateMessage({
      threadId,
      actorType: 'agent',
      actorId: agentId,
      content,
      ...(metadata ? { metadata } : {}),
    });
  }

  agentHistory(projectId: string, agentId: string) {
    return this.store.listAssignmentsByAgent(projectId, agentId).map((assignment) => ({
      ...assignment,
      reports: this.store.listReports(assignment.id),
    }));
  }

  /**
   * 私聊消息：
   * - 指定 targetGroupId：把需求提到项目群聊，由助理接单；
   * - 否则回答该 Agent 最近做了什么。
   */
  sendPrivateMessage(input: {
    projectId: string;
    agentId: string;
    userId: string;
    content: string;
    targetGroupId?: string;
  }): {
    thread: ReturnType<WorkStore['getOrCreatePrivateThread']>;
    messages: ReturnType<WorkStore['listPrivateMessages']>;
    groupEvent?: WorkEventRow;
  } {
    const content = input.content.trim();
    if (!content) throw new Error('消息不能为空');
    const thread = this.privateThread(
      input.projectId,
      input.agentId,
      input.userId,
    );
    this.store.addPrivateMessage({
      threadId: thread.id,
      actorType: 'user',
      actorId: input.userId,
      content,
    });

    let groupEvent: WorkEventRow | undefined;
    if (input.targetGroupId) {
      const group = this.store.getGroup(input.targetGroupId);
      if (!group || group.projectId !== input.projectId) {
        throw new Error('目标群聊不属于当前项目');
      }
      groupEvent = this.store.appendEvent({
        projectId: input.projectId,
        groupId: group.id,
        type: 'message.created',
        actor: { type: 'agent', id: input.agentId },
        payload: {
          content,
          mentions: [],
          recipients: [this.assistantAgentId],
          privateThreadId: thread.id,
          fromPrivate: true,
        },
      }).event;
      this.store.addPrivateMessage({
        threadId: thread.id,
        actorType: 'agent',
        actorId: input.agentId,
        content: `已把需求提到 ${group.name}，由助理接单。`,
        metadata: { groupId: group.id, groupEventId: groupEvent.id },
      });
    } else {
      const assignments = this.store.listAssignmentsByAgent(
        input.projectId,
        input.agentId,
      );
      const answer =
        assignments.length === 0
          ? '我还没有在这个项目里执行过 Work Item。'
          : [
              '我最近做的事：',
              ...assignments.map(
                (assignment) =>
                  `- [${assignment.state}] ${assignment.itemTitle}`,
              ),
            ].join('\n');
      this.store.addPrivateMessage({
        threadId: thread.id,
        actorType: 'agent',
        actorId: input.agentId,
        content: answer,
      });
    }

    return {
      thread,
      messages: this.store.listPrivateMessages(thread.id),
      ...(groupEvent ? { groupEvent } : {}),
    };
  }

}
