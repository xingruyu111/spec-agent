import { describe, expect, it } from 'vitest';
import type { NodeId, WorkflowSpec } from '@spec-agent/schema';
import { canonicalize } from './canonical.js';
import { specHash, specRef } from './hash.js';

const N = (s: string) => s as NodeId;

function spec(): WorkflowSpec {
  return {
    name: 'feature-dev',
    version: 1,
    description: '示例',
    params: [{ name: 'spec', kind: 'file', required: true }],
    nodes: [
      {
        id: N('plan'),
        type: 'llm',
        description: '计划',
        inputs: [{ name: 'spec', from: 'param.spec' }],
        outputs: [{ name: 'plan', kind: 'file', path: 'artifacts/plan.md' }],
        tools: ['read_file'],
        approval: { approvers: ['human'] },
      },
    ],
    edges: [],
    defaults: { retries: 1 },
  };
}

describe('canonicalize', () => {
  it('对 key 排序', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('丢弃 undefined', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('数组顺序保持不变', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('递归处理嵌套对象', () => {
    expect(canonicalize({ z: { b: 1, a: [{ d: 2, c: 3 }] } })).toBe(
      '{"z":{"a":[{"c":3,"d":2}],"b":1}}',
    );
  });

  it('null 保持为 null', () => {
    expect(canonicalize(null)).toBe('null');
  });
});

describe('specHash', () => {
  it('同一内容得到同一 hash', () => {
    expect(specHash(spec())).toBe(specHash(spec()));
  });

  it('是 64 位十六进制', () => {
    expect(specHash(spec())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('布局不参与', () => {
    const a = spec();
    const b = spec();
    b.ui = { positions: { plan: { x: 1, y: 2 } } };
    expect(specHash(a)).toBe(specHash(b));
  });

  it('id 不参与', () => {
    const b = { ...spec(), id: 'abc' };
    expect(specHash(spec())).toBe(specHash(b));
  });

  it('meta.createdAt 不参与', () => {
    const b = spec();
    b.meta = { origin: 'template', createdAt: '2026-01-01T00:00:00Z' };
    expect(specHash(spec())).toBe(specHash(b));
  });

  it('description 变化会改变 hash', () => {
    const b = { ...spec(), description: '另一种描述' };
    expect(specHash(spec())).not.toBe(specHash(b));
  });

  it('节点顺序变化会改变 hash', () => {
    const a = spec();
    a.nodes.push({
      id: N('other'),
      type: 'llm',
      description: 'x',
      inputs: [],
      outputs: [{ name: 'x', kind: 'file', path: 'x.md' }],
      tools: [],
      approval: { approvers: ['human'] },
    });
    const b: WorkflowSpec = {
      ...a,
      nodes: [...a.nodes].reverse(),
    };
    expect(specHash(a)).not.toBe(specHash(b));
  });
});

describe('specRef', () => {
  it('用 name@vN 表示', () => {
    expect(specRef(spec())).toBe('feature-dev@v1');
  });
});
