import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatService } from '../chat/chat.js';
import { AppError } from '@spec-agent/kernel';
import { normalizeGitHubPayload } from '../integrations/github-source.js';
import type { OutboxWorker } from '../work/outbox-worker.js';
import { diffLines } from '../infra/line-diff.js';
import type { PrivateAssistant } from '../assistant/private-assistant.js';
import { sourceSecret, verifySourceSignature } from '../integrations/source-signature.js';
import type { WorkExecutor } from '../work/work-executor.js';
import type { WorkMemoryStore } from '../work/work-memory.js';
import type { WorkPlanner } from '../work/work-planner.js';
import type { WorkItemState } from '../work/work-store.js';
import type { WorkService } from '../work/work-service.js';
import type { WorkTriage } from '../work/work-triage.js';
import { handleWorkMemoryRoutes } from './work-memory-routes.js';
import { handleWorkGroupRoutes } from './work-group-routes.js';
import { handleWorkGitHubRoutes } from './work-github-routes.js';
import { handleWorkOutboxRoutes } from './work-outbox-routes.js';
import { handleWorkItemRoutes } from './work-item-routes.js';

export type WorkRouteIo = {
  readRawBody: (request: IncomingMessage) => Promise<string>;
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};
export async function handleWorkRequest(
  work: WorkService,
  workMemory: WorkMemoryStore,
  workExecutor: WorkExecutor | undefined,
  workTriage: WorkTriage | undefined,
  privateAssistant: PrivateAssistant | undefined,
  workPlanner: WorkPlanner | undefined,
  outboxWorker: OutboxWorker | undefined,
  chat: ChatService,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
  io: WorkRouteIo,
): Promise<void> {
  const fail = (status: number, code: string, message: string): void => {
    io.json(response, status, { error: { code, message } });
  };
  try {
    if (await handleWorkMemoryRoutes({ work, workMemory, chat, request, response, path, url, io, fail })) {
      return;
    }

    if (await handleWorkGroupRoutes({ work, workTriage, privateAssistant, workExecutor, chat, request, response, path, url, io, fail })) {
      return;
    }

    if (await handleWorkGitHubRoutes({ work, workExecutor, chat, request, response, path, url, io, fail })) {
      return;
    }

    if (await handleWorkOutboxRoutes({ work, outboxWorker, request, response, path, url, io, fail })) {
      return;
    }

    if (await handleWorkItemRoutes({ work, workExecutor, workPlanner, request, response, path, url, io, fail })) {
      return;
    }

    fail(404, 'E_WORK_NOT_FOUND', path);
  } catch (error) {
    fail(
      400,
      error instanceof AppError ? error.code : 'E_WORK',
      error instanceof Error ? error.message : String(error),
    );
  }
}




