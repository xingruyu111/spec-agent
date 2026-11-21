/**
 * NodeRun 状态机。
 *
 * 注意：node.failed 表示"彻底失败"；这一次 attempt 失败用 node.retried 表达。
 */

import type { NodeCommand, NodeRunStatus } from '@spec-agent/schema';
import type { AnyDraft } from './drafts.js';
import { DomainError } from './errors.js';
import type { DomainState } from './state.js';
import type { NodeSnapshot } from './snapshots.js';

const TERMINAL: readonly NodeRunStatus[] = ['succeeded', 'failed', 'cancelled', 'skipped'];
const RETRYABLE: readonly NodeRunStatus[] = ['running', 'verifying', 'waiting_gate'];

export function decideNode(command: NodeCommand, state: DomainState): AnyDraft[] {
  switch (command.type) {
    case 'node.ready': {
      if (state.nodeRun(command.nodeRunId)) throw DomainError.nodeExists(command.nodeRunId);
      return [
        {
          type: 'node.ready',
          taskId: command.taskId,
          runId: command.runId,
          nodeRunId: command.nodeRunId,
          payload: { nodeId: command.nodeId },
        },
      ];
    }

    case 'node.start': {
      const node = requireNode(state, command);
      if (node.status !== 'ready') {
        throw DomainError.nodeBadState(node.id, node.status, 'start');
      }
      return [
        {
          type: 'node.started',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: { nodeId: node.nodeId, attempt: node.attempt },
        },
      ];
    }

    case 'node.produced': {
      const node = requireNode(state, command);
      if (node.status !== 'running') {
        throw DomainError.nodeBadState(node.id, node.status, 'produce');
      }
      return [
        {
          type: 'node.verifying',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: {
            nodeId: node.nodeId,
            attempt: node.attempt,
            outputs: command.outputs,
            transcriptRef: command.transcriptRef,
            sessionKey: command.sessionKey,
            sessionCumulativeUsd: command.sessionCumulativeUsd,
            usage: command.usage,
          },
        },
      ];
    }

    case 'node.wait_gate': {
      const node = requireNode(state, command);
      if (node.status !== 'verifying') {
        throw DomainError.nodeBadState(node.id, node.status, 'wait_gate');
      }
      return [
        {
          type: 'node.waiting_gate',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: { nodeId: node.nodeId, gateId: command.gateId },
        },
      ];
    }

    case 'node.complete': {
      const node = requireNode(state, command);
      if (node.status !== 'verifying' && node.status !== 'waiting_gate') {
        throw DomainError.nodeBadState(node.id, node.status, 'complete');
      }
      return [
        {
          type: 'node.finished',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: { nodeId: node.nodeId, outputs: node.outputs },
        },
      ];
    }

    case 'node.retry': {
      const node = requireNode(state, command);
      if (!RETRYABLE.includes(node.status)) {
        throw DomainError.nodeBadState(node.id, node.status, 'retry');
      }
      return [
        {
          type: 'node.retried',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: {
            nodeId: node.nodeId,
            from: node.attempt,
            to: node.attempt + 1,
            reason: command.reason,
          },
        },
      ];
    }

    case 'node.fail': {
      const node = requireNode(state, command);
      if (!RETRYABLE.includes(node.status)) {
        throw DomainError.nodeBadState(node.id, node.status, 'fail');
      }
      return [
        {
          type: 'node.failed',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: {
            nodeId: node.nodeId,
            attempt: node.attempt,
            error: command.error,
            willRetry: false,
          },
        },
      ];
    }

    case 'node.skip': {
      const node = requireNode(state, command);
      if (node.status !== 'pending' && node.status !== 'ready') {
        throw DomainError.nodeBadState(node.id, node.status, 'skip');
      }
      return [
        {
          type: 'node.skipped',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: { nodeId: node.nodeId, reason: command.reason },
        },
      ];
    }

    case 'node.interrupt': {
      const node = requireNode(state, command);
      if (node.status !== 'running' && node.status !== 'verifying') {
        throw DomainError.nodeBadState(node.id, node.status, 'interrupt');
      }
      return [
        {
          type: 'node.interrupted',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: { nodeId: node.nodeId, reason: command.reason },
        },
      ];
    }

    case 'node.reset': {
      const node = requireNode(state, command);
      if (!['failed', 'cancelled', 'skipped'].includes(node.status)) {
        throw DomainError.nodeBadState(node.id, node.status, 'reset');
      }
      return [
        {
          type: 'node.reset',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: {
            nodeId: node.nodeId,
            attempt: node.attempt + 1,
            reason: command.reason,
          },
        },
      ];
    }

    case 'node.cancel': {
      const node = requireNode(state, command);
      if (TERMINAL.includes(node.status)) {
        throw DomainError.nodeTerminal(node.id, node.status);
      }
      return [
        {
          type: 'node.cancelled',
          taskId: node.taskId,
          runId: node.runId,
          nodeRunId: node.id,
          payload: { nodeId: node.nodeId, reason: command.reason },
        },
      ];
    }
  }
}

function requireNode(state: DomainState, command: NodeCommand): NodeSnapshot {
  const node = state.nodeRun(command.nodeRunId);
  if (!node) throw DomainError.nodeNotFound(command.nodeRunId);
  return node;
}
