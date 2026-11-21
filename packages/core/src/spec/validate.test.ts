import { describe, expect, it } from 'vitest';
import type {
  AgentConfig,
  AgentId,
  LlmNode,
  NodeId,
  NodeSpec,
  WorkflowSpec,
} from '@spec-agent/schema';
import { validateWorkflowSpec, type ValidationContext } from './validate.js';

const A = (s: string) => s as AgentId;
const N = (s: string) => s as NodeId;

function makeAgent(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: A('pm'),
    name: '项目经理',
    parent: null,
    role: 'pm',
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    skills: [],
    tools: { allow: ['read_file', 'edit_file', 'grep', 'shell'], shell: 'full' },
    workspace: { writeScope: ['src/', 'docs/'] },
    ...over,
  };
}

function makeCtx(agent: AgentConfig = makeAgent()): ValidationContext {
  const pm = agent.id;
  const fe = makeAgent({ id: A('fe'), parent: pm });
  const be = makeAgent({ id: A('be'), parent: pm });
  const qa = makeAgent({ id: A('qa'), parent: pm });
  return {
    agent,
    agents: [agent, fe, be, qa],
    org: { shape: 'hierarchy', communication: 'strict', roots: [pm] },
  };
}

function baseSpec(): WorkflowSpec {
  return {
    name: 'feature-dev',
    version: 1,
    params: [{ name: 'spec', kind: 'file', required: true }],
    nodes: [
      {
        id: N('plan'),
        type: 'llm',
        description: '产出计划',
        inputs: [{ name: 'spec', from: 'param.spec', kind: 'file' }],
        outputs: [{ name: 'plan', kind: 'file', path: 'artifacts/plan.md' }],
        tools: ['read_file'],
        approval: { approvers: ['human'] },
      },
      {
        id: N('implement'),
        type: 'llm',
        description: '实现',
        inputs: [{ name: 'plan', from: 'plan.plan', kind: 'file' }],
        outputs: [{ name: 'changes', kind: 'dir', path: 'src/' }],
        tools: ['edit_file'],
        writeScope: ['src/'],
        verify: [{ kind: 'contract', run: 'pnpm tsc --noEmit' }],
      },
    ],
    edges: [{ from: N('plan'), to: N('implement') }],
  };
}

/** 线性链：n0 → n1 → ...，只有最后一个节点有闸门。 */
function chain(n: number): WorkflowSpec {
  const nodes: NodeSpec[] = [];
  for (let i = 0; i < n; i += 1) {
    const last = i === n - 1;
    const node: LlmNode = {
      id: N(`n${i}`),
      type: 'llm',
      description: `step ${i}`,
      inputs: i === 0 ? [] : [{ name: 'in', from: `n${i - 1}.out`, kind: 'file' }],
      outputs: [{ name: 'out', kind: 'file', path: `artifacts/${i}.md` }],
      tools: ['read_file'],
      ...(last ? { verify: [{ kind: 'contract' as const, run: 'true' }] } : {}),
    };
    nodes.push(node);
  }
  const edges = Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({
    from: N(`n${i}`),
    to: N(`n${i + 1}`),
  }));
  return { name: 'chain', version: 1, params: [], nodes, edges };
}

function codes(result: ReturnType<typeof validateWorkflowSpec>): string[] {
  return result.issues.map((i) => i.code);
}

