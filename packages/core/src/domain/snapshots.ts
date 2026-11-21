/**
 * 聚合快照：判断状态转移所需的最小信息。
 * 不是读模型；完整字段在 store 的投影表里。
 */

import type {
  ArtifactRef,
  GateId,
  GateStatus,
  NodeId,
  NodeRunId,
  NodeRunStatus,
  RunId,
  RunStatus,
  TaskId,
  TaskStatus,
} from '@spec-agent/schema';

export type TaskSnapshot = {
  id: TaskId;
  parentTaskId: TaskId | null;
  assignee: string;
  status: TaskStatus;
};

export type RunSnapshot = {
  id: RunId;
  taskId: TaskId;
  status: RunStatus;
};

export type NodeSnapshot = {
  id: NodeRunId;
  runId: RunId;
  taskId: TaskId;
  nodeId: NodeId;
  status: NodeRunStatus;
  attempt: number;
  outputs: ArtifactRef[];
};

export type GateSnapshot = {
  id: GateId;
  status: GateStatus;
  taskId: TaskId | null;
  nodeRunId: NodeRunId | null;
};
