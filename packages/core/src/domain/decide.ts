/**
 * 命令分发：唯一入口。
 *
 * engine 只调这一个函数，不直接构造事件。
 */

import type { Command } from '@spec-agent/schema';
import type { AnyDraft } from './drafts.js';
import { decideTask } from './task.js';
import { decideGate } from './gate.js';
import { decideNode } from './node.js';
import { decideRun } from './run.js';
import type { DomainState } from './state.js';

export function decide(command: Command, state: DomainState): AnyDraft[] {
  switch (command.type) {
    case 'task.create':
    case 'task.claim':
    case 'task.wait':
    case 'task.resume':
    case 'task.finish':
    case 'task.fail':
    case 'task.cancel':
    case 'task.reopen':
      return decideTask(command, state);

    case 'gate.request':
    case 'gate.decide':
    case 'gate.cancel':
      return decideGate(command, state);

    case 'node.ready':
    case 'node.start':
    case 'node.produced':
    case 'node.wait_gate':
    case 'node.complete':
    case 'node.retry':
    case 'node.fail':
    case 'node.skip':
    case 'node.interrupt':
    case 'node.cancel':
    case 'node.reset':
      return decideNode(command, state);

    case 'run.start':
    case 'run.wait':
    case 'run.finish':
    case 'run.fail':
    case 'run.cancel':
    case 'run.reopen':
    case 'run.pause':
    case 'run.resume':
    case 'run.replan':
      return decideRun(command, state);
  }
}
