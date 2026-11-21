import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '@spec-agent/kernel';
import { assistText, type AiAssistKind } from '@spec-agent/runtime';
import type { AgentRuntime, ProviderConfig } from '@spec-agent/core';

type AiRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};

type AiRouteContext = {
  planner: { agentRuntime?: AgentRuntime; provider: ProviderConfig; model: string };
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  io: AiRouteIo;
};

export async function handleAiRoutes(ctx: AiRouteContext): Promise<boolean> {
  const { planner, request, response, path, io } = ctx;

  if (request.method === 'POST' && path === '/api/ai/assist') {
    if (!planner.agentRuntime) {
      io.json(response, 503, {
        error: { code: 'E_AI_UNAVAILABLE', message: '没有配置可用的 AgentRuntime' },
      });
      return true;
    }
    const body = await io.readJson(request);
    const kind = String(body.kind ?? '');
    const allowedKinds: AiAssistKind[] = [
      'role',
      'systemPrompt',
      'nodeDescription',
      'nodeInstructions',
    ];
    if (!allowedKinds.includes(kind as AiAssistKind)) {
      io.json(response, 400, {
        error: { code: 'E_AI_INVALID', message: '不支持的 AI 辅助类型' },
      });
      return true;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4000) {
      io.json(response, 400, {
        error: { code: 'E_AI_INVALID', message: '原文必填，且最多 4000 字' },
      });
      return true;
    }
    const requestedModel =
      typeof body.model === 'string' ? body.model.trim() : '';
    if (requestedModel.length > 100) {
      io.json(response, 400, {
        error: { code: 'E_AI_INVALID', message: '模型名过长' },
      });
      return true;
    }
    const rawContext =
      body.context && typeof body.context === 'object' && !Array.isArray(body.context)
        ? (body.context as Record<string, unknown>)
        : {};
    if (Object.keys(rawContext).length > 20) {
      io.json(response, 400, {
        error: { code: 'E_AI_INVALID', message: '上下文过多' },
      });
      return true;
    }
    const context: Record<string, string | number | undefined> = {};
    for (const [key, value] of Object.entries(rawContext)) {
      if (typeof value === 'string') {
        if (value.length > 4000) {
          io.json(response, 400, {
            error: { code: 'E_AI_INVALID', message: `上下文字段过长：${key}` },
          });
          return true;
        }
        context[key] = value;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        context[key] = value;
      }
    }

    try {
      const result = await assistText({
        kind: kind as AiAssistKind,
        text,
        context,
        agentRuntime: planner.agentRuntime,
        provider: planner.provider,
        model:
          requestedModel && requestedModel !== 'inherit'
            ? requestedModel
            : planner.model,
      });
      io.json(response, 200, result);
    } catch (error) {
      if (error instanceof AppError) {
        const status =
          error.code === 'E_AGENT_SDK_MISSING' || error.code === 'E_AI_UNAVAILABLE'
            ? 503
            : error.code === 'E_AI_FAILED'
              ? 502
              : 422;
        io.json(response, status, {
          error: { code: error.code, message: error.message },
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}

