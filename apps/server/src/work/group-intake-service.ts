import type { WorkStore } from './work-store.js';
import type { WorkAssignmentRow, WorkEventRow, WorkItemRow } from './types.js';
import type { WorkActor, GroupIntake } from './work-service.js';

type OpenWorkItemInput = {
  groupId: string;
  eventId: string;
  requestedBy: WorkActor;
  title: string;
  intent?: string | null;
  priority?: number;
  assignee?: string;
};
type OpenWorkItemResult = { item: WorkItemRow; assignment: WorkAssignmentRow | null };

export class GroupIntakeService {
  constructor(
    private readonly store: WorkStore,
    private readonly assistantAgentId: string,
    private readonly openWorkItem: (input: OpenWorkItemInput) => OpenWorkItemResult,
  ) {}

  intakeGroupMessage(input: {    groupId: string;
    author: WorkActor;
    content: string;
    mentions?: string[];
    dedupeKey?: string;
    correlationId?: string;
    depth?: number;
  }): GroupIntake {
    const group = this.store.getGroup(input.groupId);
    if (!group) throw new Error(`group 不存在：${input.groupId}`);
    const content = input.content.trim();
    if (!content) throw new Error('消息不能为空');
    const mentions = Array.from(
      new Set((input.mentions ?? []).filter((id) => Boolean(id))),
    );
    const recipients =
      mentions.length > 0 ? mentions : [this.assistantAgentId];
    const { event } = this.store.appendEvent({
      projectId: group.projectId,
      groupId: group.id,
      type: 'message.created',
      actor: input.author,
      payload: { content, mentions, recipients },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    });
    const { event: mentionEvent } = this.store.appendEvent({
      projectId: group.projectId,
      groupId: group.id,
      type: 'message.mention',
      actor: input.author,
      payload: {
        messageEventId: event.id,
        recipients,
        assistantFallback: mentions.length === 0,
      },
      correlationId: event.correlationId,
      causationId: event.id,
      dedupeKey: `${event.id}:mention`,
      depth: event.depth + 1,
    });
    return {
      event,
      mentionEvent,
      recipients,
      requiresAssistant: mentions.length === 0,
    };
  }

  /**
   * 助理回复。作为 message.created 落库，但不自动再次触发助理，避免回环。
   */
  postAssistantMessage(input: {
    groupId: string;
    content: string;
    mentions?: string[];
    causationId?: string;
    correlationId?: string;
  }): WorkEventRow {
    const group = this.store.getGroup(input.groupId);
    if (!group) throw new Error(`group 不存在：${input.groupId}`);
    const mentions = input.mentions ?? [];
    const { event } = this.store.appendEvent({
      projectId: group.projectId,
      groupId: group.id,
      type: 'message.created',
      actor: { type: 'agent', id: this.assistantAgentId },
      payload: {
        content: input.content,
        mentions,
        recipients: mentions,
        assistant: true,
      },
      ...(input.causationId ? { causationId: input.causationId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return event;
  }

  /**
   * 外部事件源入口：GitHub / 飞书 / CI。
   * 先落 source.event，再投递成群聊消息；同一 externalId 幂等。
   */
  ingestSourceEvent(input: {
    projectId: string;
    groupId: string;
    source: 'github' | 'feishu' | 'ci';
    externalId: string;
    title: string;
    body?: string;
    url?: string;
    event?: string;
    action?: string;
    deliveryId?: string;
  }): {
    sourceEvent: WorkEventRow;
    messageEvent?: WorkEventRow;
    duplicate: boolean;
  } {
    const group = this.store.getGroup(input.groupId);
    if (!group || group.projectId !== input.projectId) {
      throw new Error('目标群聊不属于当前项目');
    }
    const sourceEvent = this.store.appendEvent({
      projectId: input.projectId,
      groupId: group.id,
      type: 'source.event',
      actor: { type: 'system', id: input.source },
      payload: {
        source: input.source,
        externalId: input.externalId,
        title: input.title,
        body: input.body ?? '',
        url: input.url ?? '',
        ...(input.event ? { event: input.event } : {}),
        ...(input.action ? { action: input.action } : {}),
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      },
      dedupeKey: `source:${input.source}:${input.externalId}`,
    });
    if (sourceEvent.duplicate) {
      return { sourceEvent: sourceEvent.event, duplicate: true };
    }
    const message = this.store.appendEvent({
      projectId: input.projectId,
      groupId: group.id,
      type: 'message.created',
      actor: { type: 'system', id: input.source },
      payload: {
        content: [
          `[${input.source}] ${input.title}`,
          input.body ?? '',
          input.url ?? '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        mentions: [],
        recipients: [this.assistantAgentId],
        source: input.source,
        externalId: input.externalId,
        ...(input.url ? { url: input.url } : {}),
        ...(input.event ? { event: input.event } : {}),
        ...(input.action ? { action: input.action } : {}),
      },
      correlationId: sourceEvent.event.correlationId,
      causationId: sourceEvent.event.id,
      dedupeKey: `${sourceEvent.event.id}:message`,
      depth: 1,
    });
    return {
      sourceEvent: sourceEvent.event,
      messageEvent: message.event,
      duplicate: false,
    };
  }
  triageMessage(input: {
    groupId: string;
    eventId: string;
    title?: string;
    assignee?: string;
  }): { item: WorkItemRow; assignment: WorkAssignmentRow | null } {
    const group = this.store.getGroup(input.groupId);
    if (!group) throw new Error(`group 不存在：${input.groupId}`);
    const event = this.store.getEvent(input.eventId);
    if (!event || event.groupId !== group.id || event.type !== 'message.created') {
      throw new Error('需要一条属于该群聊的 message.created 事件');
    }
    const content = String(event.payload.content ?? '').trim();
    const title =
      input.title?.trim() ||
      content.split('\n')[0]?.slice(0, 80) ||
      '未命名工作项';
    return this.openWorkItem({
      groupId: group.id,
      eventId: event.id,
      requestedBy: { type: event.actorType, id: event.actorId },
      title,
      intent: content,
      ...(input.assignee ? { assignee: input.assignee } : {}),
    });
  }

}
