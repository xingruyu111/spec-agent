/**
 * 图的纯计算：索引、拓扑序、上游判定、连通分量。
 * 不产生错误、不改输入；错误由 validate.ts 组装。
 */

import type { WorkflowSpec } from '@spec-agent/schema';

export type GraphIndex = {
  ids: string[];
  out: Map<string, string[]>;
  inc: Map<string, string[]>;
  terminals: string[];
  roots: string[];
};

export function indexGraph(spec: WorkflowSpec): GraphIndex {
  const ids = spec.nodes.map((n) => String(n.id));
  const known = new Set(ids);
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inc.set(id, []);
  }

  for (const edge of spec.edges) {
    const from = String(edge.from);
    const to = String(edge.to);
    if (!known.has(from) || !known.has(to) || from === to) continue;
    const outs = out.get(from)!;
    if (outs.includes(to)) continue;
    outs.push(to);
    inc.get(to)!.push(from);
  }

  return {
    ids,
    out,
    inc,
    terminals: ids.filter((id) => out.get(id)!.length === 0),
    roots: ids.filter((id) => inc.get(id)!.length === 0),
  };
}

export function topoSort(spec: WorkflowSpec): { order: string[]; cycle: string[] } {
  const { ids, out } = indexGraph(spec);
  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const id of ids) {
    for (const next of out.get(id)!) {
      indegree.set(next, indegree.get(next)! + 1);
    }
  }

  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  const inOrder = new Set(order);
  return { order, cycle: ids.filter((id) => !inOrder.has(id)) };
}

/** from 是否是 to 的上游（能沿边走到）。 */
export function isUpstream(spec: WorkflowSpec, from: string, to: string): boolean {
  if (from === to) return false;
  const { out } = indexGraph(spec);
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of out.get(current)!) stack.push(next);
  }
  return false;
}

/** 弱连通分量数量。> 1 说明图是断开的。 */
export function componentCount(spec: WorkflowSpec): number {
  const { ids, out, inc } = indexGraph(spec);
  const seen = new Set<string>();
  let count = 0;

  for (const start of ids) {
    if (seen.has(start)) continue;
    count += 1;
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of out.get(current)!) stack.push(next);
      for (const prev of inc.get(current)!) stack.push(prev);
    }
  }
  return count;
}
