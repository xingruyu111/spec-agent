/**
 * 事件草稿：domain 的输出。
 *
 * domain 不生成 id / ts / actor，也不碰数据库；engine 负责补信封。
 */

import type { EventPayloadMap, EventType, NodeRunId, RunId, TaskId } from '@spec-agent/schema';

export type EventDraft<T extends EventType = EventType> = {
  type: T;
  payload: EventPayloadMap[T];
  taskId?: TaskId;
  runId?: RunId;
  nodeRunId?: NodeRunId;
};

export type AnyDraft = {
  [K in EventType]: EventDraft<K>;
}[EventType];
