/**
 * WorkflowRun 状态机。
 *
 * run 只是执行单元；任务的完成与否由 Task 决定，两者不要混。
 */

import type { RunCommand, RunStatus } from '@spec-agent/schema';
import type { AnyDraft } from './drafts.js';
import { DomainError } from './errors.js';
import type { DomainState } from './state.js';
import type { RunSnapshot } from './snapshots.js';

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled'];
const ACTIVE: readonly RunStatus[] = ['running', 'waiting'];

export function decideRun(command: RunCommand, state: DomainState): AnyDraft[] {
  switch (command.type) {
    case 'run.start': {
      if (state.run(command.runId)) throw DomainError.runExists(command.runId);
      return [
        {
          type: 'workflow.run.started',
          taskId: command.taskId,
          runId: command.runId,
          payload: {
            specId: command.specId,
            params: command.params,
            parentRunId: command.parentRunId,
            parentNodeRunId: command.parentNodeRunId,
          },
        },
      ];
    }

    case 'run.wait': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      if (run.status !== 'running') {
        throw DomainError.runBadState(run.id, run.status, 'wait');
      }
      return [
        {
          type: 'workflow.run.waiting',
          taskId: run.taskId,
          runId: run.id,
          payload: { reason: command.reason, refId: command.refId },
        },
      ];
    }

    case 'run.finish': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      if (!ACTIVE.includes(run.status)) {
        throw DomainError.runBadState(run.id, run.status, 'finish');
      }
      return [
        {
          type: 'workflow.run.finished',
          taskId: run.taskId,
          runId: run.id,
          payload: { status: command.status, costUsd: command.costUsd },
        },
      ];
    }

    case 'run.fail': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      if (!ACTIVE.includes(run.status)) {
        throw DomainError.runBadState(run.id, run.status, 'fail');
      }
      return [
        {
          type: 'workflow.run.failed',
          taskId: run.taskId,
          runId: run.id,
          payload: { error: command.error },
        },
      ];
    }

    case 'run.reopen': {
      const run = requireRun(state, command.runId);
      if (run.status !== 'failed') {
        throw DomainError.runBadState(run.id, run.status, 'reopen');
      }
      return [
        {
          type: 'workflow.run.reopened',
          taskId: run.taskId,
          runId: run.id,
          payload: { reason: command.reason },
        },
      ];
    }

    case 'run.cancel': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      return [
        {
          type: 'run.cancelled',
          taskId: run.taskId,
          runId: run.id,
          payload: { reason: command.reason },
        },
      ];
    }

    case 'run.pause': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      return [
        {
          type: 'run.paused',
          taskId: run.taskId,
          runId: run.id,
          payload: { reason: command.reason },
        },
      ];
    }

    case 'run.resume': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      return [
        {
          type: 'run.resumed',
          taskId: run.taskId,
          runId: run.id,
          payload: {},
        },
      ];
    }

    case 'run.replan': {
      const run = requireRun(state, command.runId);
      assertNotTerminal(run);
      if (!ACTIVE.includes(run.status)) {
        throw DomainError.runBadState(run.id, run.status, 'replan');
      }
      return [
        {
          type: 'workflow.run.replanned',
          taskId: run.taskId,
          runId: run.id,
          payload: { specId: command.specId, reason: command.reason },
        },
      ];
    }
  }
}

function requireRun(state: DomainState, id: RunSnapshot['id']): RunSnapshot {
  const run = state.run(id);
  if (!run) throw DomainError.runNotFound(id);
  return run;
}

function assertNotTerminal(run: RunSnapshot): void {
  if (TERMINAL.includes(run.status)) {
    throw DomainError.runTerminal(run.id, run.status);
  }
}