describe('validateWorkflowSpec / 正常路径', () => {
  it('接受一份合法 spec', () => {
    const result = validateWorkflowSpec(baseSpec(), makeCtx());
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.spec?.nodes).toHaveLength(2);
  });

  it('终端节点可以只挂人工闸门', () => {
    const spec = baseSpec();
    delete spec.nodes[1]!.verify;
    spec.nodes[1]!.approval = { approvers: ['human'] };
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(result.ok).toBe(true);
  });

  it('subworkflow 节点可以独立存在', () => {
    const spec: WorkflowSpec = {
      name: 'sub',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('sub'),
          type: 'subworkflow',
          description: '嵌套一个流程',
          inputs: [],
          outputs: [{ name: 'out', kind: 'file', path: 'artifacts/out.md' }],
          workflow: 'feature-dev@v3',
          params: {},
          approval: { approvers: ['human'] },
        },
      ],
      edges: [],
    };
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(result.ok).toBe(true);
  });

  it('shell 节点默认有 exit_code 闸门', () => {
    const spec = baseSpec();
    spec.nodes[1] = {
      id: N('test'),
      type: 'shell',
      description: '跑测试',
      inputs: [{ name: 'plan', from: 'plan.plan', kind: 'file' }],
      outputs: [{ name: 'report', kind: 'json' }],
      run: 'pnpm test',
    };
    spec.edges[0]!.to = N('test');
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(result.ok).toBe(true);
  });

  it('12 个节点刚好通过上限', () => {
    const result = validateWorkflowSpec(chain(12), makeCtx());
    expect(result.ok).toBe(true);
  });

  it('text 输入接受任何 ArtifactKind', () => {
    const spec = baseSpec();
    spec.nodes[1]!.inputs[0]!.kind = 'text';
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(codes(result)).not.toContain('E_CONTRACT_MISMATCH');
  });

  it('canDelegateTo 可以显式覆盖组织树', () => {
    const pm = makeAgent({ canDelegateTo: [A('qa')] });
    const qa = makeAgent({ id: A('qa'), parent: A('be') });
    const ctx: ValidationContext = {
      agent: pm,
      agents: [pm, qa],
      org: { shape: 'flat', communication: 'peer', roots: [pm.id] },
    };
    const spec: WorkflowSpec = {
      name: 'delegate-test',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('qa_check'),
          type: 'delegate',
          description: '让 QA 检查',
          inputs: [],
          outputs: [],
          agent: A('qa'),
          brief: '检查一下',
          approval: { approvers: ['human'] },
        },
      ],
      edges: [],
    };
    const result = validateWorkflowSpec(spec, ctx);
    expect(result.ok).toBe(true);
  });

  it('工具前缀 allow 生效（shell 覆盖 shell:test）', () => {
    const agent = makeAgent({
      tools: { allow: ['read_file', 'shell'], shell: 'full' },
    });
    const spec = baseSpec();
    const node = spec.nodes[1]!;
    if (node.type === 'llm') node.tools = ['shell:test'];
    const result = validateWorkflowSpec(spec, makeCtx(agent));
    expect(result.ok).toBe(true);
  });
});

describe('validateWorkflowSpec / 1 Schema', () => {
  it('结构不对时给出路径', () => {
    const spec = { ...baseSpec(), nodes: [{ id: 'x', type: 'magic' }] };
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('E_SCHEMA');
    expect(result.issues[0]?.path).toMatch(/^\/nodes\/0/);
  });

  it('version 必须是正整数', () => {
    const result = validateWorkflowSpec({ ...baseSpec(), version: 0 }, makeCtx());
    expect(codes(result)).toContain('E_SCHEMA');
  });

  it('duration 格式非法会被拒绝', () => {
    const spec = baseSpec();
    spec.nodes[0]!.timeout = 'twenty minutes';
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(codes(result)).toContain('E_SCHEMA');
  });

  it('审批人不能为空', () => {
    const spec = baseSpec();
    spec.nodes[0]!.approval = { approvers: [] };
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(codes(result)).toContain('E_SCHEMA');
  });

  it('contract 验证器缺 run 会被拒绝', () => {
    const spec = baseSpec();
    spec.nodes[1]!.verify = [{ kind: 'contract' } as never];
    const result = validateWorkflowSpec(spec, makeCtx());
    expect(codes(result)).toContain('E_SCHEMA');
  });
});

