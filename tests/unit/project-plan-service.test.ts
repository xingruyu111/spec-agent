import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitService, ShellRunner } from '@spec-agent/core';
import { Store } from '@spec-agent/core';
import { ProjectPlanService } from '../../apps/server/src/chat/project-plans.js';
import { createSystemClock } from '@spec-agent/kernel';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function setup(verify = 'pnpm test', mergeError?: string) {
  const root = mkdtempSync(join(tmpdir(), 'hive-project-plan-'));
  roots.push(root);
  const store = new Store({ path: join(root, 'spec-agent.db'), clock: createSystemClock() });
  const plan = store.createProjectPlan({
    id: 'plan-1',
    title: '测试计划',
    goal: '完成项目',
    verifyCommand: verify,
  });
  const item = store.createProjectPlanItem({
    id: 'item-1',
    planId: plan.id,
    title: '实现',
    goal: '实现交付',
    assignee: 'pm',
    milestone: 'M1',
    position: 0,
  });
  store.updateProjectPlanItem(item.id, { status: 'running', taskId: 'task-1' });
  store.db
    .prepare(
      `INSERT INTO tasks
         (id, parent_id, assignee, caller, title, status, result, cost_usd,
          plan_cost_usd, branch, origin_node_run_id, created_at, finished_at)
       VALUES ('task-1', NULL, 'pm', NULL, '实现', 'succeeded', NULL, 0, 0,
               'agent/pm/task-1', NULL, ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());
  store.setProjectPlanStatus(plan.id, 'running');

  let merged = 0;
  let verified = 0;
  const merges: string[] = [];
  const git = {
    async merge(input: { branch: string }) {
      if (mergeError) throw new Error(mergeError);
      merged += 1;
      merges.push(input.branch);
      return { commit: 'abc', alreadyUpToDate: false };
    },
  } as unknown as GitService;
  const shell = {
    async run() {
      verified += 1;
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, timedOut: false };
    },
  } as unknown as ShellRunner;
  const service = new ProjectPlanService({
    root,
    repoPath: join(root, 'repo'),
    store,
    git,
    shell,
    planner: { provider: { id: 'fake' }, model: 'fake' },
    agents: () => [],
    createTask: async () => {
      throw new Error('not expected');
    },
    pollMs: 60_000,
  });
  return { store, plan, service, merges, counts: () => ({ merged, verified }) };
}

describe('ProjectPlanService integration', () => {
  it('任务成功后集成 root 分支，全部完成后执行 verify 并标记完成', async () => {
    const { store, plan, service, merges, counts } = setup();
    await service.tick();
    const detail = service.get(plan.id);
    service.close();
    store.close();
    expect(detail.items[0]!.status).toBe('done');
    expect(detail.plan.integrationStatus).toBe('completed');
    expect(detail.plan.status).toBe('completed');
    expect(merges).toEqual(['agent/pm/task-1']);
    expect(counts()).toEqual({ merged: 1, verified: 1 });
  });

  it('集成失败时计划失败并保留错误', async () => {
    const { store, plan, service } = setup('', 'merge conflict');
    await service.tick();
    const detail = service.get(plan.id);
    service.close();
    store.close();
    expect(detail.plan.integrationStatus).toBe('failed');
    expect(detail.plan.status).toBe('failed');
    expect(detail.plan.integrationError).toContain('merge conflict');
  });
});
