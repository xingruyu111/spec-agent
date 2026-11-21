/**
 * 执行上下文装配。
 *
 * 只装配与当前 Assignment 有关的作用域：
 * Work Item + 当前群聊近况 + 项目记忆 + Agent 记忆 + 私聊来源 + 执行报告。
 * 不混入其他群聊，不倾倒完整消息库。
 */

import type { Store } from '@spec-agent/core';
import type { WorkService } from '../work/work-service.js';
import type { WorkMemoryRow, WorkMemoryStore } from '../work/work-memory.js';

export type ContextAssemblerOptions = {
  work: WorkService;
  store: Store;
  projectId: string;
  memories?: WorkMemoryStore;
  maxChars?: number;
};

export type AssembledContext = {
  text: string;
  sections: string[];
  chars: number;
};

export class ContextAssembler {
  constructor(private readonly options: ContextAssemblerOptions) {}

  assemble(assignmentId: string, scopedOverride?: WorkMemoryRow[]): AssembledContext {
    const assignment = this.options.work.getAssignment(assignmentId);
    if (!assignment) return { text: '', sections: [], chars: 0 };
    const detail = this.options.work.getWorkItemDetail(assignment.workItemId);
    if (!detail) return { text: '', sections: [], chars: 0 };
    const item = detail.item;
    const sections: string[] = [];

    sections.push(
      [
        '## Work Item',
        `标题：${item.title}`,
        item.intent ? `需求：${item.intent}` : '',
        `状态：${item.state}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (item.groupId) {
      const events = this.options.work
        .listEvents(item.groupId, 40)
        .filter(
          (event) =>
            event.type === 'message.created' ||
            event.type === 'assignment.reported',
        )
        .slice(-20)
        .map((event) => {
          if (event.type === 'assignment.reported') {
            return `${event.actorId}（报告）：${String(
              event.payload.summary ?? '',
            ).slice(0, 500)}`;
          }
          return `${event.actorId}：${String(event.payload.content ?? '').slice(
            0,
            500,
          )}`;
        });
      if (events.length > 0) {
        sections.push(`## 当前群聊近况\n${events.join('\n')}`);
      }
    }

    const origin = item.originEventId
      ? this.options.work.getEvent(item.originEventId)
      : undefined;
    const privateThreadId = origin?.payload.privateThreadId;
    if (typeof privateThreadId === 'string') {
      const thread = this.options.work.privateMessagesByThread(privateThreadId);
      if (thread) {
        const lines = thread.messages
          .slice(-10)
          .map((message) => `${message.actorId}：${message.content.slice(0, 500)}`);
        sections.push(`## 私聊来源\n${lines.join('\n')}`);
      }
    }

    const projectMemories = this.options.store.listMemories({
      scope: 'project',
      limit: 20,
    });
    if (projectMemories.length > 0) {
      sections.push(
        `## 项目记忆\n${projectMemories
          .map((memory) => `- ${memory.content}`)
          .join('\n')}`,
      );
    }

    const agentMemories = this.options.store.listMemories({
      scope: 'agent',
      agentId: assignment.agentId,
      limit: 10,
    });
    if (agentMemories.length > 0) {
      sections.push(
        `## Agent 记忆\n${agentMemories
          .map((memory) => `- ${memory.content}`)
          .join('\n')}`,
      );
    }

    if (this.options.memories) {
      const scopeIds: Partial<Record<
        'org' | 'project' | 'group' | 'agent' | 'private' | 'execution',
        string
      >> = {
        org: 'org',
        project: item.projectId,
        agent: assignment.agentId,
        execution: assignment.id,
      };
      if (item.groupId) scopeIds.group = item.groupId;
      if (typeof privateThreadId === 'string') {
        scopeIds.private = privateThreadId;
      }
      const query = [item.title, item.intent].filter(Boolean).join(' ');
      let scoped: WorkMemoryRow[] =
        scopedOverride ??
        this.options.memories.search({
          projectId: item.projectId,
          query,
          scopeIds,
          limit: 12,
        });
      if (scoped.length === 0) {
        scoped = this.options.memories.forContext({
          projectId: item.projectId,
          groupId: item.groupId,
          agentId: assignment.agentId,
          privateThreadId:
            typeof privateThreadId === 'string' ? privateThreadId : null,
          assignmentId: assignment.id,
        });
      }
      const labels: Record<string, string> = {
        org: 'Org 记忆',
        project: '项目记忆（v2）',
        group: '群聊记忆',
        agent: 'Agent 记忆（v2）',
        private: '私聊记忆',
        execution: '执行记忆',
      };
      for (const scope of [
        'org',
        'project',
        'group',
        'agent',
        'private',
        'execution',
      ] as const) {
        const rows = scoped.filter((memory) => memory.scopeType === scope);
        if (rows.length === 0) continue;
        sections.push(
          `## ${labels[scope]}\n${rows
            .map((memory) => `- ${memory.content}`)
            .join('\n')}`,
        );
      }
    }

    const comments = this.options.work
      .listWorkItemComments(item.id)
      .slice(-10);
    if (comments.length > 0) {
      sections.push(
        `## Work Item 评论\n${comments
          .map(
            (comment) =>
              `- ${comment.authorId}：${comment.content.slice(0, 500)}`,
          )
          .join('\n')}`,
      );
    }

    const execution = detail.assignments.flatMap((candidate) =>
      candidate.reports.map(
        (report) => `- [${report.kind}] ${report.summary.slice(0, 500)}`,
      ),
    );
    if (execution.length > 0) {
      sections.push(`## 执行记录\n${execution.join('\n')}`);
    }

    const maxChars = this.options.maxChars ?? 12_000;
    const kept: string[] = [];
    let chars = 0;
    for (const section of sections) {
      if (chars + section.length > maxChars) break;
      kept.push(section);
      chars += section.length + 2;
    }
    return { text: kept.join('\n\n'), sections: kept, chars };
  }

  async assembleAsync(assignmentId: string): Promise<AssembledContext> {
    const memories = this.options.memories;
    if (!memories) return this.assemble(assignmentId);
    const assignment = this.options.work.getAssignment(assignmentId);
    if (!assignment) return this.assemble(assignmentId);
    const detail = this.options.work.getWorkItemDetail(assignment.workItemId);
    if (!detail) return this.assemble(assignmentId);
    const item = detail.item;
    const origin = item.originEventId
      ? this.options.work.getEvent(item.originEventId)
      : undefined;
    const privateThreadId = origin?.payload.privateThreadId;
    const scopeIds: Partial<
      Record<
        'org' | 'project' | 'group' | 'agent' | 'private' | 'execution',
        string
      >
    > = {
      org: 'org',
      project: item.projectId,
      agent: assignment.agentId,
      execution: assignment.id,
    };
    if (item.groupId) scopeIds.group = item.groupId;
    if (typeof privateThreadId === 'string') scopeIds.private = privateThreadId;
    const query = [item.title, item.intent].filter(Boolean).join(' ');
    const scoped = await memories.searchAsync({
      projectId: item.projectId,
      query,
      scopeIds,
      limit: 12,
    });
    return this.assemble(assignmentId, scoped);
  }
}
