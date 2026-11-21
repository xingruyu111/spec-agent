import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentsPath,
  childrenOf,
  loadAgents,
  parseAgents,
  saveAgents,
} from './agents.js';

const valid = {
  agents: {
    pm: {
      name: '产品经理',
      parent: null,
      role: '拆解与验收',
      systemPrompt: '你是 pm',
      model: { provider: 'inherit', model: 'inherit' },
      canDelegateTo: ['fe', 'be'],
    },
    fe: {
      name: '前端',
      parent: 'pm',
      role: '写前端',
      model: { provider: 'inherit', model: 'inherit' },
    },
    be: {
      name: '后端',
      parent: 'pm',
      role: '写后端',
      model: { provider: 'inherit', model: 'inherit' },
    },
  },
};

describe('agents 配置', () => {
  it('支持 map 形式并补默认值', () => {
    const agents = parseAgents(valid);
    expect(agents).toHaveLength(3);
    const fe = agents.find((agent) => agent.id === 'fe')!;
    expect(fe.parent).toBe('pm');
    expect(fe.tools.allow).toEqual(['Read', 'Write', 'Edit']);
    expect(fe.workspace?.writeScope).toEqual(['.']);
    expect(childrenOf(agents, 'pm' as never).sort()).toEqual(['be', 'fe']);
  });

  it('保留用户预配置的工作流节点', () => {
    const agents = parseAgents({
      agents: {
        pm: {
          ...valid.agents.pm,
          canDelegateTo: [],
          nodes: [
            {
              id: 'design',
              name: '需求拆解',
              description: '拆解需求',
              instructions: '输出验收标准',
              approval: true,
            },
          ],
        },
      },
    });
    expect(agents[0]?.nodes).toEqual([
      {
        id: 'design',
        name: '需求拆解',
        description: '拆解需求',
        instructions: '输出验收标准',
        approval: true,
      },
    ]);
  });

  it('id 重复会被拒绝', () => {
    expect(() =>
      parseAgents({
        agents: [
          { id: 'pm', parent: null, role: 'a' },
          { id: 'pm', parent: null, role: 'b' },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('父 agent 不存在会被拒绝', () => {
    expect(() =>
      parseAgents({
        agents: [{ id: 'fe', parent: 'missing', role: 'a' }],
      }),
    ).toThrow(/父 agent/);
  });

  it('组织树有环会被拒绝', () => {
    expect(() =>
      parseAgents({
        agents: [
          { id: 'a', parent: 'b', role: 'a' },
          { id: 'b', parent: 'a', role: 'b' },
        ],
      }),
    ).toThrow(/环/);
  });

  it('委派目标不存在会被拒绝', () => {
    expect(() =>
      parseAgents({
        agents: [
          {
            id: 'pm',
            parent: null,
            role: 'pm',
            canDelegateTo: ['ghost'],
          },
        ],
      }),
    ).toThrow(/委派目标/);
  });

  it('没有配置文件时返回 undefined', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-agents-'));
    try {
      expect(loadAgents(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('从 .spec-agent/agents.yaml 加载', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-agents-'));
    try {
      mkdirSync(join(root, '.spec-agent'), { recursive: true });
      writeFileSync(join(root, '.spec-agent', 'agents.yaml'), JSON.stringify(valid));
      const agents = loadAgents(root)!;
      expect(agents).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('保存后能重新加载完整配置', () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-agents-save-'));
    try {
      const agents = parseAgents(valid);
      const saved = saveAgents(root, agents);
      expect(saved).toHaveLength(3);
      expect(existsSync(agentsPath(root))).toBe(true);
      expect(dirname(agentsPath(root))).toBe(join(root, '.spec-agent'));

      const loaded = loadAgents(root)!;
      const pm = loaded.find((agent) => agent.id === 'pm')!;
      expect(pm.systemPrompt).toBe('你是 pm');
      expect(pm.canDelegateTo).toEqual(['fe', 'be']);
      expect(pm.model).toEqual({ provider: 'inherit', model: 'inherit' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

