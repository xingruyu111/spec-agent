import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeSpec } from '@spec-agent/schema';
import {
  artifactKindForPath,
  validateJsonSchema,
  verifyArtifactContracts,
} from '../../packages/core/src/artifacts.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function node(path = 'artifacts/report.json'): NodeSpec {
  return {
    id: 'verify' as never,
    type: 'shell',
    description: '验证产物',
    inputs: [],
    outputs: [{
      name: 'report',
      kind: 'json',
      path,
      required: true,
      schema: 'artifacts/schema.json',
    }],
    run: 'unused',
  };
}

describe('artifact contracts', () => {
  it('required outputPath 必须存在，并识别媒体类型', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-artifact-'));
    roots.push(root);
    expect(() => verifyArtifactContracts(node(), root, [])).toThrowError(/不存在/);
    mkdirSync(join(root, 'artifacts'), { recursive: true });
    writeFileSync(join(root, 'artifacts', 'report.json'), '{}');
    writeFileSync(
      join(root, 'artifacts', 'schema.json'),
      JSON.stringify({ type: 'object', required: ['status'] }),
    );
    expect(() => verifyArtifactContracts(node(), root, [])).toThrowError(/status/);
    writeFileSync(
      join(root, 'artifacts', 'report.json'),
      JSON.stringify({ status: 'ok' }),
    );
    expect(() => verifyArtifactContracts(node(), root, [])).not.toThrow();
    expect(artifactKindForPath('assets/scene.png')).toBe('image');
    expect(artifactKindForPath('assets/voice.mp3')).toBe('audio');
    expect(artifactKindForPath('assets/demo.mp4')).toBe('video');
    expect(artifactKindForPath('dist/game.zip')).toBe('binary');
  });

  it('JSON Schema 校验嵌套字段、数组和枚举', () => {
    expect(validateJsonSchema(
      { status: 'ok', items: [{ path: 'a.png' }] },
      {
        type: 'object',
        required: ['status', 'items'],
        properties: {
          status: { type: 'string', enum: ['ok', 'failed'] },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['path'],
              properties: { path: { type: 'string', minLength: 1 } },
            },
          },
        },
      },
    )).toEqual([]);
    expect(validateJsonSchema(
      { status: 'unknown', items: [] },
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok'] },
          items: { type: 'array', minItems: 1 },
        },
      },
    )).toHaveLength(2);
  });
});
