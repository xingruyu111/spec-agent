import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '@spec-agent/kernel';
import {
  agentsPath,
  loadAgents,
  parseAgents,
  saveAgents,
  type SpecAgentRuntime,
} from '@spec-agent/runtime';

type AgentRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
};

type AgentRouteContext = {
  runtime: SpecAgentRuntime;
  repo: string;
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  io: AgentRouteIo;
};

export async function handleAgentRoutes(
  ctx: AgentRouteContext,
): Promise<boolean> {
  const { runtime, repo, request, response, path, io } = ctx;

  if (path === '/api/agents/config') {
    const root = dirname(repo);
    if (request.method === 'GET') {
      io.json(response, 200, {
        agents: runtime.agents ?? [],
        path: agentsPath(root),
        exists: existsSync(agentsPath(root)),
      });
      return true;
    }

    if (request.method === 'PUT') {
      const body = await io.readJson(request);
      try {
        const agents = parseAgents(body.agents);
        const saved = saveAgents(root, agents);
        runtime.reloadAgents(saved);
        io.json(response, 200, {
          agents: saved,
          path: agentsPath(root),
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'E_AGENT_CONFIG') {
          io.json(response, 400, {
            error: { code: error.code, message: error.message },
          });
          return true;
        }
        throw error;
      }
      return true;
    }
  }

  if (request.method === 'GET' && path === '/api/agents') {
    try {
      const loaded = loadAgents(dirname(repo));
      if (loaded) runtime.reloadAgents(loaded);
    } catch {
      // Keep the last known-good runtime state if the file is mid-write.
    }
    io.json(response, 200, {
      agents: (runtime.agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        parent: agent.parent,
        role: agent.role,
        model: agent.model,
        tools: agent.tools.allow,
        writeScope: agent.workspace?.writeScope ?? [],
        canDelegateTo: agent.canDelegateTo ?? [],
        nodes: agent.nodes ?? [],
      })),
    });
    return true;
  }

  if (request.method === 'POST' && path === '/api/agents/reload') {
    const loaded = loadAgents(dirname(repo));
    if (!loaded) {
      io.json(response, 404, {
        error: { code: 'E_AGENT_CONFIG', message: 'agents.yaml 不存在' },
      });
      return true;
    }
    runtime.reloadAgents(loaded);
    io.json(response, 200, { agents: loaded.length });
    return true;
  }

  return false;
}
