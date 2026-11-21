/**
 * I2 集成：engine + store + 假 runtime + 假 shell。
 *
 * 证明：线性 DAG 能跑完、人工闸门能暂停与恢复、失败能重试、进程重启后能继续。
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentId,
  AgentConfig,
  ArtifactRef,
  GateId,
  LlmNode,
  NodeId,
  NodeRunId,
  NodeSpec,
  RunId,
  TaskId,
  WorkflowSpec,
} from '@spec-agent/schema';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
  AgentToolEvent,
  GitService,
  MemoryNodeOutcome,
  Planner,
  ShellResult,
  ShellRunner,
  ShellInput,
} from '@spec-agent/core';
import { Engine, Store, specHash } from '@spec-agent/core';
import { createIdFactory, type Clock, type IdFactory } from '@spec-agent/kernel';

const T = (s: string) => s as TaskId;
const N = (s: string) => s as NodeId;
const R = (s: string) => s as NodeRunId;
const RUN = (s: string) => s as RunId;
const G = (s: string) => s as GateId;
const AG = (s: string) => s as AgentId;

const clock: Clock = {
  now: () => Date.parse('2026-10-26T00:00:00.000Z'),
  iso: (at = Date.parse('2026-10-26T00:00:00.000Z')) => new Date(at).toISOString(),
  sleep: async () => {},
};

class FakeRuntime implements AgentRuntime {
  readonly id = 'fake';
  calls: AgentRuntimeInput[] = [];
  outputs: ArtifactRef[] = [{ name: 'out', kind: 'text' }];
  toolEvents: AgentToolEvent[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    this.calls.push(input);
    for (const event of this.toolEvents) input.onToolEvent?.(event);
    return {
      outputs: this.outputs,
      text: input.systemPrompt.includes('交付物验证器')
        ? '{"pass":true,"score":1,"reason":"测试产物满足标准"}'
        : 'done',
      transcriptRef: 'transcript://fake',
      usage: { usd: 0.1 },
      stopReason: 'finished',
    };
  }
}

class SilentRuntime extends FakeRuntime {
  override async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    const output = await super.run(input);
    return { ...output, text: '' };
  }
}

class SessionRuntime implements AgentRuntime {
  readonly id = 'session-fake';
  calls: AgentRuntimeInput[] = [];
  created = 0;

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    this.calls.push(input);
    const forked = input.forkSession === true;
    const sessionId =
      input.resumeSessionId && !forked
        ? input.resumeSessionId
        : `session-${(this.created += 1)}`;
    return {
      outputs: [],
      text: 'done',
      transcriptRef: `sdk://${sessionId}`,
      usage: {
        usd: 0.1,
        cacheReadInputTokens: input.resumeSessionId ? 900 : 0,
        cacheCreationInputTokens: input.resumeSessionId ? 0 : 900,
      },
      stopReason: 'finished',
    };
  }
}

class CumulativeSessionRuntime extends SessionRuntime {
  private cumulative = 0;

  override async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    const output = await super.run(input);
    this.cumulative += 0.1;
    return {
      ...output,
      usage: { ...output.usage, usd: this.cumulative },
    };
  }
}

class FakeShell implements ShellRunner {
  calls: string[] = [];
  handler: (command: string) => ShellResult = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
  });

  async run(input: ShellInput): Promise<ShellResult> {
    this.calls.push(input.command);
    return this.handler(input.command);
  }
}

class FakePlanner implements Planner {
  constructor(
    private readonly spec: WorkflowSpec,
    private readonly store?: Store,
  ) {}
  async plan(task: { id: string }) {
    const boundId = this.store?.getSpecIdForTask(task.id);
    const bound = boundId ? this.store?.getSpec(boundId) : undefined;
    return { spec: bound ?? this.spec };
  }
}

function llmNode(id: string, over: Partial<LlmNode> = {}): LlmNode {
  return {
    id: N(id),
    type: 'llm',
    description: `${id} 节点`,
    inputs: [],
    outputs: [{ name: 'out', kind: 'text' }],
    tools: ['read_file'],
    ...over,
  };
}

function linearSpec(): WorkflowSpec {
  return {
    name: 'linear',
    version: 1,
    params: [],
    nodes: [
      llmNode('plan', {
        outputs: [{ name: 'plan', kind: 'text' }],
      }),
      {
        id: N('test'),
        type: 'shell',
        description: '跑测试',
        inputs: [{ name: 'plan', from: 'plan.plan' }],
        outputs: [],
        run: 'pnpm test',
      },
    ],
    edges: [{ from: N('plan'), to: N('test') }],
  };
}

function singleNode(node: NodeSpec): WorkflowSpec {
  return {
    name: 'single',
    version: 1,
    params: [],
    nodes: [node],
    edges: [],
  };
}

function harness(
  spec: WorkflowSpec,
  options: {
    isolateNodes?: boolean;
    executionMode?: 'node' | 'session';
    qaAgent?: string;
    runtime?: AgentRuntime;
    resolveSkills?: (ids: string[]) => Array<{ id: string; name: string; path: string }>;
    knowledgeContext?: (task: string) => string[];
    memoryContext?: (agentId: string, task: string) => string[];
    onNodeOutcome?: (outcome: MemoryNodeOutcome) => void;
    mcpServers?: Record<string, unknown>;
    maxConcurrentTasks?: number;
    maxUsdPerProject?: number;
    maxUsdPerDay?: number;
    agents?: AgentConfig[];
    providers?: Array<{ id: string }>;
    git?: GitService;
    repoPath?: string;
    worktreeRoot?: string;
    cleanupWorktrees?: boolean;
  } = {},
) {
  const store = new Store({ path: ':memory:', clock });
  const ids: IdFactory = createIdFactory({ clock, random: () => new Uint8Array(10) });
  const runtime = (options.runtime ?? new FakeRuntime()) as FakeRuntime;
  const shell = new FakeShell();
  const makeEngine = () =>
    new Engine({
      store,
      planner: new FakePlanner(spec, store),
      runtime,
      shell,
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake-model',
      workspaceRoot: process.cwd(),
      actor: { type: 'runtime', id: 'test' },
      maxTicks: 50,
      isolateNodes: options.isolateNodes,
      executionMode: options.executionMode,
      qaAgent: options.qaAgent,
      resolveSkills: options.resolveSkills,
      knowledgeContext: options.knowledgeContext,
      memoryContext: options.memoryContext,
      onNodeOutcome: options.onNodeOutcome,
      mcpServers: options.mcpServers,
      maxConcurrentTasks: options.maxConcurrentTasks,
      maxUsdPerProject: options.maxUsdPerProject,
      maxUsdPerDay: options.maxUsdPerDay,
      agents: options.agents,
      providers: options.providers,
      git: options.git,
      repoPath: options.repoPath,
      worktreeRoot: options.worktreeRoot,
      cleanupWorktrees: options.cleanupWorktrees,
    });

  const engine = makeEngine();
  engine.dispatch({
    type: 'task.create',
    taskId: T('task_01'),
    assignee: AG('pm'),
    caller: null,
    title: '做一个登录页',
    brief: '带校验',
  });

  return { store, ids, runtime, shell, engine, makeEngine };
}

function sessionChainSpec(): WorkflowSpec {
  return {
    name: 'session-chain',
    version: 1,
    params: [],
    nodes: [
      llmNode('a', { systemPrompt: '只做 A', instructions: '完成 A' }),
      llmNode('b', { systemPrompt: '只做 B', instructions: '完成 B' }),
      llmNode('c', { systemPrompt: '只做 C', instructions: '完成 C' }),
    ],
    edges: [
      { from: N('a'), to: N('b') },
      { from: N('b'), to: N('c') },
    ],
  };
}

function shellBridgedSessionSpec(): WorkflowSpec {
  return {
    name: 'shell-bridge',
    version: 1,
    params: [],
    nodes: [
      llmNode('a', { systemPrompt: '只做 A' }),
      {
        id: N('check'),
        type: 'shell',
        description: '确定性检查',
        inputs: [],
        outputs: [],
        run: 'echo ok',
      },
      llmNode('b', { systemPrompt: '只做 B' }),
    ],
    edges: [
      { from: N('a'), to: N('check') },
      { from: N('check'), to: N('b') },
    ],
  };
}

function qaSessionSpec(): WorkflowSpec {
  return {
    name: 'qa-session',
    version: 1,
    params: [],
    nodes: [
      llmNode('a', { systemPrompt: '实现 A' }),
      llmNode('review', {
        agent: 'qa' as AgentId,
        systemPrompt: '独立审查 A',
      }),
    ],
    edges: [{ from: N('a'), to: N('review') }],
  };
}

function branchingSessionSpec(): WorkflowSpec {
  return {
    name: 'branching',
    version: 1,
    params: [],
    nodes: [
      llmNode('a'),
      llmNode('b'),
      llmNode('c'),
    ],
    edges: [
      { from: N('a'), to: N('b') },
      { from: N('a'), to: N('c') },
    ],
  };
}

function budgetSpec(): WorkflowSpec {  return {
    name: 'budget',
    version: 1,
    params: [],
    nodes: [llmNode('first'), llmNode('second')],
    edges: [{ from: N('first'), to: N('second') }],
  };
}

describe('I2: engine + store', () => {
  it('把输出文件和完成标准作为节点指令传给实际 runtime', async () => {
    const spec = singleNode(
      llmNode('doc', {
        instructions:
          '写登录说明\n\n输出文件：docs/login.md\n\n完成标准：文件存在且包含验收步骤',
      }),
    );
    const { store, engine, runtime } = harness(spec);
    let capturedTask = '';
    runtime.run = async (input) => {
      capturedTask = input.task;
      return {
        outputs: [],
        text: 'done',
        transcriptRef: 'test',
        usage: { usd: 0 },
        stopReason: 'finished',
      };
    };

    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(capturedTask).toContain('输出文件：docs/login.md');
      expect(capturedTask).toContain('完成标准：文件存在且包含验收步骤');
    } finally {
      store.close();
    }
  });

  it('把项目 skills、MCP 和知识片段传给实际 runtime', async () => {
    const { store, engine, runtime } = harness(singleNode(llmNode('capability')), {
      resolveSkills: () => [{ id: 'game', name: 'game', path: '/tmp/game/SKILL.md' }],
      knowledgeContext: () => ['docs/game.md\n碰撞规则'],
      mcpServers: { assets: { command: 'node' } },
    });
    try {
      await engine.runUntilIdle();
      expect(runtime.calls[0]).toMatchObject({
        skills: [{ id: 'game', name: 'game', path: '/tmp/game/SKILL.md' }],
        mcpServers: { assets: { command: 'node' } },
      });
      expect(runtime.calls[0]!.systemPrompt).toContain('docs/game.md');
      expect(runtime.calls[0]!.systemPrompt).toContain('碰撞规则');
    } finally {
      store.close();
    }
  });

  it('线性 DAG 从头跑到尾', async () => {
    const { store, engine, runtime, shell } = harness(linearSpec());
    try {
      await engine.runUntilIdle();

      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      const runs = store.listRuns('task_01');
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('succeeded');
      expect(runtime.calls).toHaveLength(1);
      expect(shell.calls).toEqual(['pnpm test']);

      const nodes = store.listNodeRuns(runs[0]!.id);
      expect(nodes.map((n) => n.status)).toEqual(['succeeded', 'succeeded']);
      expect(nodes[0]?.outputs).toEqual([{ name: 'out', kind: 'text' }]);
      expect(nodes[0]?.costUsd).toBe(0.1);
    } finally {
      store.close();
    }
  });

  it('节点级 maxTurns 覆盖全局预算', async () => {
    const { store, engine, runtime } = harness(
      singleNode(llmNode('plan', { maxTurns: 30 })),
    );
    try {
      await engine.runUntilIdle();
      expect(runtime.calls[0]?.budget.maxTurns).toBe(30);
    } finally {
      store.close();
    }
  });

  it('把真实工具调用写入节点事件', async () => {
    const { store, engine, runtime } = harness(singleNode(llmNode('plan')));
    runtime.toolEvents = [
      {
        phase: 'call',
        toolUseId: 'tool_1',
        tool: 'Read',
        inputPreview: '{"file_path":"src/login.ts"}',
      },
      {
        phase: 'result',
        toolUseId: 'tool_1',
        tool: 'Read',
        ok: true,
        durationMs: 12,
        outputPreview: 'export const login = true;',
      },
      {
        phase: 'call',
        toolUseId: 'tool_2',
        tool: 'Bash',
      },
      {
        phase: 'result',
        toolUseId: 'tool_2',
        tool: 'Bash',
        ok: false,
        error: 'command failed',
      },
    ];
    try {
      await engine.runUntilIdle();
      const events = store.events
        .read({ taskId: T('task_01') })
        .filter((event) => event.type === 'tool.called' || event.type === 'tool.result');
      expect(events).toHaveLength(4);
      expect(events[0]).toMatchObject({
        type: 'tool.called',
        nodeRunId: expect.any(String),
        payload: {
          tool: 'Read',
          toolUseId: 'tool_1',
          inputPreview: '{"file_path":"src/login.ts"}',
        },
      });
      expect(events[1]).toMatchObject({
        type: 'tool.result',
        payload: {
          tool: 'Read',
          ok: true,
          durationMs: 12,
          outputPreview: 'export const login = true;',
        },
      });
      expect(events[2]).toMatchObject({
        type: 'tool.called',
        payload: { tool: 'Bash', toolUseId: 'tool_2' },
      });
      expect(events[3]).toMatchObject({
        type: 'tool.result',
        payload: {
          tool: 'Bash',
          ok: false,
          durationMs: 0,
          error: { code: 'E_TOOL_FAILED', message: 'command failed' },
        },
      });
    } finally {
      store.close();
    }
  });

  it('人工闸门：暂停、审批、继续', async () => {
    const spec = singleNode(llmNode('plan', { approval: { approvers: ['human'] } }));
    const { store, engine } = harness(spec);
    try {
      await engine.runUntilIdle();

      expect(store.getTask(T('task_01'))?.status).toBe('waiting_gate');
      const pending = store.listPendingGates();
      expect(pending).toHaveLength(1);
      expect(store.getRun(store.listRuns('task_01')[0]!.id)?.status).toBe('running');

      engine.dispatch({
        type: 'gate.decide',
        gateId: pending[0]!.id as GateId,
        action: 'approve',
        by: 'me',
      });
      await engine.runUntilIdle();

      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(store.inboxCount()).toBe(0);
      expect(store.getGate(pending[0]!.id)?.status).toBe('passed');
    } finally {
      store.close();
    }
  });

  it('批准后任务状态从 waiting_gate 回到 running', async () => {
    const spec: WorkflowSpec = {
      name: 'resume-status',
      version: 1,
      params: [],
      nodes: [
        llmNode('gate', { approval: { approvers: ['human'] } }),
        llmNode('slow'),
      ],
      edges: [{ from: N('gate'), to: N('slow') }],
    };
    const { store, engine, runtime } = harness(spec);
    let calls = 0;
    let release: (() => void) | undefined;
    runtime.run = async (): Promise<AgentRuntimeOutput> => {
      calls += 1;
      if (calls === 1) {
        return {
          outputs: [{ name: 'out', kind: 'text' }],
          transcriptRef: 'gate',
          usage: { usd: 0 },
          stopReason: 'finished',
        };
      }
      return new Promise((resolve) => {
        release = () =>
          resolve({
            outputs: [{ name: 'out', kind: 'text' }],
            transcriptRef: 'slow',
            usage: { usd: 0 },
            stopReason: 'finished',
          });
      });
    };

    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('waiting_gate');
      const gate = store.listPendingGates()[0]!;
      engine.dispatch({
        type: 'gate.decide',
        gateId: gate.id as GateId,
        action: 'approve',
        by: 'me',
      });

      const loop = engine.runUntilIdle();
      let status: string | undefined;
      for (let i = 0; i < 100; i += 1) {
        status = store.getTask(T('task_01'))?.status;
        if (status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(status).toBe('running');
      release?.();
      await loop;
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('失败后按 retries 重试，第二次成功', async () => {
    const spec = singleNode({
      id: N('test'),
      type: 'shell',
      description: '跑测试',
      inputs: [],
      outputs: [],
      run: 'flaky',
      retries: 1,
    });
    const { store, engine, shell } = harness(spec);
    shell.handler = () =>
      shell.calls.length === 1
        ? { exitCode: 1, stdout: '', stderr: 'first fail', durationMs: 1, timedOut: false }
        : { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };

    try {
      await engine.runUntilIdle();

      const run = store.listRuns('task_01')[0]!;
      const nodes = store.listNodeRuns(run.id);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.status).toBe('succeeded');
      expect(nodes[0]?.attempt).toBe(2);
      expect(shell.calls).toEqual(['flaky', 'flaky']);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('自动验证失败且没有重试 → 节点与任务都失败', async () => {
    const spec = singleNode(
      llmNode('plan', {
        verify: [{ kind: 'contract', run: 'pnpm tsc' }],
        retries: 0,
      }),
    );
    const { store, engine, shell } = harness(spec);
    shell.handler = (command) =>
      command === 'pnpm tsc'
        ? { exitCode: 1, stdout: '', stderr: 'type error', durationMs: 1, timedOut: false }
        : { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };

    try {
      await engine.runUntilIdle();

      const run = store.listRuns('task_01')[0]!;
      expect(store.listNodeRuns(run.id)[0]?.status).toBe('failed');
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
      expect(run.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('进程重启：recover 把 running 节点退回 ready 并继续', async () => {
    const spec = singleNode(llmNode('plan'));
    const first = harness(spec);
    try {
      // 手工推进到“节点执行到一半”
      first.store.saveSpec(specHash(spec), spec);
      first.engine.dispatch({
        type: 'run.start',
        runId: RUN('run_manual'),
        taskId: T('task_01'),
        specId: specHash(spec),
        params: {},
      });
      first.engine.dispatch({ type: 'task.claim', taskId: T('task_01'), leaseUntil: clock.iso() });
      first.engine.dispatch({
        type: 'node.ready',
        taskId: T('task_01'),
        runId: RUN('run_manual'),
        nodeRunId: R('nrun_manual'),
        nodeId: N('plan'),
      });
      first.engine.dispatch({
        type: 'node.start',
        taskId: T('task_01'),
        runId: RUN('run_manual'),
        nodeRunId: R('nrun_manual'),
        nodeId: N('plan'),
      });
      expect(first.store.getNodeRun('nrun_manual')?.status).toBe('running');

      // 新进程：同一个 store，新的 engine
      const second = new Engine({
        store: first.store,
        planner: new FakePlanner(spec),
        runtime: new FakeRuntime(),
        shell: new FakeShell(),
        clock,
        ids: first.ids,
        provider: { id: 'fake' },
        model: 'fake-model',
        workspaceRoot: process.cwd(),
        actor: { type: 'runtime', id: 'engine-2' },
      });

      expect(second.recover()).toBe(1);
      expect(first.store.getNodeRun('nrun_manual')?.status).toBe('ready');

      await second.runUntilIdle();
      expect(first.store.getNodeRun('nrun_manual')?.status).toBe('succeeded');
      expect(first.store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      first.store.close();
    }
  });

  it('两个节点里第二个失败，第一个保持成功', async () => {
    const spec: WorkflowSpec = {
      name: 'two',
      version: 1,
      params: [],
      nodes: [llmNode('a'), llmNode('b')],
      edges: [{ from: N('a'), to: N('b') }],
    };
    const { store, engine, runtime } = harness(spec);
    let calls = 0;
    runtime.run = async () => {
      calls += 1;
      if (calls === 2) {
        return {
          outputs: [],
          transcriptRef: 't',
          usage: { usd: 0.2 },
          stopReason: 'failed',
        };
      }
      return {
        outputs: [{ name: 'out', kind: 'text' }],
        transcriptRef: 't',
        usage: { usd: 0.1 },
        stopReason: 'finished',
      };
    };

    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const nodes = store.listNodeRuns(run.id);
      expect(nodes.map((n) => n.status)).toEqual(['succeeded', 'failed']);
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('上游失败时下游节点被跳过，任务失败', async () => {
    const spec: WorkflowSpec = {
      name: 'two',
      version: 1,
      params: [],
      nodes: [llmNode('a'), llmNode('b')],
      edges: [{ from: N('a'), to: N('b') }],
    };
    const { store, engine, runtime } = harness(spec);
    runtime.run = async () => ({
      outputs: [],
      transcriptRef: 't',
      usage: { usd: 0.1 },
      stopReason: 'failed',
    });

    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const byId = new Map(store.listNodeRuns(run.id).map((n) => [n.nodeId, n.status]));
      expect(byId.get('a')).toBe('failed');
      expect(byId.get('b')).toBe('skipped');
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('planner 抛错时任务直接失败', async () => {
    const { store, ids, runtime, shell } = harness(linearSpec());
    const engine = new Engine({
      store,
      planner: {
        plan: async () => {
          throw new Error('无法规划');
        },
      },
      runtime,
      shell,
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake-model',
      workspaceRoot: process.cwd(),
    });
    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
      expect(store.listRuns('task_01')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('subworkflow 找不到子流程时任务失败', async () => {
    const spec = singleNode({
      id: N('sub'),
      type: 'subworkflow',
      description: '嵌套流程',
      inputs: [],
      outputs: [],
      workflow: 'missing@v1',
      params: {},
    });
    const { store, engine } = harness(spec);
    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('delegate：创建子任务并等待其完成', async () => {
    const parentSpec: WorkflowSpec = {
      name: 'parent',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('delegate'),
          type: 'delegate',
          description: '交给前端',
          inputs: [],
          outputs: [],
          agent: AG('fe'),
          brief: '实现登录页',
        },
      ],
      edges: [],
    };
    const childSpec: WorkflowSpec = {
      name: 'child',
      version: 1,
      params: [],
      nodes: [llmNode('impl')],
      edges: [],
    };

    const store = new Store({ path: ':memory:', clock });
    const ids = createIdFactory({ clock, random: () => new Uint8Array(10) });
    const runtime = new FakeRuntime();
    const shell = new FakeShell();
    const engine = new Engine({
      store,
      planner: {
        plan: async (task) => ({
          spec: task.assignee === 'fe' ? childSpec : parentSpec,
        }),
      },
      runtime,
      shell,
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake-model',
      workspaceRoot: process.cwd(),
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_01'),
        assignee: AG('pm'),
        caller: null,
        title: '父任务',
        brief: '派给前端',
      });
      await engine.runUntilIdle();

      const children = store.listChildTasks('task_01');
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({
        assignee: 'fe',
        status: 'succeeded',
        parentId: 'task_01',
      });
      expect(children[0]?.originNodeRunId).toBeTruthy();
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');

      const parentRun = store.listRuns('task_01')[0]!;
      expect(store.listNodeRuns(parentRun.id)[0]?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('subworkflow：起一个子 run 并收口到父节点', async () => {
    const childSpec: WorkflowSpec = {
      name: 'child',
      version: 1,
      params: [],
      nodes: [llmNode('inner')],
      edges: [],
    };
    const parentSpec: WorkflowSpec = {
      name: 'parent',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('sub'),
          type: 'subworkflow',
          description: '嵌套子流程',
          inputs: [],
          outputs: [],
          workflow: 'child@v1',
          params: {},
        },
      ],
      edges: [],
    };

    const { store, engine } = harness(parentSpec);
    store.saveSpec(specHash(childSpec), childSpec);

    try {
      await engine.runUntilIdle();

      const runs = store.listRuns('task_01');
      expect(runs).toHaveLength(2);
      const childRun = runs.find((run) => run.parentRunId);
      expect(childRun?.status).toBe('succeeded');
      expect(childRun?.specId).toBe(specHash(childSpec));

      const parentRun = runs.find((run) => !run.parentRunId)!;
      expect(store.listNodeRuns(parentRun.id)[0]?.status).toBe('succeeded');
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('取消 subworkflow 节点会取消子 run', async () => {
    const childSpec: WorkflowSpec = {
      name: 'child-cancel',
      version: 1,
      params: [],
      nodes: [
        llmNode('prep'),
        llmNode('inner', { approval: { approvers: ['human'] } }),
      ],
      edges: [{ from: N('prep'), to: N('inner') }],
    };
    const parentSpec: WorkflowSpec = {
      name: 'parent-cancel',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('sub'),
          type: 'subworkflow',
          description: '嵌套子流程',
          inputs: [],
          outputs: [],
          workflow: 'child-cancel@v1',
          params: {},
        },
      ],
      edges: [],
    };
    const { store, engine } = harness(parentSpec);
    store.saveSpec(specHash(childSpec), childSpec);

    try {
      await engine.runUntilIdle();
      const parentRun = store.listRuns('task_01').find((run) => !run.parentRunId)!;
      const childRun = store.listRuns('task_01').find((run) => run.parentRunId)!;
      const parentNode = store.listNodeRuns(parentRun.id)[0]!;
      expect(store.getTask(T('task_01'))?.status).toBe('waiting_gate');

      await engine.cancelNode(T('task_01'), parentNode.id, '取消子流程');

      expect(store.getTask(T('task_01'))?.status).toBe('failed');
      expect(store.getRun(childRun.id)?.status).toBe('cancelled');
      const childNodes = store.listNodeRuns(childRun.id);
      expect(childNodes.find((node) => node.nodeId === 'prep')?.status).toBe(
        'succeeded',
      );
      expect(childNodes.find((node) => node.nodeId === 'inner')?.status).toBe(
        'cancelled',
      );
      expect(store.listNodeRuns(parentRun.id)[0]?.status).toBe('cancelled');
    } finally {
      store.close();
    }
  });

  it('子流程内部失败节点不能直接重试', async () => {
    const childSpec: WorkflowSpec = {
      name: 'child-fail',
      version: 1,
      params: [],
      nodes: [llmNode('inner')],
      edges: [],
    };
    const parentSpec: WorkflowSpec = {
      name: 'parent-fail',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('sub'),
          type: 'subworkflow',
          description: '嵌套子流程',
          inputs: [],
          outputs: [],
          workflow: 'child-fail@v1',
          params: {},
        },
      ],
      edges: [],
    };
    const { store, engine, runtime } = harness(parentSpec);
    store.saveSpec(specHash(childSpec), childSpec);
    runtime.run = async (): Promise<AgentRuntimeOutput> => ({
      outputs: [],
      transcriptRef: 'fail',
      usage: { usd: 0 },
      stopReason: 'failed',
      error: { code: 'E_X', message: 'inner failed' },
    });

    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
      const childRun = store.listRuns('task_01').find((run) => run.parentRunId)!;
      const childNode = store.listNodeRuns(childRun.id)[0]!;

      await expect(
        engine.retryNode(T('task_01'), childNode.id),
      ).rejects.toMatchObject({ code: 'E_NODE_RETRY_SUBRUN' });
    } finally {
      store.close();
    }
  });

  it('tick 次数用尽会显式报错，而不是静默卡住', async () => {
    const { store, ids, runtime, shell } = harness(linearSpec());
    const engine = new Engine({
      store,
      planner: new FakePlanner(linearSpec()),
      runtime,
      shell,
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake-model',
      workspaceRoot: process.cwd(),
      maxTicks: 1,
    });
    try {
      await expect(engine.runUntilIdle()).rejects.toMatchObject({ code: 'E_ENGINE_MAX_TICKS' });
    } finally {
      store.close();
    }
  });

  it('取消任务会走到 store 适配层的 childTasks', async () => {
    const { store, engine } = harness(linearSpec());
    try {
      engine.dispatch({ type: 'task.cancel', taskId: T('task_01'), reason: '不做了' });
      expect(store.getTask(T('task_01'))?.status).toBe('cancelled');
    } finally {
      store.close();
    }
  });

  it('shell 节点的时长单位与 pwsh 分支', async () => {
    const shellNode = (
      id: string,
      run: string,
      timeout: string,
      shell?: 'pwsh',
    ): NodeSpec => ({
      id: N(id),
      type: 'shell',
      description: id,
      inputs: [],
      outputs: [],
      run,
      timeout,
      ...(shell ? { shell } : {}),
    });

    const spec: WorkflowSpec = {
      name: 'shells',
      version: 1,
      params: [],
      nodes: [
        shellNode('s1', 'echo 1', '1s'),
        shellNode('s2', 'echo 2', '500ms'),
        shellNode('s3', 'echo 3', '2m', 'pwsh'),
        shellNode('s4', 'echo 4', '1h'),
      ],
      edges: [
        { from: N('s1'), to: N('s2') },
        { from: N('s2'), to: N('s3') },
        { from: N('s3'), to: N('s4') },
      ],
    };
    const { store, engine, shell } = harness(spec);
    try {
      await engine.runUntilIdle();
      expect(shell.calls).toHaveLength(4);
      expect(shell.calls[2]).toContain('pwsh');
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('两个任务会并行执行（worktree 隔离的前提）', async () => {
    const spec = singleNode(llmNode('plan'));
    const { store, engine, runtime } = harness(spec);

    let active = 0;
    let maxActive = 0;
    runtime.run = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return {
        outputs: [{ name: 'out', kind: 'text' }],
        transcriptRef: 't',
        usage: { usd: 0.1 },
        stopReason: 'finished',
      };
    };

    engine.dispatch({
      type: 'task.create',
      taskId: T('task_02'),
      assignee: AG('pm'),
      caller: null,
      title: '第二个任务',
      brief: '并发跑',
    });

    try {
      await engine.runUntilIdle();
      expect(maxActive).toBeGreaterThanOrEqual(2);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(store.getTask(T('task_02'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('人审打回后节点失败、任务失败', async () => {
    const spec = singleNode(llmNode('plan', { approval: { approvers: ['human'] } }));
    const { store, engine } = harness(spec);
    try {
      await engine.runUntilIdle();
      const gate = store.listPendingGates()[0]!;
      engine.dispatch({
        type: 'gate.decide',
        gateId: gate.id as GateId,
        action: 'reject',
        by: 'me',
        comment: '缺少移动端',
      });
      await engine.runUntilIdle();

      const run = store.listRuns('task_01')[0]!;
      expect(store.listNodeRuns(run.id)[0]?.status).toBe('failed');
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
      expect(store.getGate(gate.id)?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('超过单任务预算后不再启动新节点', async () => {
    const spec: WorkflowSpec = {
      name: 'budget',
      version: 1,
      params: [],
      nodes: [llmNode('a'), llmNode('b')],
      edges: [{ from: N('a'), to: N('b') }],
    };
    const { store, ids, runtime, shell } = harness(spec);
    let calls = 0;
    runtime.run = async () => {
      calls += 1;
      return {
        outputs: [],
        transcriptRef: 't',
        usage: { usd: 0.6 },
        stopReason: 'finished',
      };
    };

    const engine = new Engine({
      store,
      planner: new FakePlanner(spec),
      runtime,
      shell,
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: process.cwd(),
      maxUsdPerTask: 0.5,
    });

    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const nodes = store.listNodeRuns(run.id);
      const byId = new Map(nodes.map((node) => [node.nodeId, node.status]));
      expect(byId.get('a')).toBe('succeeded');
      expect(byId.get('b')).toBe('failed');
      expect(calls).toBe(1);
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('cleanupWorktrees 在没有 git 时安全跳过', async () => {
    const spec = singleNode(llmNode('nogit'));
    const { store, ids, runtime, shell } = harness(spec);

    const engine = new Engine({
      store,
      planner: new FakePlanner(spec),
      runtime,
      shell,
      clock,
      ids,
      provider: { id: 'fake' },
      model: 'fake',
      workspaceRoot: process.cwd(),
      cleanupWorktrees: true,
    });

    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('取消会中断正在执行的模型调用', async () => {
    const spec = singleNode(llmNode('slow'));
    const { store, engine, runtime } = harness(spec);

    let aborted = false;
    runtime.run = (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve({
              outputs: [],
              transcriptRef: '',
              usage: { usd: 0 },
              stopReason: 'aborted',
            });
          },
          { once: true },
        );
      });

    const running = engine.runUntilIdle();

    let nodeStatus: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const run = store.listRuns('task_01')[0];
      nodeStatus = run ? store.listNodeRuns(run.id)[0]?.status : undefined;
      if (nodeStatus === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(nodeStatus).toBe('running');

    engine.cancelTask(T('task_01'), '停止');
    await running;

    expect(aborted).toBe(true);
    expect(store.getTask(T('task_01'))?.status).toBe('cancelled');
    const run = store.listRuns('task_01')[0]!;
    expect(run.status).toBe('cancelled');
    expect(store.listNodeRuns(run.id)[0]?.status).toBe('cancelled');
  });

  it('取消单个节点会中断执行并让下游跳过', async () => {
    const spec: WorkflowSpec = {
      name: 'cancel-node',
      version: 1,
      params: [],
      nodes: [llmNode('a'), llmNode('b')],
      edges: [{ from: N('a'), to: N('b') }],
    };
    const { store, engine, runtime } = harness(spec);

    let aborted = false;
    runtime.run = (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve({
              outputs: [],
              transcriptRef: '',
              usage: { usd: 0 },
              stopReason: 'aborted',
            });
          },
          { once: true },
        );
      });

    const running = engine.runUntilIdle();
    let nodeA;
    for (let i = 0; i < 100; i += 1) {
      const run = store.listRuns('task_01')[0];
      nodeA = run
        ? store.listNodeRuns(run.id).find((node) => node.nodeId === 'a')
        : undefined;
      if (nodeA?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(nodeA?.status).toBe('running');

    await engine.cancelNode(T('task_01'), nodeA!.id, '停止这个节点');
    await running;

    expect(aborted).toBe(true);
    expect(store.getTask(T('task_01'))?.status).toBe('failed');
    const run = store.listRuns('task_01')[0]!;
    expect(store.listNodeRuns(run.id).find((node) => node.nodeId === 'a')?.status).toBe(
      'cancelled',
    );
    const b = store.listNodeRuns(run.id).find((node) => node.nodeId === 'b');
    expect(b?.status === 'skipped' || b?.status === 'cancelled').toBe(true);
  });

  it('失败任务可以重试失败节点并重跑下游', async () => {
    const spec: WorkflowSpec = {
      name: 'retry-node',
      version: 1,
      params: [],
      nodes: [llmNode('a'), llmNode('b')],
      edges: [{ from: N('a'), to: N('b') }],
    };
    const { store, engine, runtime } = harness(spec);

    let calls = 0;
    runtime.run = async (): Promise<AgentRuntimeOutput> => {
      calls += 1;
      if (calls === 1) {
        return {
          outputs: [],
          transcriptRef: 'failed',
          usage: { usd: 0.01 },
          stopReason: 'failed',
          error: { code: 'E_FAKE', message: '第一次失败' },
        };
      }
      return {
        outputs: [{ name: 'out', kind: 'text' }],
        transcriptRef: 'ok',
        usage: { usd: 0.01 },
        stopReason: 'finished',
      };
    };

    await engine.runUntilIdle();
    expect(store.getTask(T('task_01'))?.status).toBe('failed');
    const run = store.listRuns('task_01')[0]!;
    const a = store.listNodeRuns(run.id).find((node) => node.nodeId === 'a')!;
    const b = store.listNodeRuns(run.id).find((node) => node.nodeId === 'b')!;
    expect(a.status).toBe('failed');
    expect(b.status).toBe('skipped');

    await engine.retryNode(T('task_01'), a.id, '人工重试');

    expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    const after = store.listNodeRuns(run.id);
    expect(after.find((node) => node.nodeId === 'a')?.status).toBe('succeeded');
    expect(after.find((node) => node.nodeId === 'a')?.attempt).toBe(2);
    expect(after.find((node) => node.nodeId === 'b')?.status).toBe('succeeded');
    expect(calls).toBe(3);
  });

  it('节点恢复的参数守卫', async () => {
    const spec: WorkflowSpec = {
      name: 'guards',
      version: 1,
      params: [],
      nodes: [llmNode('a'), llmNode('b')],
      edges: [],
    };
    const { store, engine, runtime } = harness(spec);
    let runtimeCalls = 0;
    runtime.run = async (): Promise<AgentRuntimeOutput> => {
      runtimeCalls += 1;
      if (runtimeCalls === 1) {
        return {
          outputs: [],
          transcriptRef: 'fail',
          usage: { usd: 0 },
          stopReason: 'failed',
          error: { code: 'E_X', message: 'a failed' },
        };
      }
      return {
        outputs: [{ name: 'out', kind: 'text' }],
        transcriptRef: 'ok',
        usage: { usd: 0 },
        stopReason: 'finished',
      };
    };

    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
      const run = store.listRuns('task_01')[0]!;
      const nodes = store.listNodeRuns(run.id);
      const a = nodes.find((node) => node.nodeId === 'a')!;
      const b = nodes.find((node) => node.nodeId === 'b')!;
      expect(b.status).toBe('succeeded');

      await expect(engine.retryNode(T('missing'), 'x')).rejects.toMatchObject({
        code: 'E_TASK_NOT_FOUND',
      });
      await expect(engine.retryNode(T('task_01'), R('missing'))).rejects.toMatchObject({
        code: 'E_NODE_NOT_FOUND',
      });
      await expect(engine.retryNode(T('task_01'), b.id)).rejects.toMatchObject({
        code: 'E_NODE_NOT_FAILED',
      });
      await expect(engine.cancelNode(T('task_01'), a.id)).rejects.toMatchObject({
        code: 'E_TASK_TERMINAL',
      });
      await expect(engine.cancelNode(T('missing'), R('missing'))).rejects.toMatchObject({
        code: 'E_TASK_NOT_FOUND',
      });

      const originalSpecId = run.specId;
      store.db
        .prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?")
        .run(run.id);
      await expect(engine.retryNode(T('task_01'), a.id)).rejects.toMatchObject({
        code: 'E_RUN_NOT_FAILED',
      });
      store.db
        .prepare(
          "UPDATE workflow_runs SET status = 'failed', spec_id = 'missing-spec' WHERE id = ?",
        )
        .run(run.id);
      await expect(engine.retryNode(T('task_01'), a.id)).rejects.toMatchObject({
        code: 'E_SPEC_MISSING',
      });
      store.db
        .prepare(
          "UPDATE workflow_runs SET status = 'failed', spec_id = ? WHERE id = ?",
        )
        .run(originalSpecId, run.id);

      const pending = harness(spec);
      try {
        await expect(
          pending.engine.cancelNode(T('task_01'), R('missing')),
        ).rejects.toMatchObject({ code: 'E_NODE_NOT_FOUND' });
      } finally {
        pending.store.close();
      }

      await engine.retryNode(T('task_01'), a.id, '恢复');
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      await expect(engine.retryNode(T('task_01'), a.id)).rejects.toMatchObject({
        code: 'E_TASK_NOT_FAILED',
      });
    } finally {
      store.close();
    }
  });

  it('已成功的节点不能被取消', async () => {
    const spec: WorkflowSpec = {
      name: 'terminal-node',
      version: 1,
      params: [],
      nodes: [
        llmNode('a'),
        llmNode('b', { approval: { approvers: ['human'] } }),
      ],
      edges: [{ from: N('a'), to: N('b') }],
    };
    const { store, engine } = harness(spec);
    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('waiting_gate');
      const run = store.listRuns('task_01')[0]!;
      const a = store
        .listNodeRuns(run.id)
        .find((node) => node.nodeId === 'a')!;
      expect(a.status).toBe('succeeded');

      await expect(engine.cancelNode(T('task_01'), a.id)).rejects.toMatchObject({
        code: 'E_NODE_TERMINAL',
      });
    } finally {
      store.close();
    }
  });

  it('shell 审批闸门不会被隔离成子任务', async () => {
    const spec = singleNode({
      id: N('gate'),
      type: 'shell',
      description: '等待审批',
      inputs: [],
      outputs: [],
      approval: { approvers: ['human'] },
      run: 'echo ok',
    });
    const { store, engine, shell } = harness(spec, { isolateNodes: true });
    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('waiting_gate');
      expect(store.listChildTasks('task_01')).toEqual([]);
      const run = store.listRuns('task_01')[0]!;
      expect(store.listNodeRuns(run.id)[0]?.status).toBe('waiting_gate');
      expect(shell.calls).toEqual(['echo ok']);
    } finally {
      store.close();
    }
  });

  it('shutdown 会中断执行并把 running 状态留给 recover', async () => {
    const spec = singleNode(llmNode('slow'));
    const { store, engine, runtime } = harness(spec);

    let aborted = false;
    runtime.run = (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve({
              outputs: [],
              transcriptRef: '',
              usage: { usd: 0 },
              stopReason: 'aborted',
            });
          },
          { once: true },
        );
      });

    try {
      const running = engine.runUntilIdle();
      let nodeStatus: string | undefined;
      for (let i = 0; i < 100; i += 1) {
        const run = store.listRuns('task_01')[0];
        nodeStatus = run ? store.listNodeRuns(run.id)[0]?.status : undefined;
        if (nodeStatus === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(nodeStatus).toBe('running');

      engine.shutdown();
      await running;

      expect(aborted).toBe(true);
      expect(store.getTask(T('task_01'))?.status).toBe('running');
      const run = store.listRuns('task_01')[0]!;
      expect(run.status).toBe('running');
      expect(store.listNodeRuns(run.id)[0]?.status).toBe('running');
    } finally {
      store.close();
    }
  });

  it('取消任务会级联取消 run / node / gate', async () => {
    const spec = singleNode(llmNode('plan', { approval: { approvers: ['human'] } }));
    const { store, engine } = harness(spec);
    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('waiting_gate');
      expect(store.inboxCount()).toBe(1);

      engine.cancelTask(T('task_01'), '用户取消');

      expect(store.getTask(T('task_01'))?.status).toBe('cancelled');
      const run = store.listRuns('task_01')[0]!;
      expect(run.status).toBe('cancelled');
      expect(store.listNodeRuns(run.id)[0]?.status).toBe('cancelled');
      expect(store.inboxCount()).toBe(0);
      expect(store.listPendingGates()).toEqual([]);

      expect(() => engine.cancelTask(T('missing'), 'x')).toThrow();
      expect(() => engine.cancelTask(T('task_01'), 'again')).toThrow();
    } finally {
      store.close();
    }
  });

  it('max_turns 会让节点失败而不是当成完成', async () => {
    const spec = singleNode(llmNode('turns'));
    const { store, engine, runtime } = harness(spec);
    runtime.run = async () => ({
      outputs: [],
      transcriptRef: 't',
      usage: { usd: 0.1 },
      stopReason: 'max_turns',
    });

    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      expect(store.listNodeRuns(run.id)[0]?.status).toBe('failed');
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('doneCriteria judge 失败会阻断节点', async () => {
    const spec = singleNode(
      llmNode('doc', {
        verify: [{
          kind: 'judge',
          rubric: '交付物必须包含可执行验收步骤',
          threshold: 0.8,
          advisory: false,
        }],
      }),
    );
    const { store, engine, runtime } = harness(spec);
    runtime.run = async (input) => ({
      outputs: [],
      text: input.systemPrompt.includes('交付物验证器')
        ? '{"pass":false,"score":0.2,"reason":"缺少验收步骤"}'
        : 'done',
      transcriptRef: 't',
      usage: { usd: 0 },
      stopReason: 'finished',
    });
    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const node = store.listNodeRuns(run.id)[0]!;
      expect(node.status).toBe('failed');
      expect(node.error).toMatchObject({ code: 'E_VERIFY_JUDGE' });
      expect(store.getTask(T('task_01'))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('condition 按退出码裁剪分支，未选中的分支不会执行', async () => {
    const spec: WorkflowSpec = {
      name: 'condition',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('check'),
          type: 'condition',
          description: '检查条件',
          inputs: [],
          outputs: [],
          run: 'check',
          autoCommit: false,
          branches: { whenTrue: [N('yes')], whenFalse: [N('no')] },
        },
        llmNode('yes'),
        llmNode('no'),
      ],
      edges: [
        { from: N('check'), to: N('yes') },
        { from: N('check'), to: N('no') },
      ],
    };
    const { store, engine, runtime, shell } = harness(spec);
    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const nodes = store.listNodeRuns(run.id);
      expect(nodes.find((node) => node.nodeId === 'yes')?.status).toBe('succeeded');
      expect(nodes.find((node) => node.nodeId === 'no')?.status).toBe('skipped');
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(runtime.calls.map((call) => call.task)).toHaveLength(1);
      expect(shell.calls).toEqual(['check']);
    } finally {
      store.close();
    }
  });

  it('loop 重复执行命令直到成功，并记录真实迭代次数', async () => {
    const spec = singleNode({
      id: N('loop'),
      type: 'loop',
      description: '直到测试通过',
      inputs: [],
      outputs: [],
      run: 'flaky-loop',
      maxIterations: 4,
      intervalMs: 1,
      autoCommit: false,
    });
    const { store, engine, shell } = harness(spec);
    shell.handler = () => ({
      exitCode: shell.calls.length < 3 ? 1 : 0,
      stdout: '',
      stderr: 'retry',
      durationMs: 1,
      timedOut: false,
    });
    try {
      await engine.runUntilIdle();
      expect(shell.calls).toEqual(['flaky-loop', 'flaky-loop', 'flaky-loop']);
      const run = store.listRuns('task_01')[0]!;
      const node = store.listNodeRuns(run.id)[0]!;
      expect(node.status).toBe('succeeded');
      expect((node.outputs?.[0] as { data?: { iterations?: number } })?.data?.iterations).toBe(3);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('fanout 按 JSON 清单创建并执行多个子任务', async () => {
    const spec = singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '并行处理清单',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-items.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      maxConcurrency: 2,
      autoCommit: false,
    });
    const { store, engine, shell } = harness(spec);
    try {
      await engine.runUntilIdle();
      const children = store.listChildTasks('task_01');
      expect(children).toHaveLength(2);
      expect(children.map((child) => child.status)).toEqual(['succeeded', 'succeeded']);
      expect(shell.calls).toEqual(
        expect.arrayContaining(['process alpha', 'process beta']),
      );
      const run = store.listRuns('task_01')[0]!;
      const node = store.listNodeRuns(run.id).find((row) => row.nodeId === 'fanout')!;
      expect(node.status).toBe('succeeded');
      expect(((node.outputs ?? []) as Array<{ schema?: string }>).some((output) => output.schema === 'hive/fanout')).toBe(true);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('项目累计预算和日预算都会阻断新节点', async () => {
    const project = harness(budgetSpec(), { maxUsdPerProject: 0.05 });
    try {
      await project.engine.runUntilIdle();
      const run = project.store.listRuns('task_01')[0]!;
      expect(project.store.listNodeRuns(run.id).map((node) => node.error)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'E_PROJECT_BUDGET_EXCEEDED' })]),
      );
    } finally {
      project.store.close();
    }

    const daily = harness(budgetSpec(), { maxUsdPerDay: 0.05 });
    try {
      await daily.engine.runUntilIdle();
      const run = daily.store.listRuns('task_01')[0]!;
      expect(daily.store.listNodeRuns(run.id).map((node) => node.error)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'E_DAY_BUDGET_EXCEEDED' })]),
      );
    } finally {
      daily.store.close();
    }
  });

  it('maxConcurrentTasks 只让第二个 root task 排队，不阻塞子任务语义', async () => {
    const { store, engine, runtime } = harness(singleNode(llmNode('scheduled')), {
      maxConcurrentTasks: 1,
    });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    runtime.run = async () => {
      calls += 1;
      if (calls === 1) await blocker;
      return {
        outputs: [],
        text: 'done',
        transcriptRef: 't',
        usage: { usd: 0 },
        stopReason: 'finished',
      };
    };
    engine.dispatch({
      type: 'task.create',
      taskId: T('task_02'),
      assignee: AG('pm'),
      caller: null,
      title: '第二个任务',
      brief: '第二个任务',
    });
    const running = engine.runUntilIdle();
    for (let index = 0; index < 100 && calls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(calls).toBe(1);
    expect(store.getTask(T('task_02'))?.status).toBe('pending');
    release();
    await running;
    expect(store.getTask(T('task_02'))?.status).toBe('succeeded');
    store.close();
  });

  it('失败节点重试时携带上次 transcript 的 resumeSessionId', async () => {
    const { store, engine, runtime } = harness(singleNode(llmNode('resume')));
    const inputs: AgentRuntimeInput[] = [];
    let calls = 0;
    runtime.run = async (input) => {
      inputs.push(input);
      calls += 1;
      return {
        outputs: [],
        text: calls === 1 ? 'failed' : 'done',
        transcriptRef: 'sdk://session-resume',
        usage: { usd: 0 },
        stopReason: calls === 1 ? 'failed' : 'finished',
      };
    };
    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      const node = store.listNodeRuns(run.id)[0]!;
      expect(node.status).toBe('failed');
      await engine.retryNode('task_01', node.id);
      expect(inputs[1]?.resumeSessionId).toBe('session-resume');
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('loop 达到上限会失败；condition false 会跳过 true 分支', async () => {
    const loop = harness(singleNode({
      id: N('loop'),
      type: 'loop',
      description: '耗尽',
      inputs: [],
      outputs: [],
      run: 'always-fail',
      maxIterations: 2,
      autoCommit: false,
    }));
    loop.shell.handler = () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'still failing',
      durationMs: 1,
      timedOut: false,
    });
    try {
      await loop.engine.runUntilIdle();
      const run = loop.store.listRuns('task_01')[0]!;
      expect(loop.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_LOOP_EXHAUSTED',
      });
      expect(loop.shell.calls).toHaveLength(2);
    } finally {
      loop.store.close();
    }

    const condition = harness(singleNode({
      id: N('condition'),
      type: 'condition',
      description: 'false 条件',
      inputs: [],
      outputs: [],
      run: 'false',
      branches: { whenTrue: [], whenFalse: [] },
      autoCommit: false,
    }));
    condition.shell.handler = () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    });
    try {
      await condition.engine.runUntilIdle();
      const run = condition.store.listRuns('task_01')[0]!;
      const output = condition.store.listNodeRuns(run.id)[0]?.outputs?.[0] as {
        data?: { value?: boolean };
      };
      expect(output.data?.value).toBe(false);
    } finally {
      condition.store.close();
    }
  });

  it('fanout 输入错误和子任务失败都会阻断节点', async () => {
    const invalid = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '错误清单',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/missing-fanout.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }));
    try {
      await invalid.engine.runUntilIdle();
      const run = invalid.store.listRuns('task_01')[0]!;
      expect(invalid.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_FANOUT_INPUT',
      });
    } finally {
      invalid.store.close();
    }

    const failed = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '失败子任务',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-items.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }));
    failed.shell.handler = (command) => ({
      exitCode: command.includes('beta') ? 1 : 0,
      stdout: '',
      stderr: 'failed',
      durationMs: 1,
      timedOut: false,
    });
    try {
      await failed.engine.runUntilIdle();
      const run = failed.store.listRuns('task_01')[0]!;
      expect(failed.store.listNodeRuns(run.id).find((node) => node.nodeId === 'fanout')?.error).toMatchObject({
        code: 'E_FANOUT_FAILED',
      });
    } finally {
      failed.store.close();
    }
  });

  it('judge 非 JSON 会失败，advisory judge 只记录不阻断', async () => {
    const strict = harness(singleNode(llmNode('judge', {
      verify: [{ kind: 'judge', rubric: '验收', advisory: false }],
    })));
    strict.runtime.run = async () => ({
      outputs: [],
      text: 'not-json',
      transcriptRef: 't',
      usage: { usd: 0 },
      stopReason: 'finished',
    });
    try {
      await strict.engine.runUntilIdle();
      const run = strict.store.listRuns('task_01')[0]!;
      expect(strict.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_VERIFY_JUDGE',
      });
    } finally {
      strict.store.close();
    }

    const advisory = harness(singleNode(llmNode('judge', {
      verify: [{ kind: 'judge', rubric: '验收', advisory: true }],
    })));
    advisory.runtime.run = async () => ({
      outputs: [],
      text: 'not-json',
      transcriptRef: 't',
      usage: { usd: 0 },
      stopReason: 'finished',
    });
    try {
      await advisory.engine.runUntilIdle();
      expect(advisory.store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      advisory.store.close();
    }
  });

  it('required artifact 缺失会让节点失败', async () => {
    const { store, engine } = harness(singleNode(llmNode('artifact', {
      outputs: [{ name: 'required', kind: 'file', path: 'missing-artifact.txt', required: true }],
    })));
    try {
      await engine.runUntilIdle();
      const run = store.listRuns('task_01')[0]!;
      expect(store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_ARTIFACT_MISSING',
      });
    } finally {
      store.close();
    }
  });

  it('agent provider 路由生效，越权工具会被拒绝', async () => {
    const pm: AgentConfig = {
      id: 'pm' as never,
      name: 'PM',
      parent: null,
      role: '执行',
      model: { provider: 'vision', model: 'inherit' },
      skills: [],
      tools: { allow: ['Read'] },
      workspace: { writeScope: ['.'] },
    };
    const routed = harness(singleNode(llmNode('route', { tools: [] })), {
      agents: [pm],
      providers: [{ id: 'default' }, { id: 'vision' }],
    });
    try {
      await routed.engine.runUntilIdle();
      const run = routed.store.listRuns('task_01')[0]!;
      expect(routed.store.listNodeRuns(run.id)[0]?.error).toBeNull();
      expect(routed.store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(routed.runtime.calls[0]?.provider.id).toBe('vision');
    } finally {
      routed.store.close();
    }

    const denied = harness(singleNode(llmNode('denied', { tools: ['Write'] })), {
      agents: [pm],
    });
    try {
      await denied.engine.runUntilIdle();
      const run = denied.store.listRuns('task_01')[0]!;
      expect(denied.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_AGENT_TOOL_DENIED',
      });
    } finally {
      denied.store.close();
    }
  });

  it('fanout 合并子任务分支，并清理 worktree', async () => {
    const merges: string[] = [];
    const removed: string[] = [];
    const git = {
      async createWorktree(input: { branch: string; worktree: string }) {
        return { path: process.cwd(), branch: input.branch, baseCommit: 'base' };
      },
      async head() { return 'base'; },
      async commit() { return { commit: 'abc', files: 0, insertions: 0, deletions: 0 }; },
      async merge(input: { branch: string }) {
        merges.push(input.branch);
        return { commit: 'merge', alreadyUpToDate: false };
      },
      async removeWorktree(input: { worktree: string }) { removed.push(input.worktree); },
    } as unknown as GitService;
    const spec = singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '合并清单',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-items.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    });
    const { store, engine } = harness(spec, {
      git,
      repoPath: process.cwd(),
      worktreeRoot: process.cwd(),
      cleanupWorktrees: true,
    });
    try {
      await engine.runUntilIdle();
      expect(merges).toHaveLength(2);
      expect(removed.length).toBeGreaterThan(0);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });

  it('拒绝未知 agent，并覆盖 judge 非法/低分/执行失败', async () => {
    const pm: AgentConfig = {
      id: 'pm' as never,
      name: 'PM',
      parent: null,
      role: '执行',
      model: { provider: 'inherit', model: 'inherit' },
      skills: [],
      tools: { allow: ['Read'] },
      workspace: { writeScope: ['.'] },
    };
    const unknown = harness(singleNode(llmNode('unknown', {
      agent: 'missing' as never,
      tools: [],
    })), { agents: [pm] });
    try {
      await unknown.engine.runUntilIdle();
      const run = unknown.store.listRuns('task_01')[0]!;
      expect(unknown.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_AGENT_NOT_FOUND',
      });
    } finally {
      unknown.store.close();
    }

    for (const judgeText of ['failed-stop', '{bad', '{"score":1}', '{"pass":false,"score":0.1}']) {
      const judged = harness(singleNode(llmNode('judge', {
        verify: [{ kind: 'judge', rubric: '验收', advisory: false }],
      })));
      judged.runtime.run = async (input) => ({
        outputs: [],
        text: input.systemPrompt.includes('交付物验证器') && judgeText !== 'failed-stop' ? judgeText : 'done',
        transcriptRef: 't',
        usage: { usd: 0 },
        stopReason: input.systemPrompt.includes('交付物验证器') && judgeText === 'failed-stop' ? 'failed' : 'finished',
      });
      try {
        await judged.engine.runUntilIdle();
        const run = judged.store.listRuns('task_01')[0]!;
        expect(judged.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
          code: 'E_VERIFY_JUDGE',
        });
      } finally {
        judged.store.close();
      }
    }
  });

  it('fanout 拒绝非数组清单，并传播合并失败', async () => {
    const invalid = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '非数组',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-object.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }));
    try {
      await invalid.engine.runUntilIdle();
      const run = invalid.store.listRuns('task_01')[0]!;
      expect(invalid.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_FANOUT_INPUT',
      });
    } finally {
      invalid.store.close();
    }

    const git = {
      async createWorktree(input: { branch: string; worktree: string }) {
        return { path: process.cwd(), branch: input.branch, baseCommit: 'base' };
      },
      async head() { return 'base'; },
      async commit() { return { commit: 'abc', files: 0, insertions: 0, deletions: 0 }; },
      async merge() { throw new Error('merge failed'); },
    } as unknown as GitService;
    const failed = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '合并失败',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-items.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }), { git, repoPath: process.cwd(), worktreeRoot: process.cwd() });
    try {
      await failed.engine.runUntilIdle();
      const run = failed.store.listRuns('task_01')[0]!;
      expect(failed.store.listNodeRuns(run.id).find((node) => node.nodeId === 'fanout')?.status).toBe('failed');
    } finally {
      failed.store.close();
    }
  });

  it('复用已有 worktree，终态取消和重复 shutdown 有明确边界', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'hive-worktree-reuse-'));
    const existing = join(root, 'task_01');
    mkdirSync(existing, { recursive: true });
    let created = 0;
    const git = {
      async createWorktree() { created += 1; throw new Error('should not create'); },
      async head() { return 'base'; },
    } as unknown as GitService;
    const { store, engine } = harness(singleNode({
      id: N('reuse'),
      type: 'shell',
      description: '复用',
      inputs: [],
      outputs: [],
      run: 'echo reuse',
      autoCommit: false,
    }), { git, repoPath: root, worktreeRoot: root });
    try {
      await engine.runUntilIdle();
      expect(created).toBe(0);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(() => engine.cancelTask(T('task_01'), 'too late')).toThrowError(/已结束/);
      engine.shutdown();
      engine.shutdown();
    } finally {
      store.close();
      const { rmSync } = await import('node:fs');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('condition 缺失布尔输出会显式报错，失败条件会跳过分支', async () => {
    const spec: WorkflowSpec = {
      name: 'condition-guard',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('check'),
          type: 'condition',
          description: '条件',
          inputs: [],
          outputs: [],
          run: 'check',
          branches: { whenTrue: [N('yes')], whenFalse: [N('no')] },
          autoCommit: false,
        },
        llmNode('yes'),
        llmNode('no'),
      ],
      edges: [],
    };
    const { store, engine } = harness(spec);
    try {
      await engine.runUntilIdle();
      const task = store.getTask(T('task_01'))!;
      const run = store.listRuns(task.id)[0]!;
      const condition = store.listNodeRuns(run.id).find((node) => node.nodeId === 'check')!;
      store.db.prepare('UPDATE node_runs SET outputs = ? WHERE id = ?').run(
        JSON.stringify([{ schema: 'hive/condition', data: {} }]),
        condition.id,
      );
      const internal = engine as any;
      expect(() => internal.conditionBranchStatus(task, run, spec, N('yes'))).toThrowError(/布尔/);
      store.db.prepare("UPDATE node_runs SET status = 'failed' WHERE id = ?").run(condition.id);
      expect(internal.conditionBranchStatus(task, run, spec, N('yes'))).toBe('skip');
    } finally {
      store.close();
    }
  });

  it('fanout 支持对象字段模板、空清单和越界清单拒绝', async () => {
    const objectItems = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '对象清单',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-objects.json',
      run: 'process {{item.name}}',
      brief: '处理 {{item.name}}',
      autoCommit: false,
    }));
    try {
      await objectItems.engine.runUntilIdle();
      expect(objectItems.shell.calls).toEqual(['process alpha']);
      expect(objectItems.store.listChildTasks('task_01')[0]?.title).toContain('对象任务');
    } finally {
      objectItems.store.close();
    }

    const empty = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '空清单',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-empty.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }));
    try {
      await empty.engine.runUntilIdle();
      expect(empty.store.listChildTasks('task_01')).toEqual([]);
      expect(empty.store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      empty.store.close();
    }

    const outside = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '越界清单',
      inputs: [],
      outputs: [],
      itemsPath: '../outside.json',
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }));
    try {
      await outside.engine.runUntilIdle();
      const run = outside.store.listRuns('task_01')[0]!;
      expect(outside.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_FANOUT_INPUT',
      });
    } finally {
      outside.store.close();
    }
  });

  it('loop 延迟可被取消，fanout 限制 1000 项并支持非字符串字段', async () => {
    const delayed = harness(singleNode({
      id: N('loop'),
      type: 'loop',
      description: '可取消的延迟',
      inputs: [],
      outputs: [],
      run: 'always-fail',
      maxIterations: 3,
      intervalMs: 1000,
      autoCommit: false,
    }));
    delayed.shell.handler = () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'retry',
      durationMs: 1,
      timedOut: false,
    });
    try {
      const running = delayed.engine.runUntilIdle();
      delayed.engine.shutdown();
      await running;
      expect(delayed.store.getTask(T('task_01'))?.status).toBe('running');
    } finally {
      delayed.store.close();
    }

    const scalar = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '标量字段',
      inputs: [],
      outputs: [],
      itemsPath: 'tests/fixtures/fanout-scalar.json',
      run: 'process {{item.count}}',
      brief: '处理 {{item.count}}',
      autoCommit: false,
    }));
    try {
      await scalar.engine.runUntilIdle();
      expect(scalar.shell.calls).toEqual(['process 1']);
    } finally {
      scalar.store.close();
    }

    const { writeFileSync, rmSync } = await import('node:fs');
    const path = '.tmp-fanout-large.json';
    writeFileSync(path, JSON.stringify(Array.from({ length: 1001 }, (_, index) => index)));
    const large = harness(singleNode({
      id: N('fanout'),
      type: 'fanout',
      description: '超大清单',
      inputs: [],
      outputs: [],
      itemsPath: path,
      run: 'process {{item}}',
      brief: '处理 {{item}}',
      autoCommit: false,
    }));
    try {
      await large.engine.runUntilIdle();
      const run = large.store.listRuns('task_01')[0]!;
      expect(large.store.listNodeRuns(run.id)[0]?.error).toMatchObject({
        code: 'E_FANOUT_INPUT',
      });
    } finally {
      large.store.close();
      rmSync(path, { force: true });
    }
  });

  it('session 模式复用线性链的 SDK session，node 模式每节点新建', async () => {
    const nodeRuntime = new SessionRuntime();
    const nodeHarness = harness(sessionChainSpec(), {
      runtime: nodeRuntime,
      executionMode: 'node',
    });
    try {
      await nodeHarness.engine.runUntilIdle();
      expect(nodeRuntime.calls).toHaveLength(3);
      expect(nodeRuntime.calls.every((call) => call.resumeSessionId === undefined)).toBe(true);
      expect(new Set(nodeRuntime.calls.map((call) => call.systemPrompt)).size).toBe(3);
      expect(nodeRuntime.created).toBe(3);
    } finally {
      nodeHarness.store.close();
    }

    const sessionRuntime = new SessionRuntime();
    const sessionHarness = harness(sessionChainSpec(), {
      runtime: sessionRuntime,
      executionMode: 'session',
      isolateNodes: true,
    });
    try {
      await sessionHarness.engine.runUntilIdle();
      expect(sessionRuntime.calls).toHaveLength(3);
      expect(sessionRuntime.calls.map((call) => call.resumeSessionId)).toEqual([
        undefined,
        'session-1',
        'session-1',
      ]);
      expect(new Set(sessionRuntime.calls.map((call) => call.systemPrompt)).size).toBe(1);
      expect(sessionRuntime.calls[1]?.task).toContain('只做 B');
      expect(sessionRuntime.created).toBe(1);
      const cacheRead = sessionRuntime.calls.reduce(
        (total, call) => total + (call.resumeSessionId ? 900 : 0),
        0,
      );
      expect(cacheRead).toBe(1800);
    } finally {
      sessionHarness.store.close();
    }
  });

  it('session 模式把 SDK 累计成本归一化为节点增量', async () => {
    const runtime = new CumulativeSessionRuntime();
    const { engine, store } = harness(sessionChainSpec(), {
      runtime,
      executionMode: 'session',
    });
    try {
      await engine.runUntilIdle();
      const events = store.events
        .read({ taskId: T('task_01') })
        .filter((event) => event.type === 'node.verifying') as Array<{
        payload: { usage?: { usd?: number } };
      }>;
      const usages = events.map((event) => event.payload.usage?.usd);
      expect(usages).toHaveLength(3);
      for (const usage of usages) expect(usage).toBeCloseTo(0.1);
    } finally {
      store.close();
    }
  });

  it('节点 outcome 回调异常不影响节点成功，且无文本时回退产物摘要', async () => {
    const outcomes: MemoryNodeOutcome[] = [];
    const { engine, store } = harness(sessionChainSpec(), {
      executionMode: 'session',
      runtime: new SilentRuntime(),
      onNodeOutcome: (outcome) => {
        outcomes.push(outcome);
        throw new Error('memory outbox offline');
      },
    });
    try {
      await engine.runUntilIdle();
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(outcomes).toHaveLength(3);
      expect(outcomes[0]?.summary).toContain('out:');
    } finally {
      store.close();
    }
  });

  it('session 刷新只注入新增记忆，不重复旧记忆', async () => {
    const runtime = new SessionRuntime();
    let memoryCalls = 0;
    let engineRef: ReturnType<typeof harness>['engine'] | undefined;
    const { engine, store } = harness(sessionChainSpec(), {
      executionMode: 'session',
      runtime,
      memoryContext: () => {
        memoryCalls += 1;
        return memoryCalls === 1 ? ['旧约束 A'] : ['旧约束 A', '新约束 B'];
      },
      onNodeOutcome: (outcome) => {
        if (outcome.nodeId === 'a') void engineRef?.requestMemoryRefresh(T('task_01'));
      },
    });
    engineRef = engine;
    try {
      await engine.runUntilIdle();
      expect(memoryCalls).toBe(2);
      expect(runtime.calls[0]?.task).toContain('旧约束 A');
      expect(runtime.calls[1]?.task).toContain('新约束 B');
      expect(runtime.calls[1]?.task).not.toContain('旧约束 A');
      expect(runtime.calls[2]?.task).not.toContain('新约束 B');
      const nodes = store.listNodeRuns(store.listRuns(T('task_01'))[0]!.id);
      expect(nodes.find((node) => node.nodeId === 'b')?.sessionMemoryKeys).toEqual([
        '旧约束 A',
        '新约束 B',
      ]);
    } finally {
      store.close();
    }
  });

  it('node 模式不支持刷新 session 记忆', async () => {
    const { engine, store } = harness(linearSpec(), { executionMode: 'node' });
    try {
      await expect(engine.requestMemoryRefresh(T('task_01'))).rejects.toMatchObject({
        code: 'E_MEMORY_REFRESH_UNSUPPORTED',
      });
    } finally {
      store.close();
    }
  });

  it('node 模式每个 LLM 节点都检索记忆', async () => {
    const runtime = new FakeRuntime();
    let memoryCalls = 0;
    const { engine, store } = harness(linearSpec(), {
      executionMode: 'node',
      runtime,
      memoryContext: () => {
        memoryCalls += 1;
        return ['节点记忆'];
      },
    });
    try {
      await engine.runUntilIdle();
      expect(memoryCalls).toBe(runtime.calls.length);
    } finally {
      store.close();
    }
  });

  it('fork 分支不再重复检索 session 记忆', async () => {
    const runtime = new SessionRuntime();
    let memoryCalls = 0;
    const { engine, store } = harness(branchingSessionSpec(), {
      executionMode: 'session',
      runtime,
      memoryContext: () => {
        memoryCalls += 1;
        return ['共享 session 记忆'];
      },
    });
    try {
      await engine.runUntilIdle();
      expect(runtime.calls).toHaveLength(3);
      expect(memoryCalls).toBe(1);
      expect(runtime.calls[1]?.task).not.toContain('共享 session 记忆');
      expect(runtime.calls[2]?.task).not.toContain('共享 session 记忆');
    } finally {
      store.close();
    }
  });

  it('session 模式把记忆/知识放进消息并回调节点 outcome', async () => {
    const runtime = new SessionRuntime();
    const outcomes: MemoryNodeOutcome[] = [];
    let memoryCalls = 0;
    const { engine, store } = harness(sessionChainSpec(), {
      executionMode: 'session',
      runtime,
      memoryContext: () => {
        memoryCalls += 1;
        return ['记住 A 的约束'];
      },
      knowledgeContext: () => ['项目知识 B'],
      onNodeOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      await engine.runUntilIdle();
      expect(outcomes).toHaveLength(3);
      expect(outcomes[0]).toMatchObject({
        taskId: T('task_01'),
        nodeId: 'a',
        status: 'succeeded',
        summary: 'done',
      });
      expect(memoryCalls).toBe(1);
      expect(runtime.calls[0]?.systemPrompt).not.toContain('记住 A 的约束');
      expect(runtime.calls[0]?.task).toContain('记住 A 的约束');
      expect(runtime.calls[0]?.task).toContain('项目知识 B');
      expect(runtime.calls[1]?.task).not.toContain('记住 A 的约束');
    } finally {
      store.close();
    }
  });

  it('engine 重建后从 SQLite 恢复 session 链', async () => {
    const runtime = new SessionRuntime();
    const { store, engine, makeEngine } = harness(sessionChainSpec(), {
      runtime,
      executionMode: 'session',
    });
    try {
      await engine.runUntilIdle();
      const run = store.listRuns(T('task_01'))[0]!;
      const nodes = store.listNodeRuns(run.id);
      const nodeA = nodes.find((node) => node.nodeId === 'a')!;
      expect(nodeA.sessionKey).toBeTruthy();
      expect(nodeA.transcriptRef).toBe('sdk://session-1');

      const second = makeEngine();
      const spec = store.getSpec(run.specId)!;
      const nodeB = nodes.find((node) => node.nodeId === 'b')!;
      const source = (
        second as unknown as {
          findSessionSource: (
            run: { id: string; specId: string },
            specNode: (typeof spec.nodes)[number],
            node: typeof nodeB,
          ) => { transcriptRef: string; sessionKey: string } | undefined;
        }
      ).findSessionSource(run, spec.nodes[1]!, { ...nodeB, transcriptRef: null });
      expect(source?.transcriptRef).toBe('sdk://session-1');
      expect(source?.sessionKey).toBe(nodeA.sessionKey);
    } finally {
      store.close();
    }
  });

  it('没有 checkpoint 时恢复会明确报错', async () => {
    const { engine, store } = harness(sessionChainSpec(), {
      executionMode: 'session',
    });
    try {
      await engine.runUntilIdle();
      const run = store.listRuns(T('task_01'))[0]!;
      const node = store.listNodeRuns(run.id)[0]!;
      await expect(
        engine.restoreNodeCheckpoint('task_01', node.id, 'before'),
      ).rejects.toMatchObject({ code: 'E_CHECKPOINT_NOT_FOUND' });
      store.setNodeCheckpoint(node.id, 'before', 'refs/test/checkpoint');
      await expect(
        engine.restoreNodeCheckpoint('task_01', node.id, 'before'),
      ).rejects.toMatchObject({ code: 'E_CHECKPOINT_NO_WORKTREE' });
    } finally {
      store.close();
    }
  });

  it('配置 qaAgent 时自动追加独立 QA 节点', async () => {
    const runtime = new SessionRuntime();
    const agents: AgentConfig[] = [
      {
        id: AG('pm'), name: 'PM', parent: null, role: 'PM',
        model: { provider: 'inherit', model: 'inherit' },
        skills: [], tools: { allow: ['read_file'] },
      },
      {
        id: AG('qa'), name: 'QA', parent: AG('pm'), role: 'QA',
        model: { provider: 'inherit', model: 'inherit' },
        skills: [], tools: { allow: ['read_file'] },
      },
    ];
    const { engine, store } = harness(sessionChainSpec(), {
      executionMode: 'session',
      qaAgent: 'qa',
      runtime,
      agents,
    });
    try {
      await engine.runUntilIdle();
      const run = store.listRuns(T('task_01'))[0]!;
      const spec = store.getSpec(run.specId)!;
      expect(spec.nodes.some((node) => node.id === 'qa_review')).toBe(true);
      expect(spec.edges).toContainEqual({ from: N('c'), to: N('qa_review') });
      expect(store.listChildTasks(T('task_01'))).toHaveLength(1);
      expect(store.getTask(T('task_01'))?.status).toBe('succeeded');
      expect(runtime.calls).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it('session 模式下独立 QA agent 使用隔离子任务/session', async () => {
    const runtime = new SessionRuntime();
    const agents: AgentConfig[] = [
      {
        id: AG('pm'),
        name: 'PM',
        parent: null,
        role: 'PM',
        model: { provider: 'inherit', model: 'inherit' },
        skills: [],
        tools: { allow: ['read_file'] },
      },
      {
        id: AG('qa'),
        name: 'QA',
        parent: AG('pm'),
        role: 'QA',
        model: { provider: 'inherit', model: 'inherit' },
        skills: [],
        tools: { allow: ['read_file'] },
      },
    ];
    const { engine, store } = harness(qaSessionSpec(), {
      executionMode: 'session',
      runtime,
      agents,
    });
    try {
      await engine.runUntilIdle();
      const children = store.listChildTasks(T('task_01'));
      expect(children).toHaveLength(1);
      expect(children[0]?.assignee).toBe('qa');
      expect(children[0]?.status).toBe('succeeded');
      expect(runtime.calls).toHaveLength(2);
      expect(runtime.created).toBe(2);
    } finally {
      store.close();
    }
  });

  it('session 模式在分支处 fork，确定性节点处切断复用', async () => {
    const branchRuntime = new SessionRuntime();
    const branch = harness(branchingSessionSpec(), {
      runtime: branchRuntime,
      executionMode: 'session',
    });
    try {
      await branch.engine.runUntilIdle();
      expect(branchRuntime.calls).toHaveLength(3);
      expect(branchRuntime.calls.map((call) => call.resumeSessionId)).toEqual([
        undefined,
        'session-1',
        'session-1',
      ]);
      expect(branchRuntime.calls.map((call) => call.forkSession ?? false)).toEqual([
        false,
        true,
        true,
      ]);
      expect(branchRuntime.created).toBe(3);
    } finally {
      branch.store.close();
    }

    const shellRuntime = new SessionRuntime();
    const bridged = harness(shellBridgedSessionSpec(), {
      runtime: shellRuntime,
      executionMode: 'session',
      isolateNodes: true,
    });
    try {
      await bridged.engine.runUntilIdle();
      expect(shellRuntime.calls).toHaveLength(2);
      expect(shellRuntime.calls.every((call) => call.resumeSessionId === undefined)).toBe(true);
      expect(bridged.shell.calls).toEqual(['echo ok']);
      expect(bridged.store.getTask(T('task_01'))?.status).toBe('succeeded');
    } finally {
      bridged.store.close();
    }
  });
});

