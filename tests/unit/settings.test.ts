import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPEC_AGENT_SETTINGS,
  loadSpecAgentSettings,
} from '../../packages/runtime/src/settings.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-settings-'));
  roots.push(root);
  return root;
}

describe('loadSpecAgentSettings', () => {
  it('没有 settings.json 时使用大型项目默认值', () => {
    const settings = loadSpecAgentSettings(project());
    expect(settings).toEqual(DEFAULT_SPEC_AGENT_SETTINGS);
    expect(settings.execution.mode).toBe('session');
    expect(settings.planner.maxTotalNodes).toBeGreaterThan(32);
  });

  it('支持只覆盖部分字段，其余保持默认', () => {
    const root = project();
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({
        planner: { maxLayerNodes: 24 },
        execution: { maxUsdPerTask: 100, maxConcurrentChildren: 12 },
      }),
    );
    const settings = loadSpecAgentSettings(root);
    expect(settings.planner.maxLayerNodes).toBe(24);
    expect(settings.planner.maxTotalNodes).toBe(
      DEFAULT_SPEC_AGENT_SETTINGS.planner.maxTotalNodes,
    );
    expect(settings.execution.maxUsdPerTask).toBe(100);
    expect(settings.execution.maxUsdPerNode).toBe(
      DEFAULT_SPEC_AGENT_SETTINGS.execution.maxUsdPerNode,
    );
    expect(settings.execution.maxConcurrentChildren).toBe(12);
  });

  it('只支持 session 执行模式，拒绝 node 和非法值', () => {
    const root = project();
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({ execution: { mode: 'session' } }),
    );
    expect(loadSpecAgentSettings(root).execution.mode).toBe('session');
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({ execution: { mode: 'node' } }),
    );
    expect(() => loadSpecAgentSettings(root)).toThrowError(/只支持 session/);
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({ execution: { mode: 'parallel' } }),
    );
    expect(() => loadSpecAgentSettings(root)).toThrowError(/只支持 session/);
  });

  it('拒绝非法 JSON 和非正数', () => {
    const root = project();
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(join(root, '.spec-agent', 'settings.json'), '{');
    expect(() => loadSpecAgentSettings(root)).toThrowError(/合法 JSON/);
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({ planner: { maxTotalNodes: 0 } }),
    );
    expect(() => loadSpecAgentSettings(root)).toThrowError(/正整数/);
  });

  it('支持 Tencent Memory 配置，但不在项目设置里保存 API Key', () => {
    const root = project();
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({
        capabilities: {
          memory: {
            provider: 'tencent',
            baseUrl: 'http://127.0.0.1:8420',
            serviceId: 'instance-1',
            userId: 'local-user',
          },
        },
      }),
    );
    expect(loadSpecAgentSettings(root).capabilities.memory).toEqual({
      provider: 'tencent',
      baseUrl: 'http://127.0.0.1:8420',
      serviceId: 'instance-1',
      userId: 'local-user',
    });
  });

  it('支持 qaAgent 配置', () => {
    const root = project();
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({ execution: { qaAgent: 'qa' } }),
    );
    expect(loadSpecAgentSettings(root).execution.qaAgent).toBe('qa');
  });

  it('支持 Hy-Memory 配置', () => {
    const root = project();
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(
      join(root, '.spec-agent', 'settings.json'),
      JSON.stringify({
        capabilities: {
          memory: {
            provider: 'hy-memory',
            baseUrl: 'http://127.0.0.1:19527',
            userId: 'local-user',
            workspaceId: 'spec-agent',
            branch: 'main',
          },
        },
      }),
    );
    expect(loadSpecAgentSettings(root).capabilities.memory).toEqual({
      provider: 'hy-memory',
      baseUrl: 'http://127.0.0.1:19527',
      userId: 'local-user',
      workspaceId: 'spec-agent',
      branch: 'main',
    });
  });
});
