import { AppError } from '@spec-agent/kernel';
import type { Store, TaskRow, MemoryProvider } from '@spec-agent/core';
import type { ChatRepository } from './chat-store.js';
import type { ChatEngine } from '../dsh/dsh-chat.js';
import { parseMemoryCandidates, taskSummary } from './parsers.js';

type MemoryExtractionOptions = {
  repo: ChatRepository;
  store: Store;
  engine: ChatEngine;
  root: string;
  projectId?: string;
  memory?: MemoryProvider;
  watchers: Map<string, NodeJS.Timeout>;
  isClosed: () => boolean;
};

export class MemoryExtraction {
  constructor(private readonly options: MemoryExtractionOptions) {}

  watchTask(taskId: string, sessionId: string): void {
    if (this.options.watchers.has(taskId) || this.options.isClosed()) return;
    const timer = setInterval(() => {
      const task = this.options.store.getTask(taskId);
      if (!task || !['succeeded','failed','cancelled'].includes(task.status)) return;
      clearInterval(timer);
      this.options.watchers.delete(taskId);
      void this.run(taskId, sessionId).catch((error: unknown) => {
        console.warn(`memory extraction failed (${taskId}):`, error instanceof Error ? error.message : error);
      });
    }, 2_000);
    timer.unref?.();
    this.options.watchers.set(taskId, timer);
  }

  async sweep(): Promise<void> {
    if (this.options.isClosed()) return;
    let pending: Array<{ taskId: string; sessionId: string }>;
    try {
      pending = this.options.repo.listPendingMemoryExtractions();
    } catch (error) {
      if (!this.options.isClosed()) {
        console.warn('memory sweep unavailable:', error instanceof Error ? error.message : error);
      }
      return;
    }
    for (const entry of pending) {
      if (this.options.isClosed()) return;
      try {
        await this.run(entry.taskId, entry.sessionId);
      } catch (error) {
        console.warn(`memory sweep failed (${entry.taskId}):`, error instanceof Error ? error.message : error);
      }
    }
  }

  async run(taskId: string, sessionId: string): Promise<void> {
    if (!this.options.repo.claimMemoryExtraction(taskId, sessionId)) return;
    const task = this.options.store.getTask(taskId);
    if (!task) {
      this.options.repo.finishMemoryExtraction(taskId, '任务不存在');
      throw new AppError('E_TASK_NOT_FOUND', `任务不存在：${taskId}`);
    }
    try {
      if (this.options.memory) {
        await this.options.memory.ingestTaskResult({
          projectId: this.options.projectId ?? 'local',
          taskId: task.id,
          agentId: task.assignee,
          title: task.title,
          status: task.status,
          summary: taskSummary(task),
        });
      }
      await this.extractTaskMemories(task, sessionId);
      this.options.repo.finishMemoryExtraction(taskId);
    } catch (error) {
      this.options.repo.finishMemoryExtraction(taskId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async extractTaskMemories(task: TaskRow, sessionId: string): Promise<void> {
    const summary = taskSummary(task);
    if (!summary.trim()) return;
    const result = await this.options.engine.run({
      root: this.options.root,
      prompt: [
        '你是一个记忆提取器。只输出 JSON，不要输出 Markdown。',
        '阅读下面的任务结果，提取最多 5 条对以后同类任务有帮助的稳定事实。',
        '不要记录临时路径、密钥、一次性日志或未经确认的猜测。',
        '格式：{"memories":[{"scope":"project|agent","agentId":"可选","content":"事实","tags":["标签"]}]}',
        '',
        summary,
      ].join('\n'),
    });
    const candidates = parseMemoryCandidates(result.text);
    const existing = new Set(this.options.store.listMemories({ limit: 500 }).map((memory) => memory.content));
    for (const candidate of candidates.slice(0, 5)) {
      if (!candidate.content || existing.has(candidate.content)) continue;
      const isAgent = candidate.scope === 'agent' && candidate.agentId;
      this.options.store.createMemory({
        scope: isAgent ? 'agent' : 'project',
        agentId: isAgent ? candidate.agentId : null,
        content: candidate.content,
        tags: candidate.tags,
        source: `task:${task.id}`,
        confidence: 0.7,
      });
      existing.add(candidate.content);
    }
    this.options.repo.addMessage({
      sessionId,
      role: 'system',
      content: `任务结束，已检查并沉淀 ${Math.min(candidates.length, 5)} 条记忆候选。`,
      mode: 'task',
    });
  }
}
