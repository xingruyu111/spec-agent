import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@spec-agent/core';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  MemoryProvider,
  ProviderConfig,
} from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import { ChatRepository } from '../../apps/server/src/chat/chat-store.js';
import { ChatService } from '../../apps/server/src/chat/chat.js';
import type { ChatEngine } from '../../apps/server/src/dsh/dsh-chat.js';

const roots: string[] = [];
const cleanups: Array<() => void> = [];

function setup(
  engine: ChatEngine,
  autoMemory = false,
  agents: AgentConfig[] = [],
  memory?: MemoryProvider,
  providers?: ProviderConfig[],
  defaultRoute?: () => { providerId: string; model: string },
  agentRuntime?: AgentRuntime,
  provider?: ProviderConfig,
) {
  const root = mkdtempSync(join(tmpdir(), 'hive-chat-'));
  roots.push(root);
  mkdirSync(join(root, '.spec-agent'), { recursive: true });
  const store = new Store({ path: join(root, '.spec-agent', 'spec-agent.db') });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // 测试失败路径可能已经关闭
    }
  });
  const repo = new ChatRepository(store.db, store.clock);
  const reloadAgents = vi.fn();
  const createProjectPlan = vi.fn(async () => ({ id: 'plan-chat-1' }));
  const service = new ChatService({
    root,
    store,
    repo,
    engine,
    agents: () => agents,
    createTask: vi.fn(async (goal: string) => ({
      taskId: 'task-chat-1',
      title: goal,
    })),
    reloadAgents,
    createProjectPlan,
    autoMemory,
    projectName: '测试项目',
    memory,
    ...(providers ? { providers: () => providers } : {}),
    ...(defaultRoute ? { defaultRoute } : {}),
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(provider ? { provider } : {}),
  });
  return { root, store, repo, service, reloadAgents, createProjectPlan };
}

