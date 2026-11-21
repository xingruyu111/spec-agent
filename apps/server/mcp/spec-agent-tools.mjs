#!/usr/bin/env node
/**
 * Local MCP tool server for Spec Agent organization actions.
 *
 * This process is spawned by the DSH mcp-client in the assistant's profile.
 * It only touches .spec-agent/agents.yaml and asks the app server to hot-reload
 * the runtime. It never exposes project file tools.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const sdkCjs = dirname(require.resolve('@modelcontextprotocol/sdk/package.json'));
const sdkDist = join(sdkCjs, '..');
const { McpServer } = await import(
  pathToFileURL(join(sdkDist, 'esm/server/mcp.js')).href
);
const { StdioServerTransport } = await import(
  pathToFileURL(join(sdkDist, 'esm/server/stdio.js')).href
);

const root = process.env.SPEC_AGENT_ROOT;
const envProjectId = process.env.SPEC_AGENT_PROJECT_ID;
const serverUrl =
  process.env.SPEC_AGENT_SERVER_URL ?? 'http://127.0.0.1:4317';
if (!root || !envProjectId) {
  console.error('spec-agent-tools: SPEC_AGENT_ROOT and SPEC_AGENT_PROJECT_ID are required');
  process.exit(1);
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function resolveProjectId() {
  try {
    const response = await fetch(`${serverUrl}/api/projects`);
    if (!response.ok) return envProjectId;
    const body = await response.json();
    const match = (body.projects ?? []).find(
      (project) => normalizePath(project.root ?? '') === normalizePath(root),
    );
    return match?.id ?? envProjectId;
  } catch {
    return envProjectId;
  }
}

const projectId = await resolveProjectId();

const agentsFile = join(root, '.spec-agent', 'agents.yaml');

function readAgents() {
  try {
    const parsed = parse(readFileSync(agentsFile, 'utf8'));
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

function writeAgents(agents) {
  mkdirSync(dirname(agentsFile), { recursive: true });
  writeFileSync(agentsFile, stringify({ agents }, { lineWidth: 0 }), 'utf8');
}

async function reloadAgents() {
  try {
    const response = await fetch(`${serverUrl}/api/agents/reload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-spec-agent-project': projectId,
      },
      body: '{}',
    });
    return response.ok;
  } catch {
    return false;
  }
}

const server = new McpServer({
  name: 'spec-agent-tools',
  version: '0.1.0',
});

server.registerTool(
  'create_agent',
  {
    title: 'Create organization agent',
    description:
      'Create a flat organization agent in Spec Agent. This only writes the organization agents.yaml; it never modifies project files.',
    inputSchema: {
      name: z.string().min(1).max(64).describe('Display name of the new agent'),
      role: z
        .string()
        .max(200)
        .optional()
        .describe('Short responsibility description'),
    },
  },
  async ({ name, role }) => {
    const agents = readAgents();
    if (agents.some((agent) => agent.name === name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Agent 已存在：${name}` }],
      };
    }
    const id = `agent-${Date.now().toString(36)}`;
    const created = {
      id,
      name,
      parent: null,
      role: role?.trim() || '项目 Agent',
      systemPrompt:
        role?.trim() ||
        '你是这个组织的项目 Agent，负责回答问题和协助推进任务。',
      model: { provider: 'inherit', model: 'inherit' },
      skills: [],
      nodes: [],
      tools: { allow: ['Read'], shell: 'readonly' },
      canDelegateTo: [],
      workspace: { writeScope: ['.'] },
    };
    writeAgents([...agents, created]);
    const reloaded = await reloadAgents();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id,
            name,
            role: created.role,
            parent: null,
            reloaded,
          }),
        },
      ],
    };
  },
);

server.registerTool(
  'add_group_member',
  {
    title: 'Add agent to group',
    description:
      'Add an organization agent to a Spec Agent group chat by agent name. This only changes group membership, not project files.',
    inputSchema: {
      groupId: z.string().min(1).describe('Group id'),
      agentName: z.string().min(1).describe('Agent display name'),
    },
  },
  async ({ groupId, agentName }) => {
    const headers = {
      'content-type': 'application/json',
      'x-spec-agent-project': projectId,
    };
    const agentsResponse = await fetch(`${serverUrl}/api/agents`, { headers });
    if (!agentsResponse.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: '读取 Agent 列表失败' }],
      };
    }
    const agentsBody = await agentsResponse.json();
    const agent = (agentsBody.agents ?? []).find(
      (candidate) => candidate.name === agentName,
    );
    if (!agent) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Agent 不存在：${agentName}` }],
      };
    }
    const response = await fetch(
      `${serverUrl}/api/work/groups/${encodeURIComponent(groupId)}/members`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ agentId: agent.id }),
      },
    );
    if (!response.ok) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `加入群聊失败：HTTP ${response.status}` },
        ],
      };
    }
    const body = await response.json();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            groupId,
            agentId: agent.id,
            agentName: agent.name,
            members: body.members,
          }),
        },
      ],
    };
  },
);

server.registerTool(
  'create_work_item',
  {
    title: 'Create work item',
    description:
      'Create a Spec Agent work item from a group message event. Returns the created item.',
    inputSchema: {
      groupId: z.string().min(1),
      eventId: z.string().min(1),
      title: z.string().min(1).max(200).optional(),
      assignee: z.string().optional(),
    },
  },
  async ({ groupId, eventId, title, assignee }) => {
    const response = await fetch(
      `${serverUrl}/api/work/groups/${encodeURIComponent(groupId)}/triage`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-spec-agent-project': projectId,
        },
        body: JSON.stringify({
          eventId,
          ...(title ? { title } : {}),
          ...(assignee ? { assignee } : {}),
        }),
      },
    );
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `创建工作项失败：HTTP ${response.status}` }],
      };
    }
    return {
      content: [{ type: 'text', text: await response.text() }],
    };
  },
);

server.registerTool(
  'reply_in_group',
  {
    title: 'Reply in group',
    description: 'Send an assistant reply into a Spec Agent group chat.',
    inputSchema: {
      groupId: z.string().min(1),
      content: z.string().min(1).max(4000),
    },
  },
  async ({ groupId, content }) => {
    const response = await fetch(
      `${serverUrl}/api/work/groups/${encodeURIComponent(groupId)}/reply`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-spec-agent-project': projectId,
        },
        body: JSON.stringify({ content }),
      },
    );
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `发送回复失败：HTTP ${response.status}` }],
      };
    }
    return {
      content: [{ type: 'text', text: await response.text() }],
    };
  },
);

server.registerTool(
  'list_agents',
  {
    title: 'List organization agents',
    description: 'List organization agents (name, role, parent) in Spec Agent.',
  },
  async () => {
    const agents = readAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role ?? '',
      parent: agent.parent ?? null,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ agents }) }],
    };
  },
);

await server.connect(new StdioServerTransport());
