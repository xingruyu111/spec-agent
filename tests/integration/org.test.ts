/**
 * M3：组织配置生效——委派白名单、agent 提示词/工具默认值。
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentConfig,
  AgentId,
  LlmNode,
  NodeId,
  WorkflowSpec,
} from '@spec-agent/schema';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
} from '@spec-agent/core';
import { Engine, Store } from '@spec-agent/core';
import { createIdFactory, type Clock } from '@spec-agent/kernel';

const T = (s: string) => s as never;
const N = (s: string) => s as NodeId;
const AG = (s: string) => s as AgentId;

const clock: Clock = {
  now: () => Date.parse('2026-10-26T00:00:00.000Z'),
  iso: (at = Date.parse('2026-10-26T00:00:00.000Z')) => new Date(at).toISOString(),
  sleep: async () => {},
};

const agents: AgentConfig[] = [
  {
    id: AG('pm'),
    name: 'PM',
    parent: null,
    role: 'PM',
    systemPrompt: 'PM-SYSTEM',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read', 'Write'] },
    workspace: { writeScope: ['.'] },
    canDelegateTo: [AG('fe')],
  },
  {
    id: AG('fe'),
    name: 'FE',
    parent: AG('pm'),
    role: 'FE',
    systemPrompt: 'FE-SYSTEM',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read', 'Write'] },
    workspace: { writeScope: ['.'] },
  },
  {
    id: AG('be'),
    name: 'BE',
    parent: AG('pm'),
    role: 'BE',
    systemPrompt: 'BE-SYSTEM',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read', 'Write'] },
    workspace: { writeScope: ['.'] },
  },
];

class RecordingRuntime implements AgentRuntime {
  readonly id = 'recording';
  calls: AgentRuntimeInput[] = [];
  async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    this.calls.push(input);
    return {
      outputs: [{ name: 'out', kind: 'text' as const }],
      transcriptRef: 't',
      usage: { usd: 0.01 },
      stopReason: 'finished' as const,
    };
  }
}

function delegateSpec(target: string): WorkflowSpec {
  return {
    name: 'pm',
    version: 1,
    params: [],
    nodes: [
      {
        id: N('delegate'),
        type: 'delegate',
        description: '派发',
        inputs: [],
        outputs: [],
        agent: AG(target),
        brief: '做事',
      },
    ],
    edges: [],
  };
}

function llmSpec(tools: string[]): WorkflowSpec {
  return {
    name: 'work',
    version: 1,
    params: [],
    nodes: [
      {
        id: N('implement'),
        type: 'llm',
        description: '实现',
        inputs: [],
        outputs: [],
        tools,
      },
    ],
    edges: [],
  };
}

function makeEngine(
  store: Store,
  runtime: AgentRuntime,
  spec: WorkflowSpec,
  childSpec: WorkflowSpec,
  engineAgents: AgentConfig[] = agents,
): Engine {
  return new Engine({
    store,
    planner: {
      plan: async (task) => ({
        spec: task.assignee === 'pm' ? spec : childSpec,
      }),
    },
    runtime,
    shell: {
      run: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      }),
    },
    clock,
    ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
    provider: { id: 'fake' },
    model: 'fake',
    workspaceRoot: process.cwd(),
    agents: engineAgents,
  });
}

async function run(
  spec: WorkflowSpec,
  childSpec: WorkflowSpec,
): Promise<{ status?: string; runtime: RecordingRuntime; store: Store }> {
  const store = new Store({ path: ':memory:', clock });
  const runtime = new RecordingRuntime();
  const engine = makeEngine(store, runtime, spec, childSpec);
  engine.dispatch({
    type: 'task.create',
    taskId: T('task_pm'),
    assignee: AG('pm'),
    caller: null,
    title: '组织测试',
    brief: '',
  });
  await engine.runUntilIdle();
  return { status: store.getTask('task_pm')?.status, runtime, store };
}

class SlowRuntime implements AgentRuntime {
  readonly id = 'slow';
  active = 0;
  maxActive = 0;

  async run(): Promise<AgentRuntimeOutput> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.active -= 1;
    return {
      outputs: [{ name: 'out', kind: 'text' }],
      transcriptRef: 't',
      usage: { usd: 0.01 },
      stopReason: 'finished',
    };
  }
}

function agentNodeSpec(agent: string): WorkflowSpec {
  return {
    name: `work-${agent}`,
    version: 1,
    params: [],
    nodes: [
      {
        id: N('implement'),
        type: 'llm',
        agent: AG(agent),
        description: '做事',
        inputs: [],
        outputs: [],
        tools: [],
      },
    ],
    edges: [],
  };
}

const parallelParentSpec: WorkflowSpec = {
  name: 'parallel',
  version: 1,
  params: [],
  nodes: [
    {
      id: N('fe-work'),
      type: 'llm',
      agent: AG('fe'),
      description: '前端',
      inputs: [],
      outputs: [],
      tools: [],
    },
    {
      id: N('be-work'),
      type: 'llm',
      agent: AG('be'),
      description: '后端',
      inputs: [],
      outputs: [],
      tools: [],
    },
  ],
  edges: [],
};

function parallelEngine(
  store: Store,
  runtime: AgentRuntime,
  maxConcurrentChildren?: number,
): Engine {
  return new Engine({
    store,
    planner: {
      plan: async (task) => ({
        spec:
          task.assignee === 'pm'
            ? parallelParentSpec
            : agentNodeSpec(task.assignee),
      }),
    },
    runtime,
    shell: {
      run: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      }),
    },
    clock,
    ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
    provider: { id: 'fake' },
    model: 'fake',
    workspaceRoot: process.cwd(),
    agents,
    maxConcurrentChildren,
  });
}

describe('任务 assignee', () => {
  it('必须在组织配置内', () => {
    const store = new Store({ path: ':memory:', clock });
    const runtime = new RecordingRuntime();
    const engine = makeEngine(store, runtime, llmSpec([]), llmSpec([]));
    try {
      expect(() =>
        engine.dispatch({
          type: 'task.create',
          taskId: T('task_ghost'),
          assignee: AG('ghost'),
          caller: null,
          title: '未知 agent',
          brief: '',
        }),
      ).toThrowError(/assignee/);
    } finally {
      store.close();
    }
  });
});

describe('并行调度', () => {
  it('互不依赖的跨 agent 节点并行执行', async () => {
    const store = new Store({ path: ':memory:', clock });
    const runtime = new SlowRuntime();
    const engine = parallelEngine(store, runtime);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_parallel'),
        assignee: AG('pm'),
        caller: null,
        title: '并行',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_parallel')?.status).toBe('succeeded');
      expect(runtime.maxActive).toBeGreaterThanOrEqual(2);
      const children = store.listChildTasks('task_parallel');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.status === 'succeeded')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('maxConcurrentChildren 限制同时运行的子任务数', async () => {
    const store = new Store({ path: ':memory:', clock });
    const runtime = new SlowRuntime();
    const engine = parallelEngine(store, runtime, 1);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_serial'),
        assignee: AG('pm'),
        caller: null,
        title: '受限并行',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_serial')?.status).toBe('succeeded');
      expect(runtime.maxActive).toBe(1);
      expect(store.listChildTasks('task_serial')).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

const sameAgentParentSpec: WorkflowSpec = {
  name: 'same-agent-parallel',
  version: 1,
  params: [],
  nodes: [
    {
      id: N('a'),
      type: 'llm',
      description: '任务 A',
      inputs: [],
      outputs: [],
      tools: [],
    },
    {
      id: N('b'),
      type: 'llm',
      description: '任务 B',
      inputs: [],
      outputs: [],
      tools: [],
    },
  ],
  edges: [],
};

const sameAgentChildSpec: WorkflowSpec = {
  name: 'same-agent-node',
  version: 1,
  params: [],
  nodes: [
    {
      id: N('work'),
      type: 'llm',
      description: '执行节点',
      inputs: [],
      outputs: [],
      tools: [],
    },
  ],
  edges: [],
};

function sameAgentEngine(
  store: Store,
  runtime: AgentRuntime,
  maxConcurrentChildren?: number,
): Engine {
  return new Engine({
    store,
    planner: {
      plan: async (task) => ({
        spec: task.parentId ? sameAgentChildSpec : sameAgentParentSpec,
      }),
    },
    runtime,
    shell: {
      run: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      }),
    },
    clock,
    ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
    provider: { id: 'fake' },
    model: 'fake',
    workspaceRoot: process.cwd(),
    isolateNodes: true,
    maxConcurrentChildren,
  });
}

describe('同 agent 并行', () => {
  it('根任务的同 agent 节点也各开子任务并行执行', async () => {
    const store = new Store({ path: ':memory:', clock });
    const runtime = new SlowRuntime();
    const engine = sameAgentEngine(store, runtime);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_same'),
        assignee: AG('pm'),
        caller: null,
        title: '同 agent 并行',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_same')?.status).toBe('succeeded');
      expect(runtime.maxActive).toBeGreaterThanOrEqual(2);
      const children = store.listChildTasks('task_same');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.assignee === 'pm')).toBe(true);
      expect(children.every((child) => child.status === 'succeeded')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('同 agent 并行也受 maxConcurrentChildren 限制', async () => {
    const store = new Store({ path: ':memory:', clock });
    const runtime = new SlowRuntime();
    const engine = sameAgentEngine(store, runtime, 1);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_same_limit'),
        assignee: AG('pm'),
        caller: null,
        title: '同 agent 限流',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_same_limit')?.status).toBe('succeeded');
      expect(runtime.maxActive).toBe(1);
      expect(store.listChildTasks('task_same_limit')).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe('组织配置', () => {
  it('允许 pm → fe，并把 agent 提示词传给执行器', async () => {
    const child = llmSpec([]);
    const { status, runtime, store } = await run(delegateSpec('fe'), child);
    try {
      expect(status).toBe('succeeded');
      expect(runtime.calls[0]?.systemPrompt).toContain('FE-SYSTEM');
      expect(runtime.calls[0]?.allowedTools).toEqual(['Read', 'Write']);
      expect(store.listChildTasks('task_pm')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('不允许 pm → be 时委派失败', async () => {
    const { status, store } = await run(delegateSpec('be'), llmSpec([]));
    try {
      expect(status).toBe('failed');
      expect(store.listChildTasks('task_pm')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('节点可以指定子 agent 执行，并使用其提示词和工具', async () => {
    const spec = llmSpec([]);
    (spec.nodes[0] as LlmNode).agent = AG('fe');

    const { status, runtime, store } = await run(spec, spec);
    try {
      expect(status).toBe('succeeded');
      expect(runtime.calls).toHaveLength(1);
      expect(runtime.calls[0]?.systemPrompt).toContain('FE-SYSTEM');
      expect(runtime.calls[0]?.allowedTools).toEqual(['Read', 'Write']);
    } finally {
      store.close();
    }
  });

  it('不能把节点分配给同级 agent', async () => {
    const spec = llmSpec([]);
    (spec.nodes[0] as LlmNode).agent = AG('be');

    const store = new Store({ path: ':memory:', clock });
    const runtime = new RecordingRuntime();
    const engine = makeEngine(store, runtime, spec, spec);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_fe'),
        assignee: AG('fe'),
        caller: null,
        title: '同级分配',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_fe')?.status).toBe('failed');
      expect(runtime.calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('没有 canDelegateTo 时按直接子节点委派', async () => {
    const localAgents = agents.map((agent) =>
      agent.id === AG('pm') ? { ...agent, canDelegateTo: undefined } : agent,
    );

    const store = new Store({ path: ':memory:', clock });
    const runtime = new RecordingRuntime();
    const engine = new Engine({
      store,
      planner: {
        plan: async (task) => ({
          spec: task.assignee === 'pm' ? delegateSpec('fe') : llmSpec([]),
        }),
      },
      runtime,
      shell: {
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        }),
      },
      clock,
      ids: createIdFactory({ clock, random: () => new Uint8Array(10) }),
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: process.cwd(),
      agents: localAgents,
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_pm'),
        assignee: AG('pm'),
        caller: null,
        title: '默认委派范围',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_pm')?.status).toBe('succeeded');
      expect(store.listChildTasks('task_pm')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('自动委派的子任务失败时父节点失败', async () => {
    const spec = llmSpec([]);
    (spec.nodes[0] as LlmNode).agent = AG('fe');

    const store = new Store({ path: ':memory:', clock });
    const runtime = new RecordingRuntime();
    runtime.run = async () => ({
      outputs: [],
      transcriptRef: '',
      usage: { usd: 0 },
      stopReason: 'failed',
      error: { code: 'E_AGENT_FAILED', message: '子 agent 失败' },
    });
    const engine = makeEngine(store, runtime, spec, spec);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_pm'),
        assignee: AG('pm'),
        caller: null,
        title: '自动委派失败',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_pm')?.status).toBe('failed');
      const children = store.listChildTasks('task_pm');
      expect(children).toHaveLength(1);
      expect(children[0]?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('setAgents 热加载后新任务使用新角色', async () => {
    const spec = llmSpec([]);
    (spec.nodes[0] as LlmNode).agent = AG('fe');

    const store = new Store({ path: ':memory:', clock });
    const runtime = new RecordingRuntime();
    const engine = makeEngine(
      store,
      runtime,
      spec,
      spec,
      agents.filter((agent) => agent.id !== AG('fe')),
    );

    try {
      engine.setAgents(agents);
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_hot'),
        assignee: AG('pm'),
        caller: null,
        title: '热加载',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_hot')?.status).toBe('succeeded');
      expect(runtime.calls[0]?.systemPrompt).toContain('FE-SYSTEM');
      engine.setAgents(undefined);
      engine.setAgents(agents);
    } finally {
      store.close();
    }
  });

  it('取消父节点会取消等待中的子任务', async () => {
    const spec = llmSpec([]);
    const node = spec.nodes[0] as LlmNode;
    node.agent = AG('fe');
    node.approval = { approvers: ['human'] };

    const store = new Store({ path: ':memory:', clock });
    const runtime = new RecordingRuntime();
    const engine = makeEngine(store, runtime, spec, spec);

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_child_cancel'),
        assignee: AG('pm'),
        caller: null,
        title: '取消子任务',
        brief: '',
      });
      await engine.runUntilIdle();

      const parentRun = store
        .listRuns('task_child_cancel')
        .find((run) => !run.parentRunId)!;
      const parentNode = store.listNodeRuns(parentRun.id)[0]!;
      const child = store.listChildTasks('task_child_cancel')[0]!;
      expect(child.status).toBe('waiting_gate');

      await engine.cancelNode(T('task_child_cancel'), parentNode.id, '取消父节点');

      expect(store.getTask('task_child_cancel')?.status).toBe('failed');
      expect(store.getTask(child.id)?.status).toBe('cancelled');
      expect(store.listPendingGates()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('节点工具超出 agent 白名单时失败', async () => {
    const { status, runtime, store } = await run(
      { ...llmSpec(['Bash']), name: 'pm' },
      llmSpec([]),
    );
    try {
      expect(status).toBe('failed');
      expect(runtime.calls).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

