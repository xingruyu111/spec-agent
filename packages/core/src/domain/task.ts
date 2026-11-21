/**
 * Task 状态机。
 *
 * 规则：终态不可变；完成/失败只能从活动态发起；取消会级联到所有后代。
 */

import type { GateId, TaskCommand, TaskId, TaskStatus } from '@spec-agent/schema';
import { TERMINAL_TASK_STATUSES } from '@spec-agent/schema';
import type { AnyDraft } from './drafts.js';
import { DomainError } from './errors.js';
import type { DomainState } from './state.js';
import type { TaskSnapshot } from './snapshots.js';

const ACTIVE: readonly TaskStatus[] = [
  'running',
  'waiting_children',
  'waiting_gate',
  'waiting_input',
];

export function decideTask(command: TaskCommand, state: DomainState): AnyDraft[] {
  switch (command.type) {
    case 'task.create': {
      if (state.task(command.taskId)) throw DomainError.taskExists(command.taskId);
      return [
        {
          type: 'task.created',
          taskId: command.taskId,
          payload: {
            assignee: command.assignee,
            caller: command.caller,
            parentTaskId: command.parentTaskId ?? null,
            originNodeRunId: command.originNodeRunId,
            title: command.title,
            brief: command.brief,
            inputs: command.inputs ?? [],
            baseCommit: command.baseCommit,
            branch: command.branch,
            repoPath: command.repoPath,
            plannerUsage: command.planUsage,
          },
        },
      ];
    }

    case 'task.claim': {
      const task = requireTask(state, command.taskId);
      assertNotTerminal(task);
      if (task.status !== 'pending') {
        throw DomainError.taskBadState(task.id, task.status, 'claim');
      }
      return [
        {
          type: 'task.claimed',
          taskId: task.id,
          payload: { leaseUntil: command.leaseUntil },
        },
      ];
    }

    case 'task.wait': {
      const task = requireTask(state, command.taskId);
      assertNotTerminal(task);
      if (task.status !== 'running') {
        throw DomainError.taskBadState(task.id, task.status, 'wait');
      }

      if (command.reason === 'children') {
        return [
          {
            type: 'task.waiting_children',
            taskId: task.id,
            payload: { pending: command.pending ?? [] },
          },
        ];
      }

      if (!command.refId) {
        throw DomainError.taskBadState(task.id, task.status, 'wait without gate id');
      }
      const gateId = command.refId as GateId;
      return command.reason === 'gate'
        ? [
            {
              type: 'task.waiting_gate',
              taskId: task.id,
              payload: { gateId },
            },
          ]
        : [
            {
              type: 'task.waiting_input',
              taskId: task.id,
              payload: { gateId },
            },
          ];
    }

    case 'task.resume': {
      const task = requireTask(state, command.taskId);
      assertNotTerminal(task);
      if (!isWaiting(task.status)) {
        throw DomainError.taskBadState(task.id, task.status, 'resume');
      }
      return [
        {
          type: 'task.resumed',
          taskId: task.id,
          payload: { from: task.status, reason: command.reason },
        },
      ];
    }

    case 'task.finish': {
      const task = requireTask(state, command.taskId);
      assertNotTerminal(task);
      if (!ACTIVE.includes(task.status)) {
        throw DomainError.taskBadState(task.id, task.status, 'finish');
      }
      return [
        {
          type: 'task.finished',
          taskId: task.id,
          payload: { result: command.result },
        },
      ];
    }

    case 'task.fail': {
      const task = requireTask(state, command.taskId);
      assertNotTerminal(task);
      if (!ACTIVE.includes(task.status)) {
        throw DomainError.taskBadState(task.id, task.status, 'fail');
      }
      return [
        {
          type: 'task.failed',
          taskId: task.id,
          payload: { error: command.error, partial: command.partial },
        },
      ];
    }

    case 'task.reopen': {
      const task = requireTask(state, command.taskId);
      if (task.status !== 'failed') {
        throw DomainError.taskBadState(task.id, task.status, 'reopen');
      }
      return [
        {
          type: 'task.reopened',
          taskId: task.id,
          payload: { reason: command.reason },
        },
      ];
    }

    case 'task.cancel': {
      const task = requireTask(state, command.taskId);
      assertNotTerminal(task);
      return [
        {
          type: 'task.cancelled',
          taskId: task.id,
          payload: {
            reason: command.reason,
            cascade: collectDescendants(state, task.id),
          },
        },
      ];
    }
  }
}

function requireTask(state: DomainState, id: TaskId): TaskSnapshot {
  const task = state.task(id);
  if (!task) throw DomainError.taskNotFound(id);
  return task;
}

function assertNotTerminal(task: TaskSnapshot): void {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw DomainError.taskTerminal(task.id, task.status);
  }
}

function isWaiting(
  status: TaskStatus,
): status is 'waiting_children' | 'waiting_gate' | 'waiting_input' {
  return status === 'waiting_children' || status === 'waiting_gate' || status === 'waiting_input';
}

function collectDescendants(state: DomainState, id: TaskId): TaskId[] {
  const out: TaskId[] = [];
  const queue = [...state.childTasks(id)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const child = queue.shift()!;
    if (seen.has(child)) continue;
    seen.add(child);
    out.push(child);
    queue.push(...state.childTasks(child));
  }
  return out;
}
