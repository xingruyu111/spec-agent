import { describe, expect, it } from 'vitest';
import type { NodeId, WorkflowSpec } from '@spec-agent/schema';
import { componentCount, indexGraph, isUpstream, topoSort } from './graph.js';

const N = (s: string) => s as NodeId;

function chain(n: number): WorkflowSpec {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: N(`n${i}`),
    type: 'llm' as const,
    description: `step ${i}`,
    inputs: i === 0 ? [] : [{ name: 'in', from: `n${i - 1}.out`, kind: 'file' as const }],
    outputs: [{ name: 'out', kind: 'file' as const, path: `artifacts/${i}.md` }],
    tools: ['read_file'],
  }));
  const edges = Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({
    from: N(`n${i}`),
    to: N(`n${i + 1}`),
  }));
  return { name: 'chain', version: 1, params: [], nodes, edges };
}

describe('indexGraph', () => {
  it('忽略悬空边和自环，并给重复边去重', () => {
    const spec = chain(3);
    spec.edges.push({ from: N('n0'), to: N('n1') }); // 重复
    spec.edges.push({ from: N('n0'), to: N('missing') }); // 悬空
    spec.edges.push({ from: N('n1'), to: N('n1') }); // 自环

    const graph = indexGraph(spec);
    expect(graph.out.get('n0')).toEqual(['n1']);
    expect(graph.inc.get('n1')).toEqual(['n0']);
    expect(graph.roots).toEqual(['n0']);
    expect(graph.terminals).toEqual(['n2']);
  });

  it('空图返回空集合', () => {
    const graph = indexGraph({ name: 'x', version: 1, params: [], nodes: [], edges: [] });
    expect(graph.ids).toEqual([]);
    expect(graph.terminals).toEqual([]);
  });
});

describe('topoSort', () => {
  it('链式图给出顺序', () => {
    const { order, cycle } = topoSort(chain(3));
    expect(order).toEqual(['n0', 'n1', 'n2']);
    expect(cycle).toEqual([]);
  });

  it('环形图返回环上的节点', () => {
    const spec = chain(3);
    spec.edges.push({ from: N('n2'), to: N('n0') });
    const { order, cycle } = topoSort(spec);
    expect(order).toEqual([]);
    expect(cycle.sort()).toEqual(['n0', 'n1', 'n2']);
  });

  it('菱形依赖只排一次', () => {
    const spec = chain(3);
    spec.edges.push({ from: N('n0'), to: N('n2') });
    const { order } = topoSort(spec);
    expect(order).toEqual(['n0', 'n1', 'n2']);
  });
});

describe('isUpstream', () => {
  it('沿边可达', () => {
    expect(isUpstream(chain(3), 'n0', 'n2')).toBe(true);
  });

  it('反向不可达', () => {
    expect(isUpstream(chain(3), 'n2', 'n0')).toBe(false);
  });

  it('自己不是自己的上游', () => {
    expect(isUpstream(chain(3), 'n1', 'n1')).toBe(false);
  });
});

describe('componentCount', () => {
  it('连通图为 1', () => {
    expect(componentCount(chain(3))).toBe(1);
  });

  it('孤岛会分开计数', () => {
    const spec = chain(2);
    spec.nodes.push({
      id: N('island'),
      type: 'llm',
      description: '孤岛',
      inputs: [],
      outputs: [{ name: 'x', kind: 'file', path: 'artifacts/x.md' }],
      tools: ['read_file'],
    });
    expect(componentCount(spec)).toBe(2);
  });
});
