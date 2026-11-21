/**
 * 崩溃恢复接线：runtime.recover() 把 running 节点退回 ready 并继续执行。
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { NodeId, NodeRunId, RunId, TaskId, WorkflowSpec } from '@spec-agent/schema';
import { specHash } from '@spec-agent/core';
import { createRuntime } from '@spec-agent/runtime';

const execFileAsync = promisify(execFile);
const T = (s: string) => s as TaskId;
const N = (s: string) => s as NodeId;
const R = (s: string) => s as RunId;
const NR = (s: string) => s as NodeRunId;

const SPEC: WorkflowSpec = {
  name: 'recover',
  version: 1,
  params: [],
  nodes: [
    {
      id: N('work'),
      type: 'shell',
      description: '恢复后执行',
      inputs: [],
      outputs: [],
      run: 'node -e "console.log(1)"',
    },
  ],
  edges: [],
};

async function makeRepo(root: string): Promise<void> {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'spec-agent'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'spec-agent@localhost'], { cwd: root });
  await execFileAsync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# recover\n');
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: root });
}

describe('runtime 恢复', () => {
  it('把 running 节点捡回来并继续执行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-recover-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    await makeRepo(repo);

    try {
      const first = createRuntime({ root });
      first.store.saveSpec(specHash(SPEC), SPEC);
      first.engine.dispatch({
        type: 'task.create',
        taskId: T('task_01'),
        assignee: 'pm' as never,
        caller: null,
        title: '恢复测试',
        brief: '',
      });
      first.engine.dispatch({
        type: 'task.claim',
        taskId: T('task_01'),
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      first.engine.dispatch({
        type: 'run.start',
        runId: R('run_01'),
        taskId: T('task_01'),
        specId: specHash(SPEC),
        params: {},
      });
      first.engine.dispatch({
        type: 'node.ready',
        taskId: T('task_01'),
        runId: R('run_01'),
        nodeRunId: NR('nrun_01'),
        nodeId: N('work'),
      });
      first.engine.dispatch({
        type: 'node.start',
        taskId: T('task_01'),
        runId: R('run_01'),
        nodeRunId: NR('nrun_01'),
        nodeId: N('work'),
      });
      expect(first.store.getNodeRun('nrun_01')?.status).toBe('running');
      first.close();

      const second = createRuntime({ root });
      try {
        const fixed = await second.recover();
        expect(fixed).toBe(1);
        expect(second.store.getTask('task_01')?.status).toBe('succeeded');
        expect(second.store.getNodeRun('nrun_01')?.status).toBe('succeeded');
      } finally {
        second.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('verifying 节点有 pending 闸门时恢复成 waiting_gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-recover-gate-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    await makeRepo(repo);

    try {
      const first = createRuntime({ root });
      first.store.saveSpec(specHash(SPEC), SPEC);
      first.engine.dispatch({
        type: 'task.create',
        taskId: T('task_gate'),
        assignee: 'pm' as never,
        caller: null,
        title: '恢复闸门',
        brief: '',
      });
      first.engine.dispatch({
        type: 'task.claim',
        taskId: T('task_gate'),
        leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      });
      first.engine.dispatch({
        type: 'run.start',
        runId: R('run_gate'),
        taskId: T('task_gate'),
        specId: specHash(SPEC),
        params: {},
      });
      first.engine.dispatch({
        type: 'node.ready',
        taskId: T('task_gate'),
        runId: R('run_gate'),
        nodeRunId: NR('nrun_gate'),
        nodeId: N('work'),
      });
      first.engine.dispatch({
        type: 'node.start',
        taskId: T('task_gate'),
        runId: R('run_gate'),
        nodeRunId: NR('nrun_gate'),
        nodeId: N('work'),
      });
      first.engine.dispatch({
        type: 'node.produced',
        taskId: T('task_gate'),
        runId: R('run_gate'),
        nodeRunId: NR('nrun_gate'),
        nodeId: N('work'),
        outputs: [],
        usage: { usd: 0 },
      });
      first.engine.dispatch({
        type: 'gate.request',
        gateId: 'gate_recover' as never,
        taskId: T('task_gate'),
        nodeRunId: NR('nrun_gate'),
        kind: 'human',
        ask: 'approve',
        attempt: 1,
        payload: { title: '恢复', summary: '等待审批' },
      });
      expect(first.store.getNodeRun('nrun_gate')?.status).toBe('verifying');
      first.close();

      const second = createRuntime({ root });
      try {
        expect(await second.recover()).toBe(1);
        expect(second.store.getNodeRun('nrun_gate')?.status).toBe('waiting_gate');
        expect(second.store.listPendingGates()).toHaveLength(1);
      } finally {
        second.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
