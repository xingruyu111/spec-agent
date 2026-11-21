import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import { planWorkflow, planWorkflowWithUsage, PLAN_GATE_ID } from './planner.js';

function runtimeWith(text: string, stopReason: 'finished' | 'failed' = 'finished'): AgentRuntime {
  return {
    id: 'fake-planner',
    async run() {
      return {
        outputs: [],
        text,
        transcriptRef: 't',
        usage: { usd: 0.01 },
        stopReason,
      };
    },
  };
}

const options = (text: string, stopReason: 'finished' | 'failed' = 'finished') => ({
  goal: '做一个登录页',
  agentRuntime: runtimeWith(text, stopReason),
  provider: { id: 'fake' },
  model: 'fake',
});

const agents: AgentConfig[] = [
  {
    id: 'pm' as never,
    name: 'PM',
    parent: null,
    role: 'PM',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read'] },
    workspace: { writeScope: ['.'] },
    canDelegateTo: ['fe' as never],
  },
  {
    id: 'fe' as never,
    name: 'FE',
    parent: 'pm' as never,
    role: '前端',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read', 'Write'] },
    workspace: { writeScope: ['frontend/'] },
  },
  {
    id: 'be' as never,
    name: 'BE',
    parent: 'pm' as never,
    role: '后端',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read', 'Write'] },
    workspace: { writeScope: ['backend/'] },
  },
];

const hierarchicalAgents: AgentConfig[] = agents.map((agent) => {
  if (agent.id === ('pm' as never)) {
    return {
      ...agent,
      canDelegateTo: ['fe' as never, 'be' as never],
      nodes: [
        {
          id: 'requirements',
          name: '制作需求文档',
          description: '根据目标制作需求文档',
        },
      ],
    };
  }
  if (agent.id === ('fe' as never)) {
    return {
      ...agent,
      nodes: [
        { id: 'plan', name: '制定前端计划', description: '制定前端计划' },
        { id: 'code', name: '前端编码', description: '实现前端' },
      ],
    };
  }
  return {
    ...agent,
    nodes: [
      { id: 'plan', name: '制定后端计划', description: '制定后端计划' },
      { id: 'code', name: '后端编码', description: '实现后端' },
    ],
  };
});

function hierarchicalRuntime(
  parentPlan: unknown,
): { runtime: AgentRuntime; calls: string[] } {
  const calls: string[] = [];
  const runtime: AgentRuntime = {
    id: 'hierarchical-fake',
    async run(input) {
      calls.push(input.systemPrompt);
      const text = input.systemPrompt.includes('id: pm')
        ? JSON.stringify(parentPlan)
        : JSON.stringify({
            nodes: [
              { kind: 'local', id: 'plan' },
              { kind: 'local', id: 'code' },
            ],
            edges: [['plan', 'code']],
          });
      return {
        outputs: [],
        text,
        transcriptRef: 't',
        usage: { usd: 0.01 },
        stopReason: 'finished',
      };
    },
  };
  return { runtime, calls };
}