function fakeEngine(text: string, reasoning?: string): ChatEngine {
  return {
    run: vi.fn(async ({ sessionId }) => ({
      sessionId: sessionId ?? 'dsh-1',
      text,
      ...(reasoning ? { reasoning } : {}),
    })),
    close: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const PM: AgentConfig = {
  id: 'pm' as AgentConfig['id'],
  name: '项目经理',
  parent: null,
  role: '拆解与验收',
  model: { provider: 'inherit', model: 'inherit' },
  skills: [],
  tools: { allow: ['Read'], shell: 'readonly' },
};

const FE: AgentConfig = {
  id: 'fe' as AgentConfig['id'],
  name: '前端',
  parent: 'pm' as AgentConfig['id'],
  role: '实现前端',
  model: { provider: 'inherit', model: 'inherit' },
  skills: [],
  tools: { allow: ['Read'], shell: 'readonly' },
};

const BE: AgentConfig = {
  id: 'be' as AgentConfig['id'],
  name: '后端',
  parent: 'pm' as AgentConfig['id'],
  role: '实现后端',
  model: { provider: 'inherit', model: 'inherit' },
  skills: [],
  tools: { allow: ['Read'], shell: 'readonly' },
};

const PLAN_BLOCK = [  '项目计划草案如下。',
  '```hive-project-plan',
  JSON.stringify({
    title: '聊天项目计划',
    verifyCommand: 'pnpm test',
    workstreams: [
      {
        id: 'design',
        title: '设计',
        brief: '完成设计',
        assignee: 'pm',
        milestone: 'M1',
        dependsOn: [],
      },
      {
        id: 'delivery',
        title: '交付',
        brief: '完成交付',
        assignee: 'pm',
        milestone: 'M2',
        dependsOn: ['design'],
      },
    ],
  }),
  '```',
].join('\n');

describe('ChatService', () => {
  it('@agent 跳过助理并写回 agent 回复', async () => {
    const engine = fakeEngine('助理不应该回复');
    const agentRuntime: AgentRuntime = {
      id: 'fake-agent',
      run: vi.fn(async () => ({
        outputs: [],
        text: '前端：登录跳转已确认，可以改 /home。',
        transcriptRef: 'sdk://agent-chat-1',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      })),
    };
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      engine,
      false,
      [PM],
      undefined,
      undefined,
      undefined,
      agentRuntime,
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm'],
    });
    const detail = await service.sendMessage(session.id, '@pm 看一下登录跳转', 'qa', {
      mentions: ['pm'],
    });
    expect(engine.run).not.toHaveBeenCalled();
    expect(agentRuntime.run).toHaveBeenCalledTimes(1);
    const reply = detail.messages.find((message) => message.senderType === 'agent');
    expect(reply).toMatchObject({
      senderAgentId: 'pm',
      content: expect.stringContaining('/home'),
    });
  });

  it('多个 @agent 按 mentions 顺序串行回复', async () => {
    const engine = fakeEngine('助理不应该回复');
    const agentRuntime: AgentRuntime = {
      id: 'fake-agent',
      run: vi.fn(async (input) => ({
        outputs: [],
        text: `回复：${input.systemPrompt}`,
        transcriptRef: 'sdk://agent-chat-2',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      })),
    };
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      engine,
      false,
      [PM, FE],
      undefined,
      undefined,
      undefined,
      agentRuntime,
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm', 'fe'],
    });
    const detail = await service.sendMessage(session.id, '一起看一下', 'qa', {
      mentions: ['pm', 'fe'],
    });
    expect(engine.run).not.toHaveBeenCalled();
    expect(
      detail.messages
        .filter((message) => message.senderType === 'agent')
        .map((message) => message.senderAgentId),
    ).toEqual(['pm', 'fe']);
  });

  it('文本里的 @agent 名称也能触发路由', async () => {
    const engine = fakeEngine('助理不应该回复');
    const agentRuntime: AgentRuntime = {
      id: 'fake-agent',
      run: vi.fn(async () => ({
        outputs: [],
        text: '项目经理：收到。',
        transcriptRef: 'sdk://agent-chat-3',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      })),
    };
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      engine,
      false,
      [PM],
      undefined,
      undefined,
      undefined,
      agentRuntime,
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm'],
    });
    const detail = await service.sendMessage(session.id, '@项目经理 看一下', 'qa');
    expect(engine.run).not.toHaveBeenCalled();
    expect(detail.messages.at(-1)).toMatchObject({
      senderType: 'agent',
      senderAgentId: 'pm',
    });
    expect(
      detail.messages.find((message) => message.senderType === 'user')?.mentions,
    ).toEqual(['pm']);
  });

  it('agent 回复失败会写回错误消息而不是打断会话', async () => {
    const agentRuntime: AgentRuntime = {
      id: 'fake-agent',
      run: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      fakeEngine('助理不应该回复'),
      false,
      [PM],
      undefined,
      undefined,
      undefined,
      agentRuntime,
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm'],
    });
    const detail = await service.sendMessage(session.id, '@pm 你好', 'qa', {
      mentions: ['pm'],
    });
    expect(detail.messages.at(-1)).toMatchObject({
      senderType: 'agent',
      senderAgentId: 'pm',
      status: 'error',
    });
    expect(detail.messages.at(-1)?.content).toContain('provider down');
  });

  it('agent 回复持久化 session，后续消息 resume', async () => {
    const run = vi.fn(async (_input: AgentRuntimeInput) => ({
      outputs: [],
      text: '记住上下文',
      transcriptRef: 'sdk://agent-chat-persisted',
      usage: { usd: 0.01 },
      stopReason: 'finished' as const,
    }));
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      fakeEngine('助理不应该回复'),
      false,
      [PM],
      undefined,
      undefined,
      undefined,
      { id: 'fake-agent', run },
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm'],
    });
    await service.sendMessage(session.id, '@pm 第一条', 'qa', { mentions: ['pm'] });
    await service.sendMessage(session.id, '@pm 第二条', 'qa', { mentions: ['pm'] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].resumeSessionId).toBe('sdk://agent-chat-persisted');
    const participant = service
      .getSessionDetail(session.id)
      .participants.find((item) => item.agentId === 'pm');
    expect(participant?.agentSessionId).toBe('sdk://agent-chat-persisted');
  });

  it('agent 回复里的 @ 会自动接力给下一个 agent', async () => {
    const run = vi.fn(async (input: AgentRuntimeInput) => {
      if (input.systemPrompt.includes('拆解与验收')) {
        return {
          outputs: [],
          text: '@前端 请接着检查页面。',
          transcriptRef: 'sdk://agent-pm',
          usage: { usd: 0.01 },
          stopReason: 'finished' as const,
        };
      }
      return {
        outputs: [],
        text: '前端：收到，已检查。',
        transcriptRef: 'sdk://agent-fe',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      };
    });
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      fakeEngine('助理不应该回复'),
      false,
      [PM, FE],
      undefined,
      undefined,
      undefined,
      { id: 'fake-agent', run },
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm', 'fe'],
    });
    const detail = await service.sendMessage(session.id, '@pm 一起看一下', 'qa', {
      mentions: ['pm'],
    });
    expect(run).toHaveBeenCalledTimes(2);
    const agentMessages = detail.messages.filter(
      (message) => message.senderType === 'agent',
    );
    expect(agentMessages.map((message) => message.senderAgentId)).toEqual(['pm', 'fe']);
    expect(agentMessages[0]?.mentions).toEqual(['fe']);
    expect(run.mock.calls[1]![0].task).toContain('项目经理 刚刚回复');
  });

  it('agent 间 @ 不会形成循环', async () => {
    const run = vi.fn(async (input: AgentRuntimeInput) => ({
      outputs: [],
      text: input.systemPrompt.includes('拆解与验收')
        ? '@前端 继续'
        : '@项目经理 继续',
      transcriptRef: 'sdk://agent-loop',
      usage: { usd: 0.01 },
      stopReason: 'finished' as const,
    }));
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      fakeEngine('助理不应该回复'),
      false,
      [PM, FE],
      undefined,
      undefined,
      undefined,
      { id: 'fake-agent', run },
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm', 'fe'],
    });
    const detail = await service.sendMessage(session.id, '@pm 循环测试', 'qa', {
      mentions: ['pm'],
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      detail.messages.filter((message) => message.senderType === 'agent'),
    ).toHaveLength(2);
  });

  it('每条用户消息最多 3 次 agent 回复', async () => {
    const run = vi.fn(async (input: AgentRuntimeInput) => {
      const text = input.systemPrompt.includes('拆解与验收')
        ? '@前端 继续'
        : input.systemPrompt.includes('实现前端')
          ? '@后端 继续'
          : '@项目经理 继续';
      return {
        outputs: [],
        text,
        transcriptRef: 'sdk://agent-cap',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      };
    });
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      fakeEngine('助理不应该回复'),
      false,
      [PM, FE, BE],
      undefined,
      undefined,
      undefined,
      { id: 'fake-agent', run },
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm', 'fe', 'be'],
    });
    await service.sendMessage(session.id, '@pm 最多三次', 'qa', { mentions: ['pm'] });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('direct 会话默认由指定 agent 回复，不需要 @', async () => {
    const engine = fakeEngine('助理不应该回复');
    const agentRuntime: AgentRuntime = {
      id: 'fake-agent',
      run: vi.fn(async () => ({
        outputs: [],
        text: '项目经理：直接回复。',
        transcriptRef: 'sdk://agent-direct',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      })),
    };
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      engine,
      false,
      [PM],
      undefined,
      undefined,
      undefined,
      agentRuntime,
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'direct',
      primaryAgentId: 'pm',
      participantAgentIds: ['pm'],
    });
    expect(session.kind).toBe('direct');
    const detail = await service.sendMessage(session.id, '你好', 'qa');
    expect(engine.run).not.toHaveBeenCalled();
    expect(detail.messages.at(-1)).toMatchObject({
      senderType: 'agent',
      senderAgentId: 'pm',
    });
  });

  it('parallel 会同时启动本轮多个 agent', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async (input: AgentRuntimeInput) => {
      started += 1;
      if (started >= 2) release();
      await gate;
      return {
        outputs: [],
        text: `${input.systemPrompt.includes('拆解与验收') ? 'pm' : 'fe'} 并行回复`,
        transcriptRef: 'sdk://agent-parallel',
        usage: { usd: 0.01 },
        stopReason: 'finished' as const,
      };
    });
    const provider: ProviderConfig = {
      id: 'fake',
      name: 'fake',
      protocol: 'anthropic',
      baseUrl: 'http://127.0.0.1:1',
      authToken: 'test',
      models: {},
    };
    const { service } = setup(
      fakeEngine('助理不应该回复'),
      false,
      [PM, FE],
      undefined,
      undefined,
      undefined,
      { id: 'fake-agent', run },
      provider,
    );
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm', 'fe'],
    });
    const detail = await service.sendMessage(session.id, '一起看', 'qa', {
      mentions: ['pm', 'fe'],
      parallel: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(
      detail.messages
        .filter((message) => message.senderType === 'agent')
        .map((message) => message.senderAgentId),
    ).toEqual(['pm', 'fe']);
  });

  it('会话自动加入助理，参与者与 @ 元数据持久化', async () => {
    const { service } = setup(fakeEngine('收到'), false, [PM]);
    const session = service.createSession({
      mode: 'qa',
      kind: 'group',
      participantAgentIds: ['pm'],
    });
    expect(session.kind).toBe('group');
    expect(session.assistantAgentId).toBe('assistant');

    let detail = service.getSessionDetail(session.id);
    expect(detail.participants.map((item) => item.agentId).sort()).toEqual([
      'assistant',
      'pm',
    ]);
    expect(detail.participants.find((item) => item.agentId === 'pm')?.role).toBe(
      'member',
    );

    detail = await service.sendMessage(session.id, '你好', 'qa');
    const user = detail.messages.find((message) => message.role === 'user');
    const assistant = detail.messages.find((message) => message.role === 'assistant');
    expect(user).toMatchObject({ senderType: 'user', mentions: [] });
    expect(assistant).toMatchObject({
      senderType: 'assistant',
      senderAgentId: 'assistant',
    });

    expect(service.removeParticipant(session.id, 'pm')).toBe(true);
    expect(service.removeParticipant(session.id, 'assistant')).toBe(false);
  });

  it('QA 对话持久化，并解析 hive-change 草案', async () => {
    const engine = fakeEngine(
      [
        '可以新增一个前端 agent。',
        '```hive-change',
        JSON.stringify({
          summary: '新增前端 agent',
          operations: [
            {
              op: 'upsert_agent',
              agent: {
                id: 'fe',
                name: '前端',
                parent: null,
                role: '实现前端',
                nodes: [{ id: 'ui', name: '页面', description: '实现页面' }],
              },
            },
          ],
        }),
        '```',
      ].join('\n'),
      '先确认当前组织，再提出新增 agent 草案。',
    );
    const { service, store } = setup(engine);
    const session = service.createSession();
    store.createMemory({ scope: 'project', content: '组件统一使用 CSS Modules' });
    const detail = await service.sendMessage(
      session.id,
      '加一个前端 agent，组件用 CSS Modules',
      'qa',
    );

    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.content).toBe('可以新增一个前端 agent。');
    expect(detail.messages[1]?.reasoning).toBe(
      '先确认当前组织，再提出新增 agent 草案。',
    );
    expect(detail.messages[1]?.changeSet?.summary).toBe('新增前端 agent');
    expect(engine.run).toHaveBeenCalledWith(
      expect.objectContaining({
        root: expect.any(String),
        prompt: expect.stringContaining('加一个前端 agent'),
      }),
    );
    expect(vi.mocked(engine.run).mock.calls[0]?.[0].prompt).toContain(
      '组件统一使用 CSS Modules',
    );
    expect(vi.mocked(engine.run).mock.calls[0]?.[0].prompt).toContain(
      '每个 upsert_node 都必须同时给出 outputPath 和 doneCriteria',
    );
    const stored = service.getSessionDetail(session.id);
    expect(stored.session.title).toContain('加一个前端 agent');
    store.close();
    await service.close();
  });

  it('生成并应用 hive-project-plan 草案，应用只创建 draft 且不启动', async () => {
    const { service, store, createProjectPlan } = setup(
      fakeEngine(PLAN_BLOCK),
      false,
      [PM],
    );
    const session = service.createSession();
    const detail = await service.sendMessage(
      session.id,
      '帮我规划一个分阶段项目',
      'qa',
    );
    const draft = detail.messages.at(-1)!.projectPlanDraft!;
    expect(detail.messages.at(-1)!.content).toBe('项目计划草案如下。');
    expect(draft.status).toBe('pending');
    expect(draft.workstreams).toHaveLength(2);
    expect(draft.workstreams[1]!.dependsOn).toEqual(['ws-1']);

    const applied = await service.applyProjectPlanDraft(draft.id);
    expect(applied.status).toBe('applied');
    expect(applied.planId).toBe('plan-chat-1');
    expect(createProjectPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '聊天项目计划',
        verifyCommand: 'pnpm test',
        workstreams: expect.any(Array),
      }),
      {},
    );
    await expect(service.applyProjectPlanDraft(draft.id)).rejects.toMatchObject({
      code: 'E_PROJECT_PLAN_DRAFT_CLOSED',
    });
    store.close();
    await service.close();
  });

  it('拒绝项目计划草案，且拒绝未知 assignee', async () => {
    const { service, store, createProjectPlan } = setup(
      fakeEngine(PLAN_BLOCK),
      false,
      [PM],
    );
    const session = service.createSession();
    const detail = await service.sendMessage(session.id, '生成项目计划', 'qa');
    const draft = detail.messages.at(-1)!.projectPlanDraft!;
    const rejected = service.rejectProjectPlanDraft(draft.id);
    expect(rejected.status).toBe('rejected');
    expect(createProjectPlan).not.toHaveBeenCalled();
    store.close();
    await service.close();

    const invalid = PLAN_BLOCK.replace('"assignee":"pm"', '"assignee":"missing"');
    const bad = setup(fakeEngine(invalid), false, [PM]);
    const badSession = bad.service.createSession();
    const badDetail = await bad.service.sendMessage(
      badSession.id,
      '生成项目计划',
      'qa',
    );
    expect(badDetail.messages.at(-1)!.content).toContain('项目计划草案无效');
    expect(badDetail.messages.at(-1)!.status).toBe('error');
    bad.store.close();
    await bad.service.close();
  });

  it('应用变更后写入 agents.yaml 并热加载', async () => {
    const engine = fakeEngine(
      [
        '草案如下。',
        '```hive-change',
        JSON.stringify({
          summary: '新增 pm',
          operations: [
            {
              op: 'upsert_agent',
              agent: {
                id: 'pm',
                name: '项目经理',
                parent: 'root',
                role: '拆解需求',
              },
            },
          ],
        }),
        '```',
      ].join('\n'),
    );
    const { root, service, reloadAgents, store } = setup(engine);
    const session = service.createSession();
    const detail = await service.sendMessage(session.id, '建一个 PM', 'qa');
    const changeSet = detail.messages[1]?.changeSet;
    expect(changeSet?.status).toBe('pending');

    const applied = service.applyChangeSet(changeSet!.id);
    expect(applied.changeSet.status).toBe('applied');
    expect(reloadAgents).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'pm' })]),
    );
    expect(readFileSync(join(root, '.spec-agent', 'agents.yaml'), 'utf8')).toContain('pm');

    store.close();
    await service.close();
  });

  it('应用配置变更后自动继续执行下一步', async () => {
    let call = 0;
    const engine: ChatEngine = {
      run: vi.fn(async (input) => {
        call += 1;
        return {
          sessionId: input.sessionId ?? 'dsh-auto',
          text:
            call === 1
              ? [
                  '草案如下。',
                  '```hive-change',
                  JSON.stringify({
                    summary: '新增规划 agent',
                    operations: [
                      {
                        op: 'upsert_agent',
                        agent: {
                          id: 'planner-extra',
                          name: '规划补充',
                          parent: 'root',
                          role: '拆解需求',
                        },
                      },
                    ],
                  }),
                  '```',
                ].join('\n')
              : PLAN_BLOCK,
        };
      }),
      close: vi.fn(async () => undefined),
    };
    const { service, store } = setup(engine, false, [PM]);
    const session = service.createSession();
    const detail = await service.sendMessage(session.id, '添加规划 agent 并继续', 'qa');
    const changeSet = detail.messages.at(-1)!.changeSet!;
    service.applyChangeSet(changeSet.id);
    const continued = await service.continueAfterChangeSet(changeSet.id);
    expect(engine.run).toHaveBeenCalledTimes(2);
    expect(continued?.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(continued?.messages.at(-1)?.projectPlanDraft?.title).toBe('聊天项目计划');
    store.close();
    await service.close();
  });

  it('拒绝变更不会写 agents.yaml', async () => {    const engine = fakeEngine(
      [
        '草案。',
        '```hive-change',
        JSON.stringify({
          summary: '删除 pm',
          operations: [{ op: 'delete_agent', id: 'pm' }],
        }),
        '```',
      ].join('\n'),
    );
    const { service, store } = setup(engine);
    const session = service.createSession();
    const detail = await service.sendMessage(session.id, '删 pm', 'qa');
    const rejected = service.rejectChangeSet(detail.messages[1]!.changeSet!.id);
    expect(rejected.status).toBe('rejected');
    store.close();
    await service.close();
  });

  it('任务模式派发并记录 taskId', async () => {
    const engine = fakeEngine('');
    const { service, store } = setup(engine, false, [
      {
        id: 'pm' as AgentConfig['id'],
        name: '项目经理',
        parent: null,
        role: '拆解需求',
        model: { provider: 'inherit', model: 'inherit' },
        skills: [],
        tools: { allow: ['Read'], shell: 'readonly' },
      },
    ]);
    const session = service.createSession();
    const detail = await service.sendMessage(session.id, '实现登录页', 'task');
    expect(detail.messages.at(-1)).toMatchObject({
      role: 'assistant',
      mode: 'task',
      taskId: 'task-chat-1',
    });
    expect(engine.run).not.toHaveBeenCalled();
    store.close();
    await service.close();
  });

  it('聊天生成的节点必须带输出文件和完成标准', async () => {
    const engine = fakeEngine(
      [
        '草案。',
        '```hive-change',
        JSON.stringify({
          summary: '新增不完整节点',
          operations: [
            {
              op: 'upsert_node',
              agentId: 'pm',
              node: {
                id: 'incomplete',
                name: '不完整节点',
                description: '缺少输出契约',
              },
            },
          ],
        }),
        '```',
      ].join('\n'),
    );
    const { service, store } = setup(engine, false, [
      {
        id: 'pm' as AgentConfig['id'],
        name: '项目经理',
        parent: null,
        role: '拆解需求',
        model: { provider: 'inherit', model: 'inherit' },
        skills: [],
        tools: { allow: ['Read'], shell: 'readonly' },
      },
    ]);
    const session = service.createSession();
    const detail = await service.sendMessage(session.id, '加节点', 'qa');
    expect(() =>
      service.applyChangeSet(detail.messages.at(-1)!.changeSet!.id),
    ).toThrowError(/outputPath/);
    store.close();
    await service.close();
  });

  it('只读记忆检索保持 project/agent 作用域', async () => {
    const { service, store } = setup(fakeEngine(''));
    store.createMemory({ scope: 'project', content: '使用 pnpm' });
    store.createMemory({
      scope: 'agent',
      agentId: 'fe',
      content: '组件放在 web/components',
    });
    expect(service.listMemories().map((memory) => memory.content)).toContain('使用 pnpm');
    expect(service.listMemories('fe').map((memory) => memory.content)).toContain(
      '组件放在 web/components',
    );
    expect(store.memoryDigest('fe', '组件目录')).toEqual(
      expect.arrayContaining(['组件放在 web/components']),
    );
    store.close();
    await service.close();
  });

  it('自动从任务结果提取记忆并去重', async () => {
    const engine = fakeEngine(
      JSON.stringify({
        memories: [
          { scope: 'project', content: '前端组件统一使用 CSS Modules', tags: ['前端'] },
          { scope: 'project', content: '前端组件统一使用 CSS Modules', tags: ['重复'] },
          { scope: 'agent', agentId: 'fe', content: '登录接口使用 JWT', tags: ['auth'] },
        ],
      }),
    );
    const { service, store } = setup(engine, true);
    const session = service.createSession();
    store.db
      .prepare(
        `INSERT INTO tasks
          (id, parent_id, assignee, caller, title, status, result, cost_usd, branch, created_at, finished_at, plan_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-memory-1',
        null,
        'pm',
        null,
        '登录页',
        'succeeded',
        JSON.stringify({ summary: '完成登录页，使用 JWT' }),
        0,
        null,
        store.clock.iso(),
        store.clock.iso(),
        0,
      );

    await service.extractMemoriesForTask('task-memory-1', session.id);
    const memories = service.listMemories();
    expect(memories.some((memory) => memory.content.includes('CSS Modules'))).toBe(true);
    expect(memories.filter((memory) => memory.content.includes('CSS Modules'))).toHaveLength(1);
    expect(memories.some((memory) => memory.scope === 'agent' && memory.agentId === 'fe')).toBe(true);
    store.close();
    await service.close();
  });

  it('记忆扫描遇到已关闭数据库不会产生未处理异常', async () => {
    const { service, store } = setup(fakeEngine(''), true);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.close();
    await expect(
      (service as unknown as { sweepMemoryExtractions(): Promise<void> })
        .sweepMemoryExtractions(),
    ).resolves.toBeUndefined();
    await service.close();
    warning.mockRestore();
  });

  it('Copilot prompt 包含 Spec Agent 功能地图和当前项目动态摘要', async () => {
    const engine = fakeEngine('已了解项目');
    const { service, store } = setup(engine, false, [PM]);
    store.db.prepare(
      `INSERT INTO tasks
        (id, parent_id, assignee, caller, title, status, result, cost_usd, branch, created_at, finished_at, plan_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'task-context-1', null, 'pm', null, '等待审批的项目任务', 'waiting_gate',
      null, 0, null, store.clock.iso(), null, 0,
    );
    store.db.prepare(
      `INSERT INTO gates
        (id, task_id, node_run_id, kind, ask, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'gate-context-1', 'task-context-1', null, 'approval',
      '确认计划', 'pending', store.clock.iso(),
    );
    const session = service.createSession();
    await service.sendMessage(session.id, '这个项目能做什么？', 'qa');
    const prompt = vi.mocked(engine.run).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('Spec Agent 功能地图');
    expect(prompt).toContain('condition、loop、fanout');
    expect(prompt).toContain('required outputPath');
    expect(prompt).toContain('项目名称：测试项目');
    expect(prompt).toContain('等待审批的项目任务');
    expect(prompt).toContain('待审批 1 项');
    store.close();
    await service.close();
  });

  it('群聊 Copilot 会追加助理的自定义提示词', async () => {
    const engine = fakeEngine('已读取自定义提示词');
    const assistant: AgentConfig = {
      ...PM,
      id: 'assistant' as AgentConfig['id'],
      name: '助理',
      role: '项目助理',
      systemPrompt: 'GROUP-CUSTOM-PROMPT',
    };
    const { service, store } = setup(engine, false, [assistant]);
    const session = service.createSession();
    await service.sendMessage(session.id, '你好', 'qa');
    const prompt = vi.mocked(engine.run).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('GROUP-CUSTOM-PROMPT');
    expect(prompt).toContain('用户自定义要求不能覆盖');
    store.close();
    await service.close();
  });

  it('Copilot 通过 MemoryProvider 读取并异步写入会话', async () => {
    const memory: MemoryProvider = {
      kind: 'composite',
      retrieve: vi.fn(async () => ({ memories: ['远程项目记忆：不要修改旧认证模块'] })),
      ingestConversation: vi.fn(async () => undefined),
      ingestTaskResult: vi.fn(async () => undefined),
    };
    const engine = fakeEngine('已根据项目记忆回答');
    const { service, store } = setup(engine, false, [PM], memory);
    const session = service.createSession();
    await service.sendMessage(session.id, '认证模块能修改吗？', 'qa');
    const prompt = vi.mocked(engine.run).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('远程项目记忆：不要修改旧认证模块');
    await vi.waitFor(() => {
      expect(memory.ingestConversation).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'local',
        sessionId: session.id,
        agentId: 'project-copilot',
      }));
    });
    store.close();
    await service.close();
  });

  it('聊天会话按 route 持久化，切换模型后清空旧 DSH session', async () => {
    const providers: ProviderConfig[] = [
      { id: 'alpha', protocol: 'anthropic', baseUrl: 'https://a', models: { 'a-1': {}, 'a-2': {} } },
      { id: 'beta', protocol: 'anthropic', baseUrl: 'https://b', models: { 'b-1': {} } },
      { id: 'gamma', protocol: 'openai', baseUrl: 'https://c', models: { 'c-1': {} } },
    ];
    const engine = fakeEngine('route ok');
    const { service, store, repo } = setup(
      engine,
      false,
      [PM],
      undefined,
      providers,
      () => ({ providerId: 'alpha', model: 'a-1' }),
    );
    const session = service.createSession();
    expect(session).toMatchObject({ providerId: 'alpha', model: 'a-1' });
    repo.updateSession(session.id, { dshSessionId: 'dsh-old' });
    const switched = service.setRoute(session.id, 'beta', 'b-1');
    expect(switched).toMatchObject({ providerId: 'beta', model: 'b-1', dshSessionId: null });
    expect(() => service.setRoute(session.id, 'beta', 'a-1')).toThrowError(/模型不属于/);
    const openaiRoute = service.setRoute(session.id, 'gamma', 'c-1');
    expect(openaiRoute).toMatchObject({ providerId: 'gamma', model: 'c-1' });
    await service.sendMessage(session.id, 'test route', 'qa');
    expect(engine.run).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'gamma',
      model: 'c-1',
      sessionId: null,
    }));
    store.close();
    await service.close();
  });
});

