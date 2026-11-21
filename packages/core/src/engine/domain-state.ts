/**
 * 把 store 的投影适配成 domain 需要的状态端口。
 *
 * 这一层属于 runtime 的职责雏形；放在 engine 里是因为目前只有 engine 用它。
 */

import type { ArtifactRef, GateId, NodeId, NodeRunId, RunId, TaskId } from '@spec-agent/schema';
import type { DomainState } from '../domain/index.js';
import type { Store } from '../store/store.js';

export function createDomainState(store: Store): DomainState {
  return {
    task(id) {
      const row = store.getTask(id);
      return row
        ? {
            id: row.id as TaskId,
            parentTaskId: row.parentId as TaskId | null,
            assignee: row.assignee,
            status: row.status,
          }
        : undefined;
    },
    run(id) {
      const row = store.getRun(id);
      return row
        ? { id: row.id as RunId, taskId: row.taskId as TaskId, status: row.status }
        : undefined;
    },
    nodeRun(id) {
      const row = store.getNodeRun(id);
      if (!row) return undefined;
      const run = store.getRun(row.runId);
      return {
        id: row.id as NodeRunId,
        runId: row.runId as RunId,
        taskId: (run?.taskId ?? '') as TaskId,
        nodeId: row.nodeId as NodeId,
        status: row.status,
        attempt: row.attempt,
        outputs: (row.outputs ?? []) as ArtifactRef[],
      };
    },
    gate(id) {
      const row = store.getGate(id);
      return row
        ? {
            id: row.id as GateId,
            status: row.status,
            taskId: row.taskId as TaskId | null,
            nodeRunId: row.nodeRunId as NodeRunId | null,
          }
        : undefined;
    },
    childTasks(id) {
      return store.listChildTasks(id).map((row) => row.id as TaskId);
    },
  };
}