describe('planWorkflow hierarchy', () => {
  it('父层不选下属时只规划当前 agent', async () => {
    const { runtime, calls } = hierarchicalRuntime({
      nodes: [{ kind: 'local', id: 'requirements' }],
      edges: [],
    });
    const result = await planWorkflowWithUsage({
      goal: '写需求文档',
      agentRuntime: runtime,
      provider: { id: 'fake' },
      model: 'fake',
      agents: hierarchicalAgents,
      defaultAgent: 'pm',
    });
    expect(calls).toHaveLength(1);
    expect(result.spec.nodes.map((node) => node.id)).toEqual([
      PLAN_GATE_ID,
      'pm-requirements',
    ]);
  });

  it('节点库模板保留 shell/verify/subworkflow/condition/loop/fanout 类型和参数', async () => {
    const parent = {
      ...hierarchicalAgents[0]!,
      canDelegateTo: [],
      nodes: [
        { id: 'shell', name: '命令', description: '执行命令', type: 'shell' as const, run: 'pnpm build' },
        { id: 'verify', name: '验证', description: '验证交付', type: 'verify' as const, run: 'pnpm test', outputPath: 'artifacts/report.json' },
        { id: 'sub', name: '子流程', description: '调用子流程', type: 'subworkflow' as const, workflow: 'quality@v1' },
        { id: 'cond', name: '条件', description: '按结果分支', type: 'condition' as const, run: 'pnpm check', branches: { whenTrue: ['shell' as never], whenFalse: ['verify' as never] } },
        { id: 'loop', name: '循环', description: '直到通过', type: 'loop' as const, run: 'pnpm test', maxIterations: 5 },
        { id: 'fan', name: '并行', description: '清单并行', type: 'fanout' as const, itemsPath: 'items.json', run: 'process {{item}}' },
      ],
    };
    const { runtime } = hierarchicalRuntime({
      nodes: ['shell', 'verify', 'sub', 'cond', 'loop', 'fan'].map((id) => ({ kind: 'local', id })),
      edges: [],
    });
    const result = await planWorkflowWithUsage({
      goal: '组装执行节点',
      agentRuntime: runtime,
      provider: { id: 'fake' },
      model: 'fake',
      agents: [parent],
      defaultAgent: 'pm',
    });
    expect(result.spec.nodes.slice(1).map((node) => node.type)).toEqual([
      'shell',
      'verify',
      'subworkflow',
      'condition',
      'loop',
      'fanout',
    ]);
    const sub = result.spec.nodes.find((node) => node.id === 'pm-sub');
    expect(sub).toMatchObject({ type: 'subworkflow', workflow: 'quality@v1' });
    const condition = result.spec.nodes.find((node) => node.id === 'pm-cond');
    expect(condition).toMatchObject({
      type: 'condition',
      branches: { whenTrue: ['pm-shell'], whenFalse: ['pm-verify'] },
    });
    const verify = result.spec.nodes.find((node) => node.id === 'pm-verify');
    expect(verify?.outputs[0]).toMatchObject({
      path: 'artifacts/report.json',
      required: true,
    });
  });

  it('执行型目标首版只剩分析节点时，会强制重规划并委派执行下属', async () => {
    let calls = 0;
    const runtime: AgentRuntime = {
      id: 'retry-planner',
      async run(input) {
        calls += 1;
        if (input.systemPrompt.includes('强制规划要求')) {
          return {
            outputs: [],
            text: JSON.stringify({
              nodes: [
                { kind: 'local', id: 'requirements' },
                {
                  kind: 'delegate',
                  id: 'fe-work',
                  agent: 'fe',
                  brief: '实现失物招领网站前端',
                  deliverable: '页面与前端代码',
                },
              ],
              edges: [['requirements', 'fe-work']],
            }),
            transcriptRef: 't',
            usage: { usd: 0.01 },
            stopReason: 'finished',
          };
        }
        if (input.systemPrompt.includes('id: fe')) {
          return {
            outputs: [],
            text: JSON.stringify({
              nodes: [
                { kind: 'local', id: 'plan' },
                { kind: 'local', id: 'code' },
              ],
              edges: [['plan', 'code']],
            }),
            transcriptRef: 't',
            usage: { usd: 0.01 },
            stopReason: 'finished',
          };
        }
        return {
          outputs: [],
          text: JSON.stringify({
            delivery: 'execution',
            nodes: [{ kind: 'local', id: 'requirements' }],
            edges: [],
          }),
          transcriptRef: 't',
          usage: { usd: 0.01 },
          stopReason: 'finished',
        };
      },
    };
    const result = await planWorkflowWithUsage({
      goal: '开发一个贪吃蛇游戏，需要实际可运行产物',
      agentRuntime: runtime,
      provider: { id: 'fake' },
      model: 'fake',
      agents: hierarchicalAgents,
      defaultAgent: 'pm',
    });
    expect(calls).toBe(3);
    expect(result.spec.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['fe-plan', 'fe-code']),
    );
    expect(result.usage?.usd).toBeCloseTo(0.03);
  });

  it('只递归展开父层选中的直接下属', async () => {
    const { runtime, calls } = hierarchicalRuntime({
      nodes: [
        { kind: 'local', id: 'requirements' },
        {
          kind: 'delegate',
          id: 'fe-work',
          agent: 'fe',
          brief: '实现前端',
          deliverable: '页面代码',
        },
      ],
      edges: [['requirements', 'fe-work']],
    });
    const result = await planWorkflowWithUsage({
      goal: '实现登录页',
      agentRuntime: runtime,
      provider: { id: 'fake' },
      model: 'fake',
      agents: hierarchicalAgents,
      defaultAgent: 'pm',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('id: fe');
    expect(calls.some((prompt) => prompt.includes('id: be'))).toBe(false);
    expect(result.spec.nodes.map((node) => node.id)).toEqual([
      PLAN_GATE_ID,
      'pm-requirements',
      'fe-plan',
      'fe-code',
    ]);
    expect(result.spec.edges).toEqual(
      expect.arrayContaining([
        { from: PLAN_GATE_ID, to: 'pm-requirements' },
        { from: 'pm-requirements', to: 'fe-plan' },
        { from: 'fe-plan', to: 'fe-code' },
      ]),
    );
    expect(
      (
        result.spec.nodes.find((node) => node.id === 'fe-plan') as
          | { instructions?: string }
          | undefined
      )?.instructions,
    ).toContain('本次委派');
    expect(result.usage?.usd).toBeCloseTo(0.02);
  });

  it('父层选中两个下属时展开两条分支', async () => {
    const { runtime, calls } = hierarchicalRuntime({
      nodes: [
        { kind: 'local', id: 'requirements' },
        {
          kind: 'delegate',
          id: 'fe-work',
          agent: 'fe',
          brief: '实现前端',
          deliverable: '页面代码',
        },
        {
          kind: 'delegate',
          id: 'be-work',
          agent: 'be',
          brief: '实现后端',
          deliverable: '接口代码',
        },
      ],
      edges: [
        ['requirements', 'fe-work'],
        ['requirements', 'be-work'],
      ],
    });
    const result = await planWorkflowWithUsage({
      goal: '实现登录页',
      agentRuntime: runtime,
      provider: { id: 'fake' },
      model: 'fake',
      agents: hierarchicalAgents,
      defaultAgent: 'pm',
    });
    expect(calls).toHaveLength(3);
    expect(result.spec.nodes.map((node) => node.id)).toEqual([
      PLAN_GATE_ID,
      'pm-requirements',
      'fe-plan',
      'fe-code',
      'be-plan',
      'be-code',
    ]);
    expect(result.spec.edges).toEqual(
      expect.arrayContaining([
        { from: 'pm-requirements', to: 'fe-plan' },
        { from: 'pm-requirements', to: 'be-plan' },
      ]),
    );
  });

  it('子层不能委派给非直接下属', async () => {
    const badAgents = hierarchicalAgents.map((agent) =>
      agent.id === ('fe' as never)
        ? {
            ...agent,
            nodes: [
              { id: 'plan', name: '制定前端计划', description: '制定前端计划' },
            ],
          }
        : agent,
    );
    const badRuntime: AgentRuntime = {
      id: 'bad',
      async run(input) {
        return {
          outputs: [],
          text: input.systemPrompt.includes('id: fe')
            ? JSON.stringify({
                nodes: [
                  {
                    kind: 'delegate',
                    id: 'be-work',
                    agent: 'be',
                    brief: '越级',
                    deliverable: '越级',
                  },
                ],
                edges: [],
              })
            : JSON.stringify({
                nodes: [
                  {
                    kind: 'delegate',
                    id: 'fe-work',
                    agent: 'fe',
                    brief: '实现前端',
                    deliverable: '页面代码',
                  },
                ],
                edges: [],
              }),
          transcriptRef: 't',
          usage: { usd: 0 },
          stopReason: 'finished',
        };
      },
    };
    await expect(
      planWorkflowWithUsage({
        goal: '实现登录页',
        agentRuntime: badRuntime,
        provider: { id: 'fake' },
        model: 'fake',
        agents: badAgents,
        defaultAgent: 'pm',
      }),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });
});

describe('planWorkflow', () => {
  it('把目标解析成 llm 节点，并加上确认闸门', async () => {
    const spec = await planWorkflow(
      options(
        JSON.stringify({
          name: 'login',
          nodes: [
            { id: 'design', description: '设计登录页', instructions: '写出页面结构' },
            { id: 'implement', description: '实现登录页', instructions: '创建 login.html' },
          ],
          edges: [['design', 'implement']],
        }),
      ),
    );

    expect(spec.nodes).toHaveLength(3);
    expect(spec.nodes[0]).toMatchObject({
      id: PLAN_GATE_ID,
      type: 'shell',
      approval: { approvers: ['human'] },
    });
    expect(spec.nodes.slice(1).every((node) => node.type === 'llm')).toBe(true);
    expect(spec.edges).toEqual(
      expect.arrayContaining([
        { from: PLAN_GATE_ID, to: 'design' },
        { from: 'design', to: 'implement' },
      ]),
    );
  });

  it('兼容 fenced JSON', async () => {
    const spec = await planWorkflow(
      options('```json\n{"nodes":[{"id":"a","description":"做 A"}]}\n```'),
    );
    expect(spec.nodes).toHaveLength(2);
  });

  it('只允许组装预配置节点，不能创建新节点', async () => {
    const configured = agents.map((agent) =>
      agent.id === 'pm'
        ? {
            ...agent,
            nodes: [
              {
                id: 'design',
                name: '需求拆解',
                description: '拆解登录需求',
                instructions: '输出页面和接口契约',
                approval: true,
                maxTurns: 30,
                outputPath: 'docs/login-contract.md',
                doneCriteria: '文件存在且包含接口契约',
              },
            ],
          }
        : agent,
    );
    const spec = await planWorkflow({
      ...options(
        JSON.stringify({
          nodes: [{ id: 'pm-design', description: '不允许覆盖', instructions: '不允许覆盖' }],
          edges: [],
        }),
      ),
      agents: configured,
      defaultAgent: 'pm',
    });
    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes[1]).toMatchObject({
      id: 'pm-design',
      type: 'llm',
      agent: 'pm',
      description: '需求拆解',
      instructions:
        '拆解登录需求\n\n输出页面和接口契约\n\n输出文件：docs/login-contract.md\n\n完成标准：文件存在且包含接口契约',
      approval: { approvers: ['human'] },
      maxTurns: 30,
    });

    await expect(
      planWorkflow({
        ...options(JSON.stringify({ nodes: [{ id: 'made-up' }], edges: [] })),
        agents: configured,
        defaultAgent: 'pm',
      }),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('节点可选字段缺省时只注入职责', async () => {
    const configured = agents.map((agent) =>
      agent.id === 'pm'
        ? {
            ...agent,
            nodes: [
              {
                id: 'basic',
                name: '基础节点',
                description: '做基础工作',
              },
            ],
          }
        : agent,
    );
    const spec = await planWorkflow({
      ...options(JSON.stringify({ nodes: [{ id: 'pm-basic' }], edges: [] })),
      agents: configured,
      defaultAgent: 'pm',
    });
    expect(spec.nodes[1]).toMatchObject({
      id: 'pm-basic',
      description: '基础节点',
      instructions: '做基础工作',
    });
    expect((spec.nodes[1] as { maxTurns?: number }).maxTurns).toBeUndefined();
  });

  it('非法 JSON 直接拒绝', async () => {
    await expect(planWorkflow(options('我觉得应该先这样'))).rejects.toMatchObject({
      code: 'E_PLAN_INVALID',
    });
  });

  it('环会被拒绝', async () => {
    await expect(
      planWorkflow(
        options(
          JSON.stringify({
            nodes: [
              { id: 'a', description: 'A' },
              { id: 'b', description: 'B' },
            ],
            edges: [
              ['a', 'b'],
              ['b', 'a'],
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('节点过多会被拒绝', async () => {
    const nodes = Array.from({ length: 17 }, (_, index) => ({
      id: `n${index}`,
      description: `节点 ${index}`,
    }));
    await expect(
      planWorkflow({ ...options(JSON.stringify({ nodes })), maxNodes: 16 }),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('支持 10 个节点和并行分支，并返回规划成本', async () => {
    const nodes = Array.from({ length: 10 }, (_, index) => ({
      id: `n${index}`,
      description: `节点 ${index}`,
      instructions: `完成 ${index}`,
    }));
    const plan = await planWorkflowWithUsage(
      options(
        JSON.stringify({
          nodes,
          edges: [
            ['n0', 'n1'],
            ['n0', 'n2'],
            ['n1', 'n3'],
            ['n2', 'n4'],
          ],
        }),
      ),
    );

    expect(plan.spec.nodes).toHaveLength(11);
    expect(plan.usage?.usd).toBe(0.01);
    expect(plan.spec.edges).toEqual(
      expect.arrayContaining([
        { from: 'n0', to: 'n1' },
        { from: 'n0', to: 'n2' },
      ]),
    );
  });

  it('maxNodes 可以收紧', async () => {
    const nodes = Array.from({ length: 3 }, (_, index) => ({
      id: `n${index}`,
      description: `节点 ${index}`,
    }));
    await expect(
      planWorkflow({ ...options(JSON.stringify({ nodes })), maxNodes: 2 }),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('引用不存在的节点会被拒绝', async () => {
    await expect(
      planWorkflow(
        options(
          JSON.stringify({
            nodes: [{ id: 'a', description: 'A' }],
            edges: [['a', 'missing']],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('把仓库绝对路径替换成相对路径', async () => {
    const cwd = process.cwd();
    const spec = await planWorkflow({
      ...options(
        JSON.stringify({
          nodes: [
            {
              id: 'a',
              description: 'A',
              instructions: `在 ${cwd}/server/auth.js 里实现登录`,
            },
          ],
        }),
      ),
      cwd,
    });
    const node = spec.nodes.find((candidate) => candidate.id === 'a');
    expect(node?.type).toBe('llm');
    if (node?.type === 'llm') {
      expect(node.instructions).toContain('./server/auth.js');
      expect(node.instructions).not.toContain(cwd);
    }
  });

  it('其他盘符的绝对路径会被拒绝', async () => {
    await expect(
      planWorkflow(
        options(
          JSON.stringify({
            nodes: [
              { id: 'a', description: 'A', instructions: '写到 D:\\secret\\x.txt' },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('按组织把节点分配给 agent，并继承策略', async () => {
    const spec = await planWorkflow({
      ...options(
        JSON.stringify({
          nodes: [
            {
              id: 'design',
              description: '设计',
              instructions: '写结构',
              agent: 'fe',
            },
            {
              id: 'api',
              description: '接口',
              instructions: '写接口',
              agent: 'be',
            },
          ],
        }),
      ),
      agents,
      defaultAgent: 'pm',
    });

    const nodes = spec.nodes.filter((node) => node.type === 'llm');
    expect(nodes.map((node) => node.agent)).toEqual(['fe', 'be']);
    expect(nodes[0]?.tools).toEqual([]);
  });

  it('未指定 agent 时回落到任务 owner', async () => {
    const spec = await planWorkflow({
      ...options(
        JSON.stringify({
          nodes: [{ id: 'work', description: '做事', instructions: '做事' }],
        }),
      ),
      agents,
      defaultAgent: 'pm',
    });
    const node = spec.nodes.find((candidate) => candidate.id === 'work');
    expect(node?.type === 'llm' ? node.agent : undefined).toBe('pm');
  });

  it('不存在的 agent 会被拒绝', async () => {
    await expect(
      planWorkflow({
        ...options(
          JSON.stringify({
            nodes: [{ id: 'work', description: '做事', agent: 'ghost' }],
          }),
        ),
        agents,
        defaultAgent: 'pm',
      }),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('不能把节点分配给同级 agent', async () => {
    await expect(
      planWorkflow({
        ...options(
          JSON.stringify({
            nodes: [{ id: 'work', description: '做事', agent: 'be' }],
          }),
        ),
        agents,
        defaultAgent: 'fe',
      }),
    ).rejects.toMatchObject({ code: 'E_PLAN_INVALID' });
  });

  it('规划器失败时抛 E_PLAN_FAILED', async () => {
    await expect(
      planWorkflow(options('{}', 'failed')),
    ).rejects.toMatchObject({ code: 'E_PLAN_FAILED' });
  });
});
