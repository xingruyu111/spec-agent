import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@spec-agent/core';
import type { AgentConfig } from '@spec-agent/schema';
import { planProject } from '../../packages/runtime/src/project-planner.js';

const agents: AgentConfig[] = [
  {
    id: 'pm' as never,
    name: 'PM',
    parent: null,
    role: '协调',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read'] },
    workspace: { writeScope: ['.'] },
  },
  {
    id: 'builder' as never,
    name: 'Builder',
    parent: 'pm' as never,
    role: '执行',
    model: { provider: 'inherit', model: 'inherit' },
    skills: [],
    tools: { allow: ['Read', 'Write'] },
    workspace: { writeScope: ['.'] },
    nodes: [{ id: 'make', name: '制作', description: '制作交付物' }],
  },
];

function runtime(text: string): AgentRuntime {
  return {
    id: 'project-planner-fake',
    async run() {
      return {
        outputs: [],
        text,
        transcriptRef: 't',
        usage: { usd: 0.01 },
        stopReason: 'finished',
      };
    },
  };
}

const options = (text: string) => ({
  goal: '完成一个分阶段项目',
  agentRuntime: runtime(text),
  provider: { id: 'fake' },
  model: 'fake',
  agents,
});

describe('planProject', () => {
  it('拆 workstream、milestone 和依赖，不依赖项目类型', async () => {
    const draft = await planProject(
      options(
        JSON.stringify({
          title: '分阶段计划',
          workstreams: [
            {
              id: 'design',
              title: '设计',
              brief: '给出方案',
              assignee: 'pm',
              milestone: 'M1',
              dependsOn: [],
            },
            {
              id: 'build',
              title: '制作',
              brief: '按方案制作',
              assignee: 'builder',
              milestone: 'M2',
              dependsOn: ['design'],
            },
          ],
        }),
      ),
    );
    expect(draft.title).toBe('分阶段计划');
    expect(draft.items.map((item) => item.assignee)).toEqual(['pm', 'builder']);
    expect(draft.items[1]!.dependsOn).toEqual(['ws-1']);
  });

  it('拒绝未知 assignee 和依赖成环', async () => {
    await expect(
      planProject(
        options(
          JSON.stringify({
            workstreams: [
              {
                id: 'a',
                title: 'A',
                brief: 'A',
                assignee: 'missing',
                milestone: 'M1',
                dependsOn: [],
              },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_PROJECT_PLAN_INVALID' });

    await expect(
      planProject(
        options(
          JSON.stringify({
            workstreams: [
              {
                id: 'a',
                title: 'A',
                brief: 'A',
                assignee: 'pm',
                milestone: 'M1',
                dependsOn: ['b'],
              },
              {
                id: 'b',
                title: 'B',
                brief: 'B',
                assignee: 'pm',
                milestone: 'M2',
                dependsOn: ['a'],
              },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'E_PROJECT_PLAN_INVALID' });
  });
});
