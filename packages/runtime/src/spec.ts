/**
 * spec 文件加载。
 *
 * 支持 YAML 里的 `- [a, b]` 边写法，归一化成 `{from, to}` 后过 zod。
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { WorkflowSpec } from '@spec-agent/schema';
import { zWorkflowSpec } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';

export function loadSpecFile(path: string): WorkflowSpec {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new AppError('E_SPEC_READ', `读取 spec 失败：${path}`, { cause });
  }
  return normalizeSpec(raw);
}

export function normalizeSpec(raw: unknown): WorkflowSpec {
  const input = raw as Record<string, unknown>;
  const edges = Array.isArray(input.edges)
    ? input.edges.map((edge) =>
        Array.isArray(edge) ? { from: edge[0], to: edge[1] } : edge,
      )
    : [];

  const parsed = zWorkflowSpec.safeParse({
    ...input,
    params: input.params ?? [],
    nodes: input.nodes ?? [],
    edges,
  });

  if (!parsed.success) {
    throw new AppError('E_SPEC_INVALID', 'spec 结构不合法', {
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
