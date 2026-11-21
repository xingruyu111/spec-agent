/**
 * domain 的错误码。语义一旦发布就不再改。
 */

import type { GateId, NodeRunId, RunId, TaskId } from '@spec-agent/schema';
import { AppError } from '@spec-agent/kernel';

export const DomainError = {
  taskExists: (id: TaskId) => new AppError('E_TASK_EXISTS', `任务已存在：${id}`),
  taskNotFound: (id: TaskId) => new AppError('E_TASK_NOT_FOUND', `任务不存在：${id}`),
  taskTerminal: (id: TaskId, status: string) =>
    new AppError('E_TASK_TERMINAL', `任务 ${id} 已终结（${status}）`),
  taskBadState: (id: TaskId, status: string, action: string) =>
    new AppError('E_TASK_BAD_STATE', `任务 ${id} 在 ${status} 状态下不能 ${action}`),

  runExists: (id: RunId) => new AppError('E_RUN_EXISTS', `run 已存在：${id}`),
  runNotFound: (id: RunId) => new AppError('E_RUN_NOT_FOUND', `run 不存在：${id}`),
  runTerminal: (id: RunId, status: string) =>
    new AppError('E_RUN_TERMINAL', `run ${id} 已终结（${status}）`),
  runBadState: (id: RunId, status: string, action: string) =>
    new AppError('E_RUN_BAD_STATE', `run ${id} 在 ${status} 状态下不能 ${action}`),

  nodeExists: (id: NodeRunId) => new AppError('E_NODE_EXISTS', `节点执行已存在：${id}`),
  nodeNotFound: (id: NodeRunId) => new AppError('E_NODE_NOT_FOUND', `节点执行不存在：${id}`),
  nodeTerminal: (id: NodeRunId, status: string) =>
    new AppError('E_NODE_TERMINAL', `节点 ${id} 已终结（${status}）`),
  nodeBadState: (id: NodeRunId, status: string, action: string) =>
    new AppError('E_NODE_BAD_STATE', `节点 ${id} 在 ${status} 状态下不能 ${action}`),

  gateExists: (id: GateId) => new AppError('E_GATE_EXISTS', `闸门已存在：${id}`),
  gateNotFound: (id: GateId) => new AppError('E_GATE_NOT_FOUND', `闸门不存在：${id}`),
  gateNotPending: (id: GateId, status: string) =>
    new AppError('E_GATE_NOT_PENDING', `闸门 ${id} 不是 pending（${status}）`),
  gateRejectNeedsReason: (id: GateId) =>
    new AppError('E_GATE_REJECT_REASON', `闸门 ${id} 打回必须写原因`),
  gateActorMissing: (id: GateId) =>
    new AppError('E_GATE_ACTOR_MISSING', `闸门 ${id} 的决策必须记录决策者`),
};
