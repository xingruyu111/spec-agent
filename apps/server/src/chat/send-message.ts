import { AppError } from '@spec-agent/kernel';
import type { ChatRepository } from './chat-store.js';
import type { ChatEngine, ChatDelta, ChatEngineRunResult } from '../dsh/dsh-chat.js';
import type { ChatMode } from './store-types.js';
import type { ChatSessionDetail } from './service-types.js';

const MAX_MESSAGE = 8000;

type SendMessageDeps = {
  repo: ChatRepository;
  engine: ChatEngine;
  root: string;
  resolveRoute: (providerId?: string, model?: string) => { providerId: string | null; model: string | null };
  resolveMentions: (sessionId: string, text: string, explicit?: string[]) => string[];
  dispatchTask: (sessionId: string, text: string) => Promise<void>;
  replyAsAgents: (sessionId: string, text: string, mentions: string[], onStatus?: (status: string) => void, parallel?: boolean) => Promise<void>;
  buildQaPrompt: (sessionId: string, text: string) => Promise<string>;
  recordAssistantResult: (sessionId: string, text: string, mode: ChatMode, result: ChatEngineRunResult, options: { updateTitle: boolean }) => Promise<void>;
  getSessionDetail: (id: string) => ChatSessionDetail;
};

export async function sendMessage(
  deps: SendMessageDeps,
  sessionId: string,
  content: string,
  mode: ChatMode,
  hooks: {
    onStatus?: (status: string) => void;
    onDelta?: (delta: ChatDelta) => void;
    mentions?: string[];
    parallel?: boolean;
  } = {},
): Promise<ChatSessionDetail> {
    const session = deps.repo.getSession(sessionId);
    if (!session) throw new AppError('E_CHAT_NOT_FOUND', `对话不存在：${sessionId}`);
    const text = content.trim();
    if (!text) throw new AppError('E_EMPTY_MESSAGE', '消息不能为空');
    if (text.length > MAX_MESSAGE) {
      throw new AppError('E_MESSAGE_TOO_LONG', `消息最多 ${MAX_MESSAGE} 字`);
    }

    const route = deps.resolveRoute(
      session.providerId ?? undefined,
      session.model ?? undefined,
    );
    const routeChanged =
      session.providerId !== route.providerId || session.model !== route.model;
    deps.repo.updateSession(sessionId, {
      mode,
      providerId: route.providerId,
      model: route.model,
      ...(routeChanged ? { dshSessionId: null } : {}),
    });
    const mentions = deps.resolveMentions(sessionId, text, hooks.mentions);
    deps.repo.addMessage({
      sessionId,
      role: 'user',
      content: text,
      mode,
      senderType: 'user',
      mentions,
    });

    if (mode === 'task') {
      hooks.onStatus?.('正在生成任务计划…');
      await deps.dispatchTask(sessionId, text);
      return deps.getSessionDetail(sessionId);
    }

    const agentMentions = mentions.filter((agentId) => agentId !== 'assistant');
    const directAgentId =
      agentMentions.length === 0 && session.kind === 'direct'
        ? session.primaryAgentId
        : null;
    if (agentMentions.length > 0 || directAgentId) {
      await deps.replyAsAgents(
        sessionId,
        text,
        agentMentions.length > 0 ? agentMentions : [directAgentId!],
        hooks.onStatus,
        hooks.parallel,
      );
      return deps.getSessionDetail(sessionId);
    }

    const prompt = await deps.buildQaPrompt(sessionId, text);
    try {
      const result = await deps.engine.run({
        root: deps.root,
        sessionId: routeChanged ? null : session.dshSessionId,
        providerId: route.providerId ?? undefined,
        model: route.model ?? undefined,
        permissionMode: session.permissionMode,
        prompt,
        onStatus: hooks.onStatus,
        onDelta: hooks.onDelta,
      });
      await deps.recordAssistantResult(sessionId, text, mode, result, {
        updateTitle: session.title === '新对话',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof AppError ? error.code : '';
      deps.repo.addMessage({
        sessionId,
        role: 'assistant',
        content: `${
          code === 'E_PROJECT_PLAN_INVALID' ? '项目计划草案无效' : 'DSH 暂时不可用'
        }：${message}`,
        mode,
        status: 'error',
      });
    }

    return deps.getSessionDetail(sessionId);
  }