describe('validateWorkflowSpec / 2 引用', () => {
  it('节点 id 重复', () => {
    const spec = baseSpec();
    spec.nodes[1]!.id = N('plan');
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('边指向不存在的节点', () => {
    const spec = baseSpec();
    spec.edges.push({ from: N('plan'), to: N('nope') });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('边的起点不存在', () => {
    const spec = baseSpec();
    spec.edges.push({ from: N('ghost'), to: N('implement') });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('重复的边', () => {
    const spec = baseSpec();
    spec.edges.push({ from: N('plan'), to: N('implement') });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('自环', () => {
    const spec = baseSpec();
    spec.edges.push({ from: N('plan'), to: N('plan') });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('引用不存在的输出端口', () => {
    const spec = baseSpec();
    spec.nodes[1]!.inputs[0]!.from = 'plan.nope';
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('引用不存在的节点', () => {
    const spec = baseSpec();
    spec.nodes[1]!.inputs[0]!.from = 'ghost.out';
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('引用格式非法在 schema 层被拒绝', () => {
    const spec = baseSpec();
    spec.nodes[1]!.inputs[0]!.from = 'plan';
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_SCHEMA');
  });

  it('引用了不存在的参数', () => {
    const spec = baseSpec();
    spec.nodes[0]!.inputs[0]!.from = 'param.missing';
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('参数名重复', () => {
    const spec = baseSpec();
    spec.params.push({ name: 'spec', kind: 'file' });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('输入名重复', () => {
    const spec = baseSpec();
    spec.nodes[1]!.inputs.push({ name: 'plan', from: 'plan.plan' });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('输出名重复', () => {
    const spec = baseSpec();
    spec.nodes[0]!.outputs.push({ name: 'plan', kind: 'file', path: 'artifacts/again.md' });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });
});

describe('validateWorkflowSpec / 3 契约与环', () => {
  it('类型对不上', () => {
    const spec = baseSpec();
    spec.nodes[1]!.inputs[0]!.kind = 'dir';
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_CONTRACT_MISMATCH');
  });

  it('参数类型对不上', () => {
    const spec = baseSpec();
    spec.params = [{ name: 'spec', kind: 'string', required: true }];
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_CONTRACT_MISMATCH');
  });

  it('引用了非上游节点', () => {
    const spec = baseSpec();
    spec.nodes.push({
      id: N('side'),
      type: 'llm',
      description: '旁路',
      inputs: [],
      outputs: [{ name: 'x', kind: 'file', path: 'artifacts/x.md' }],
      tools: ['read_file'],
      approval: { approvers: ['human'] },
    });
    spec.nodes[1]!.inputs[0]!.from = 'side.x';
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_CONTRACT_MISMATCH');
  });

  it('互相依赖', () => {
    const spec = baseSpec();
    spec.edges.push({ from: N('implement'), to: N('plan') });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_CYCLE');
  });

  it('三节点环', () => {
    const spec = chain(3);
    spec.edges.push({ from: N('n2'), to: N('n0') });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_CYCLE');
  });
});

describe('validateWorkflowSpec / 4 权限', () => {
  it('写入范围越界', () => {
    const spec = baseSpec();
    const node = spec.nodes[1]!;
    if (node.type === 'llm') node.writeScope = ['/etc'];
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_PERMISSION');
  });

  it('deny 优先于 allow', () => {
    const agent = makeAgent({
      tools: { allow: ['read_file', 'edit_file'], deny: ['edit_file'], shell: 'full' },
    });
    expect(codes(validateWorkflowSpec(baseSpec(), makeCtx(agent)))).toContain('E_PERMISSION');
  });

  it('readonly shell 模式不能跑 shell 节点', () => {
    const agent = makeAgent({
      tools: { allow: ['read_file', 'shell'], shell: 'readonly' },
    });
    const spec = baseSpec();
    spec.nodes[1] = {
      id: N('test'),
      type: 'shell',
      description: '跑测试',
      inputs: [{ name: 'plan', from: 'plan.plan', kind: 'file' }],
      outputs: [{ name: 'report', kind: 'json' }],
      run: 'pnpm test',
    };
    spec.edges[0]!.to = N('test');
    expect(codes(validateWorkflowSpec(spec, makeCtx(agent)))).toContain('E_PERMISSION');
  });

  it('委派目标不存在', () => {
    const spec: WorkflowSpec = {
      name: 'delegate-test',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('x'),
          type: 'delegate',
          description: '交给不存在的人',
          inputs: [],
          outputs: [],
          agent: A('ghost'),
          brief: '做点什么',
          approval: { approvers: ['human'] },
        },
      ],
      edges: [],
    };
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_REFERENCE');
  });

  it('委派给非下属', () => {
    const pm = makeAgent();
    const qa = makeAgent({ id: A('qa'), parent: A('be') });
    const ctx: ValidationContext = {
      agent: pm,
      agents: [pm, qa],
      org: { shape: 'hierarchy', communication: 'strict', roots: [pm.id] },
    };
    const spec: WorkflowSpec = {
      name: 'delegate-test',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('qa_check'),
          type: 'delegate',
          description: '让 QA 检查',
          inputs: [],
          outputs: [],
          agent: A('qa'),
          brief: '检查一下',
          approval: { approvers: ['human'] },
        },
      ],
      edges: [],
    };
    expect(codes(validateWorkflowSpec(spec, ctx))).toContain('E_PERMISSION');
  });
});

describe('validateWorkflowSpec / 5 预算', () => {
  it('13 个节点超过上限', () => {
    expect(codes(validateWorkflowSpec(chain(13), makeCtx()))).toContain('E_BUDGET');
  });

  it('刚好 80% 不报错，超过报错', () => {
    const atLimit = validateWorkflowSpec(baseSpec(), {
      ...makeCtx(),
      budgetUsd: 1,
      estimatedCostUsd: 0.8,
    });
    expect(codes(atLimit)).not.toContain('E_BUDGET');

    const over = validateWorkflowSpec(baseSpec(), {
      ...makeCtx(),
      budgetUsd: 1,
      estimatedCostUsd: 0.81,
    });
    expect(codes(over)).toContain('E_BUDGET');
  });
});

describe('validateWorkflowSpec / 6 Lint', () => {
  it('空 spec', () => {
    const spec: WorkflowSpec = {
      name: 'empty',
      version: 1,
      params: [],
      nodes: [],
      edges: [],
    };
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_LINT');
  });

  it('图不连通', () => {
    const spec = baseSpec();
    spec.nodes.push({
      id: N('island'),
      type: 'llm',
      description: '孤岛',
      inputs: [],
      outputs: [{ name: 'x', kind: 'file', path: 'artifacts/x.md' }],
      tools: ['read_file'],
      approval: { approvers: ['human'] },
    });
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_LINT');
  });

  it('file 输出缺 path', () => {
    const spec = baseSpec();
    delete spec.nodes[0]!.outputs[0]!.path;
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_LINT');
  });

  it('dir 输出缺 path', () => {
    const spec = baseSpec();
    const node = spec.nodes[1]!;
    if (node.type === 'llm') node.outputs = [{ name: 'changes', kind: 'dir' }];
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_LINT');
  });

  it('终端节点没有产物', () => {
    const spec: WorkflowSpec = {
      name: 'noop',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('noop'),
          type: 'llm',
          description: '什么都不产出',
          inputs: [],
          outputs: [],
          tools: [],
          approval: { approvers: ['human'] },
        },
      ],
      edges: [],
    };
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_LINT');
  });
});

describe('validateWorkflowSpec / 7 可验证性', () => {
  it('终端节点没有闸门', () => {
    const spec = baseSpec();
    delete spec.nodes[1]!.verify;
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_UNVERIFIED_ARTIFACT');
  });

  it('只有 advisory 验证器不算闸门', () => {
    const spec = baseSpec();
    spec.nodes[1]!.verify = [{ kind: 'judge', rubric: 'review.md', advisory: true }];
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_UNVERIFIED_ARTIFACT');
  });

  it('mustPass:false 的 exit_code 不算闸门', () => {
    const spec = baseSpec();
    spec.nodes[1] = {
      id: N('test'),
      type: 'shell',
      description: '跑测试',
      inputs: [{ name: 'plan', from: 'plan.plan', kind: 'file' }],
      outputs: [{ name: 'report', kind: 'json' }],
      run: 'pnpm test',
      verify: [{ kind: 'exit_code', mustPass: false }],
    };
    spec.edges[0]!.to = N('test');
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_UNVERIFIED_ARTIFACT');
  });

  it('显式 verify: [] 会关掉 shell 的默认闸门', () => {
    const spec = baseSpec();
    spec.nodes[1] = {
      id: N('test'),
      type: 'shell',
      description: '跑测试',
      inputs: [{ name: 'plan', from: 'plan.plan', kind: 'file' }],
      outputs: [{ name: 'report', kind: 'json' }],
      run: 'pnpm test',
      verify: [],
    };
    spec.edges[0]!.to = N('test');
    expect(codes(validateWorkflowSpec(spec, makeCtx()))).toContain('E_UNVERIFIED_ARTIFACT');
  });

  it('delegate 的验证可以下推给子任务', () => {
    const pm = makeAgent();
    const fe = makeAgent({
      id: A('fe'),
      parent: pm.id,
      gates: { taskGate: { approvers: ['human'] } },
    });
    const ctx: ValidationContext = {
      agent: pm,
      agents: [pm, fe],
      org: { shape: 'hierarchy', communication: 'strict', roots: [pm.id] },
    };
    const spec: WorkflowSpec = {
      name: 'delegate-test',
      version: 1,
      params: [],
      nodes: [
        {
          id: N('fe_task'),
          type: 'delegate',
          description: '交给 fe',
          inputs: [],
          outputs: [],
          agent: A('fe'),
          brief: '实现一下',
        },
      ],
      edges: [],
    };
    const result = validateWorkflowSpec(spec, ctx);
    expect(result.ok).toBe(true);
  });
});

describe('validateWorkflowSpec / 鲁棒性', () => {
  it('不修改输入', () => {
    const spec = baseSpec();
    const before = JSON.stringify(spec);
    validateWorkflowSpec(spec, makeCtx());
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('对任意 JSON 不抛异常', () => {
    const rand = mulberry32(20261026);
    for (let i = 0; i < 300; i += 1) {
      const input = randomValue(rand, 0);
      const result = validateWorkflowSpec(input, makeCtx());
      expect(typeof result.ok).toBe('boolean');
    }
  });

  it('同一份 spec 校验两次结果一致', () => {
    const spec = baseSpec();
    const first = validateWorkflowSpec(spec, makeCtx());
    const second = validateWorkflowSpec(spec, makeCtx());
    expect(first.ok).toBe(second.ok);
    expect(first.issues).toEqual(second.issues);
  });
});

/* ---------------- 确定性随机 ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(rand: () => number, depth: number): unknown {
  const r = rand();
  if (depth > 3) return r < 0.5 ? null : Math.floor(r * 10);
  if (r < 0.12) return null;
  if (r < 0.24) return rand() < 0.5;
  if (r < 0.36) return Math.floor(rand() * 100) - 50;
  if (r < 0.48) return ['x', '', 'E_SCHEMA', 'a.b', 'llm'][Math.floor(rand() * 5)];
  if (r < 0.66) {
    return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(rand, depth + 1));
  }
  const obj: Record<string, unknown> = {};
  const keys = ['nodes', 'edges', 'name', 'version', 'params', 'type', 'id', 'inputs', 'outputs'];
  for (const key of keys) {
    if (rand() < 0.4) obj[key] = randomValue(rand, depth + 1);
  }
  return obj;
}
