/**
 * spec 的内容 hash。
 *
 * 只有 name / version / description / params / nodes / edges / defaults 参与。
 * ui、id、meta.createdAt 不参与——拖一下节点不应该产生新版本。
 */

import { createHash } from 'node:crypto';
import type { HashedSpec, WorkflowSpec } from '@spec-agent/schema';
import { canonicalize } from './canonical.js';

export function specHash(spec: WorkflowSpec): string {
  const hashed: HashedSpec = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    params: spec.params,
    nodes: spec.nodes,
    edges: spec.edges,
    defaults: spec.defaults,
  };
  return createHash('sha256').update(canonicalize(hashed), 'utf8').digest('hex');
}

/** 'feature-dev@v3' */
export function specRef(spec: WorkflowSpec): string {
  return `${spec.name}@v${spec.version}`;
}
