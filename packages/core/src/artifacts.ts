/** Artifact 输出契约：存在性、kind 与 JSON Schema。 */

import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { ArtifactRef, NodeSpec, OutputPort } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';

export function artifactKindForPath(path: string): ArtifactRef['kind'] {
  const lower = path.toLowerCase();
  if (/\.json(?:l)?$/.test(lower)) return 'json';
  if (/\.(png|jpe?g|webp|gif|svg|avif)$/.test(lower)) return 'image';
  if (/\.(mp3|wav|ogg|flac|aac|m4a)$/.test(lower)) return 'audio';
  if (/\.(mp4|webm|mov|mkv|avi)$/.test(lower)) return 'video';
  if (/\.(zip|tar|gz|7z|exe|dll|bin|wasm|blend|fbx|glb|gltf)$/.test(lower)) return 'binary';
  if (/\.(diff|patch)$/.test(lower)) return 'diff';
  if (/\.(txt|md|markdown|log)$/.test(lower)) return 'text';
  return 'file';
}

/** 在节点进入 verify / 人审前检查 required outputs。 */
export function verifyArtifactContracts(
  node: NodeSpec,
  worktree: string,
  produced: ArtifactRef[],
): void {
  for (const output of node.outputs) {
    if (!output.required) continue;
    const artifact = output.path
      ? verifyOutputPath(output, worktree)
      : produced.find(
          (candidate) =>
            candidate.name === output.name && candidate.kind === output.kind,
        );
    if (!artifact) {
      throw new AppError(
        'E_ARTIFACT_MISSING',
        `节点 ${node.id} 缺少必需产物 ${output.name}`,
      );
    }
    if (output.kind === 'json' && output.schema) {
      const data = artifact.data !== undefined
        ? artifact.data
        : artifact.path
          ? readJson(artifact.path, worktree)
          : undefined;
      const schema = readJson(output.schema, worktree);
      const issues = validateJsonSchema(data, schema);
      if (issues.length > 0) {
        throw new AppError(
          'E_ARTIFACT_SCHEMA',
          `产物 ${output.name} 不符合 schema ${output.schema}：${issues.join('；')}`,
        );
      }
    }
  }
}

function verifyOutputPath(output: OutputPort, worktree: string): ArtifactRef {
  const path = safePath(worktree, output.path!);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new AppError(
      'E_ARTIFACT_MISSING',
      `输出文件不存在：${output.path}`,
    );
  }
  if (output.kind === 'dir' && !stat.isDirectory()) {
    throw new AppError('E_ARTIFACT_KIND', `${output.path} 不是目录`);
  }
  if (output.kind !== 'dir' && !stat.isFile()) {
    throw new AppError('E_ARTIFACT_KIND', `${output.path} 不是文件`);
  }
  return {
    name: output.name,
    kind: output.kind,
    path: output.path,
    bytes: stat.size,
    ...(output.schema ? { schema: output.schema } : {}),
  };
}

function safePath(worktree: string, value: string): string {
  const path = resolve(worktree, value);
  const rel = relative(resolve(worktree), path);
  if (!rel || rel.startsWith('..') || resolve(worktree, rel) !== path) {
    throw new AppError('E_ARTIFACT_PATH', `产物路径必须位于 worktree 内：${value}`);
  }
  return path;
}

function readJson(path: string, worktree: string): unknown {
  try {
    return JSON.parse(readFileSync(safePath(worktree, path), 'utf8'));
  } catch (cause) {
    throw new AppError('E_ARTIFACT_JSON', `无法读取 JSON：${path}`, { cause });
  }
}

/** 常用 JSON Schema 子集；不支持的条件显式报错，避免假装验证。 */
export function validateJsonSchema(data: unknown, schema: unknown, path = '$'): string[] {
  if (!isRecord(schema)) return [`${path} schema 必须是对象`];
  const type = schema.type;
  if (typeof type === 'string' && !matchesType(data, type)) {
    return [`${path} 应为 ${type}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => Object.is(value, data))) {
    return [`${path} 不在 enum 中`];
  }
  const issues: string[] = [];
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of (schema.required as unknown[] | undefined) ?? []) {
      if (typeof key === 'string' && record[key] === undefined) {
        issues.push(`${path}.${key} 缺失`);
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined) {
        issues.push(...validateJsonSchema(record[key], child, `${path}.${key}`));
      }
    }
  }
  if (Array.isArray(data)) {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
      issues.push(`${path} 至少 ${schema.minItems} 项`);
    }
    if (schema.items) {
      data.forEach((item, index) => {
        issues.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
      });
    }
  }
  if (typeof data === 'string') {
    if (typeof schema.minLength === 'number' && data.length < schema.minLength) {
      issues.push(`${path} 长度至少 ${schema.minLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(data)) {
      issues.push(`${path} 不匹配 pattern`);
    }
  }
  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum) {
      issues.push(`${path} 小于 minimum ${schema.minimum}`);
    }
  }
  return issues;
}

function matchesType(data: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(data);
    case 'array': return Array.isArray(data);
    case 'string': return typeof data === 'string';
    case 'number': return typeof data === 'number' && Number.isFinite(data);
    case 'integer': return typeof data === 'number' && Number.isSafeInteger(data);
    case 'boolean': return typeof data === 'boolean';
    case 'null': return data === null;
    default: throw new AppError('E_ARTIFACT_SCHEMA', `暂不支持的 JSON Schema type：${type}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
