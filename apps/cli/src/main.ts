/**
 * spec-agent CLI。
 *
 * M0 只做四件事：初始化、跑一个 spec、看状态、审批。
 * 没有 server，没有 UI；所有状态都在 .spec-agent/spec-agent.db 里。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentId, GateId, TaskId } from '@spec-agent/schema';
import { createRuntime, migrateLegacyProjectData, type SpecAgentRuntime } from '@spec-agent/runtime';
import { AppError } from '@spec-agent/kernel';

const execFileAsync = promisify(execFile);

export type CliIO = {
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = `spec-agent <command>

  init   [--root <dir>]                       初始化 .spec-agent/、repo/、worktrees/
  run    --spec <file> [--root <dir>] [--agent pm] <标题>
  status [--root <dir>] [<taskId>]
  approve <gateId> [--reject <原因>] [--root <dir>]
  cancel  <taskId> [--reason <原因>] [--root <dir>]
  events  <taskId> [--root <dir>]
  recover [--root <dir>]
`;

export async function main(
  argv: string[],
  io: CliIO = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  },
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'init':
        return await init(rest, io);
      case 'run':
        return await run(rest, io);
      case 'status':
        return await status(rest, io);
      case 'approve':
        return await approve(rest, io);
      case 'events':
        return await events(rest, io);
      case 'cancel':
        return await cancel(rest, io);
      case 'recover':
        return await recover(rest, io);
      default:
        io.err(USAGE);
        return 1;
    }
  } catch (error) {
    io.err(formatError(error));
    return 1;
  }
}

async function init(args: string[], io: CliIO): Promise<number> {
  const { options } = parse(args, ['root']);
  const root = options.root ?? process.cwd();
  const repo = join(root, 'repo');

  migrateLegacyProjectData(root);
  mkdirSync(join(root, '.spec-agent'), { recursive: true });
  mkdirSync(join(root, 'worktrees'), { recursive: true });
  mkdirSync(repo, { recursive: true });

  if (!existsSync(join(repo, '.git'))) {
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'spec-agent']);
    await git(repo, ['config', 'user.email', 'spec-agent@localhost']);
    await git(repo, ['config', 'core.autocrlf', 'false']);
    writeFileSync(join(repo, 'README.md'), '# Spec Agent project\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-qm', 'init']);
  }

  io.out(`initialized: ${root}`);
  return 0;
}

async function run(args: string[], io: CliIO): Promise<number> {
  const { options, positional } = parse(args, ['root', 'spec', 'agent', 'model']);
  if (!options.spec) {
    io.err('缺少 --spec <file>');
    return 1;
  }

  const root = options.root ?? process.cwd();
  const runtime = createRuntime({
    root,
    specPath: options.spec,
    model: options.model,
  });

  try {
    await runtime.recover();
    const taskId = runtime.ids.task();
    runtime.engine.dispatch({
      type: 'task.create',
      taskId,
      assignee: (options.agent ?? 'pm') as AgentId,
      caller: null,
      title: positional.join(' ') || '未命名任务',
      brief: '',
    });

    await runtime.engine.runUntilIdle();
    printTask(runtime, taskId, io);
    return runtime.store.getTask(taskId)?.status === 'succeeded' ? 0 : 1;
  } finally {
    runtime.close();
  }
}

async function status(args: string[], io: CliIO): Promise<number> {
  const { options, positional } = parse(args, ['root']);
  const runtime = createRuntime({ root: options.root ?? process.cwd() });
  try {
    const target = positional[0];
    if (target) {
      printTask(runtime, target as TaskId, io);
      return 0;
    }
    const tasks = runtime.store.listTasks(20);
    if (tasks.length === 0) io.out('没有任务');
    for (const task of tasks) {
      io.out(`${task.id}  [${task.status}]  ${task.title}`);
    }
    const pending = runtime.store.listPendingGates();
    if (pending.length > 0) {
      io.out('');
      io.out(`待审批：${pending.length}`);
      for (const gate of pending) {
        io.out(`  ${gate.id}  ${gate.kind}  ${String(gate.payload?.title ?? '')}`);
      }
    }
    return 0;
  } finally {
    runtime.close();
  }
}

async function approve(args: string[], io: CliIO): Promise<number> {
  const { options, positional } = parse(args, ['root', 'reject']);
  const gateId = positional[0];
  if (!gateId) {
    io.err('缺少 gateId');
    return 1;
  }

  const runtime = createRuntime({ root: options.root ?? process.cwd() });
  try {
    await runtime.recover();
    const reject = options.reject;
    runtime.engine.dispatch({
      type: 'gate.decide',
      gateId: gateId as GateId,
      action: reject ? 'reject' : 'approve',
      by: 'user',
      comment: reject,
    });
    await runtime.engine.runUntilIdle();

    const gate = runtime.store.getGate(gateId);
    io.out(`gate ${gateId} -> ${gate?.status ?? 'unknown'}`);
    for (const task of runtime.store.listTasks(20)) {
      printTask(runtime, task.id as TaskId, io);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

async function cancel(args: string[], io: CliIO): Promise<number> {
  const { options, positional } = parse(args, ['root', 'reason']);
  const taskId = positional[0];
  if (!taskId) {
    io.err('缺少 taskId');
    return 1;
  }

  const runtime = createRuntime({ root: options.root ?? process.cwd() });
  try {
    runtime.engine.cancelTask(
      taskId as TaskId,
      options.reason ?? '用户取消',
    );
    const task = runtime.store.getTask(taskId);
    io.out(`task ${taskId} -> ${task?.status ?? 'unknown'}`);
    return 0;
  } finally {
    runtime.close();
  }
}

async function recover(args: string[], io: CliIO): Promise<number> {
  const { options } = parse(args, ['root']);
  const runtime = createRuntime({ root: options.root ?? process.cwd() });
  try {
    const fixed = await runtime.recover();
    io.out(fixed > 0 ? `已恢复 ${fixed} 个节点` : '没有需要恢复的节点');
    return 0;
  } finally {
    runtime.close();
  }
}

async function events(args: string[], io: CliIO): Promise<number> {  const { options, positional } = parse(args, ['root']);
  const taskId = positional[0];
  if (!taskId) {
    io.err('缺少 taskId');
    return 1;
  }
  const runtime = createRuntime({ root: options.root ?? process.cwd() });
  try {
    for (const event of runtime.store.events.read({ taskId })) {
      io.out(`${event.seq}\t${event.type}\t${event.ts}`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

function printTask(runtime: SpecAgentRuntime, taskId: TaskId, io: CliIO): void {
  const task = runtime.store.getTask(taskId);
  if (!task) {
    io.out(`任务不存在：${taskId}`);
    return;
  }
  io.out(`task ${task.id} [${task.status}] ${task.title}`);

  for (const run of runtime.store.listRuns(taskId)) {
    io.out(`  run ${run.id} [${run.status}]`);
    for (const node of runtime.store.listNodeRuns(run.id)) {
      io.out(`    node ${node.nodeId} [${node.status}] attempt=${node.attempt}`);
    }
  }

  const gates = runtime.store
    .listPendingGates()
    .filter((gate) => gate.taskId === taskId);
  for (const gate of gates) {
    io.out(`  pending gate ${gate.id} (${gate.kind}/${gate.ask})`);
  }
}

type ParsedArgs = {
  options: Record<string, string>;
  positional: string[];
};

function parse(args: string[], known: string[]): ParsedArgs {
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (known.includes(name)) {
        const value = args[i + 1];
        if (value !== undefined && !value.startsWith('--')) {
          options[name] = value;
          i += 1;
          continue;
        }
        options[name] = '';
        continue;
      }
    }
    positional.push(arg);
  }
  return { options, positional };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

function formatError(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
