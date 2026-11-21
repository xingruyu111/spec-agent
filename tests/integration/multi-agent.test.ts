/**
 * 多 agent 编排：pm → fe/be 两个子任务，FE 人审，批准后父任务收口。
 *
 * 不调用真实模型；真实版本见 scripts/demo-multi-agent.ts。
 */

import { describe, expect, it } from 'vitest';
import type { AgentId, NodeId, WorkflowSpec } from '@spec-agent/schema';
import type { AgentRuntime } from '@spec-agent/core';
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

class CountingRuntime implements AgentRuntime {
  readonly id = 'counting';
  active = 0;
  maxActive = 0;

  async run() {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    return {
      outputs: [{ name: 'out', kind: 'text' as const }],
      transcriptRef: 't',
      usage: { usd: 0.01 },
      stopReason: 'finished' as const,
    };
  }
}

function llmNode(id: string, over: Record<string, unknown> = {}) {
  return {
    id: N(id),
    type: 'llm' as const,
    description: id,
    inputs: [],
    outputs: [{ name: 'out', kind: 'text' as const }],
    tools: ['Write', 'Read'],
    ...over,
  };
}

const parentSpec: WorkflowSpec = {
  name: 'pm',
  version: 1,
  params: [],
  nodes: [
    {
      id: N('fe'),
      type: 'delegate',
      description: '前端',
      inputs: [],
      outputs: [],
      agent: AG('fe'),
      brief: '写前端',
    },
    {
      id: N('be'),
      type: 'delegate',
      description: '后端',
      inputs: [],
      outputs: [],
      agent: AG('be'),
      brief: '写后端',
    },
  ],
  edges: [],
};

const feSpec: WorkflowSpec = {
  name: 'fe',
  version: 1,
  params: [],
  nodes: [llmNode('implement', { approval: { approvers: ['human'] } }) as never],
  edges: [],
};

const beSpec: WorkflowSpec = {
  name: 'be',
  version: 1,
  params: [],
  nodes: [llmNode('implement') as never],
  edges: [],
};

describe('多 agent：delegate + 人审 + 并行', () => {
  it('两个子任务并行，FE 暂停，批准后父任务收口', async () => {
    const store = new Store({ path: ':memory:', clock });
    const runtime = new CountingRuntime();
    const engine = new Engine({
      store,
      planner: {
        plan: async (task) => ({
          spec:
            task.assignee === 'fe'
              ? feSpec
              : task.assignee === 'be'
                ? beSpec
                : parentSpec,
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
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_pm'),
        assignee: AG('pm'),
        caller: null,
        title: '登录功能',
        brief: '',
      });

      await engine.runUntilIdle();

      expect(store.getTask('task_pm')?.status).toBe('running');
      const children = store.listChildTasks('task_pm');
      expect(children).toHaveLength(2);
      expect(children.find((task) => task.assignee === 'fe')?.status).toBe('waiting_gate');
      expect(children.find((task) => task.assignee === 'be')?.status).toBe('succeeded');
      expect(runtime.maxActive).toBeGreaterThanOrEqual(2);

      const gate = store.listPendingGates()[0]!;
      engine.dispatch({
        type: 'gate.decide',
        gateId: gate.id as never,
        action: 'approve',
        by: 'me',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_pm')?.status).toBe('succeeded');
      for (const child of store.listChildTasks('task_pm')) {
        expect(child.status).toBe('succeeded');
      }
      expect(store.inboxCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('子任务失败后重新委派，第二次成功', async () => {
    const store = new Store({ path: ':memory:', clock });
    let calls = 0;

    const runtime: AgentRuntime = {
      id: 'flaky',
      async run() {
        calls += 1;
        if (calls === 1) {
          return {
            outputs: [],
            transcriptRef: '',
            usage: { usd: 0 },
            stopReason: 'failed',
            error: { code: 'E_AGENT_FAILED', message: '第一次故意失败' },
          };
        }
        return {
          outputs: [{ name: 'out', kind: 'text' as const }],
          transcriptRef: 't',
          usage: { usd: 0.01 },
          stopReason: 'finished' as const,
        };
      },
    };

    const delegateSpec: WorkflowSpec = {
      name: 'pm-one',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('fe'),
          type: 'delegate',
          description: '前端',
          inputs: [],
          outputs: [],
          agent: AG('fe'),
          brief: '写前端',
          retries: 1,
        },
      ],
      edges: [],
    };
    const childSpec: WorkflowSpec = {
      name: 'fe',
      version: 1,
      params: [],
      nodes: [llmNode('implement') as never],
      edges: [],
    };

    const engine = new Engine({
      store,
      planner: {
        plan: async (task) => ({
          spec: task.assignee === 'fe' ? childSpec : delegateSpec,
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
    });

    try {
      engine.dispatch({
        type: 'task.create',
        taskId: T('task_pm'),
        assignee: AG('pm'),
        caller: null,
        title: '重试委派',
        brief: '',
      });
      await engine.runUntilIdle();

      expect(store.getTask('task_pm')?.status).toBe('succeeded');
      const children = store.listChildTasks('task_pm');
      expect(children).toHaveLength(2);
      expect(children.map((task) => task.status).sort()).toEqual([
        'failed',
        'succeeded',
      ]);
    } finally {
      store.close();
    }
  });
});
