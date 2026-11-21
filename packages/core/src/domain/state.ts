/**
 * domain 需要的状态端口。
 *
 * 生产实现由 store 适配；测试实现是一个 Map。
 * 刻意只暴露判断转移必需的方法，避免 domain 顺手查别的表。
 */

import type { GateId, NodeRunId, RunId, TaskId } from '@spec-agent/schema';
import type { GateSnapshot, NodeSnapshot, RunSnapshot, TaskSnapshot } from './snapshots.js';

export interface DomainState {
  task(id: TaskId): TaskSnapshot | undefined;
  run(id: RunId): RunSnapshot | undefined;
  nodeRun(id: NodeRunId): NodeSnapshot | undefined;
  gate(id: GateId): GateSnapshot | undefined;
  /** 直接子任务，用于取消级联 */
  childTasks(id: TaskId): TaskId[];
}
