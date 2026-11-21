/**
 * Gate 状态机。
 *
 * 只有 pending 能决策；打回必须写原因；人审必须记录决策者。
 */

import type { GateCommand } from '@spec-agent/schema';
import type { AnyDraft } from './drafts.js';
import { DomainError } from './errors.js';
import type { DomainState } from './state.js';
import type { GateSnapshot } from './snapshots.js';

export function decideGate(command: GateCommand, state: DomainState): AnyDraft[] {
  switch (command.type) {
    case 'gate.request': {
      if (state.gate(command.gateId)) throw DomainError.gateExists(command.gateId);
      return [
        {
          type: 'gate.requested',
          taskId: command.taskId,
          nodeRunId: command.nodeRunId,
          payload: {
            gateId: command.gateId,
            kind: command.kind,
            ask: command.ask,
            attempt: command.attempt,
            payload: command.payload,
            remindAt: command.remindAt,
            escalateAt: command.escalateAt,
          },
        },
      ];
    }

    case 'gate.decide': {
      const gate = requireGate(state, command.gateId);
      if (gate.status !== 'pending') {
        throw DomainError.gateNotPending(gate.id, gate.status);
      }
      if (!command.by) throw DomainError.gateActorMissing(gate.id);

      if (command.action === 'reject') {
        if (!command.comment) throw DomainError.gateRejectNeedsReason(gate.id);
        return [
          {
            type: 'gate.failed',
            taskId: gate.taskId ?? undefined,
            nodeRunId: gate.nodeRunId ?? undefined,
            payload: {
              gateId: gate.id,
              decision: 'reject',
              by: command.by,
              comment: command.comment,
            },
          },
        ];
      }

      return [
        {
          type: 'gate.passed',
          taskId: gate.taskId ?? undefined,
          nodeRunId: gate.nodeRunId ?? undefined,
          payload: {
            gateId: gate.id,
            decision: command.action,
            by: command.by,
            comment: command.comment,
            content: command.content,
          },
        },
      ];
    }

    case 'gate.cancel': {
      const gate = requireGate(state, command.gateId);
      if (gate.status !== 'pending') {
        throw DomainError.gateNotPending(gate.id, gate.status);
      }
      return [
        {
          type: 'gate.cancelled',
          taskId: gate.taskId ?? undefined,
          nodeRunId: gate.nodeRunId ?? undefined,
          payload: { gateId: gate.id, reason: command.reason },
        },
      ];
    }
  }
}

function requireGate(state: DomainState, id: GateSnapshot['id']): GateSnapshot {
  const gate = state.gate(id);
  if (!gate) throw DomainError.gateNotFound(id);
  return gate;
}
