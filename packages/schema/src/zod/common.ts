/**
 * zod 基础 schema。
 *
 * 约定：id 用 transform 转成 branded string，解析后的对象可以直接当领域类型用。
 * 每个文件末尾都有"双向可赋值"断言，防止 schema 与 interface 漂移。
 */

import { z } from 'zod';
import type {
  AgentId,
  ArtifactId,
  ArtifactKind,
  ArtifactRef,
  ErrorInfo,
  EventId,
  GateId,
  MessageId,
  ModelSelector,
  NodeId,
  NodeRunId,
  RunId,
  TaskId,
  Usage,
} from '../common.js';

function branded<T extends string>(label: string) {
  return z
    .string()
    .min(1, `${label} 不能为空`)
    .transform((v) => v as T);
}

export const zAgentId = branded<AgentId>('agent id');
export const zTaskId = branded<TaskId>('task id');
export const zRunId = branded<RunId>('run id');
export const zNodeRunId = branded<NodeRunId>('node run id');
export const zGateId = branded<GateId>('gate id');
export const zNodeId = branded<NodeId>('node id');
export const zEventId = branded<EventId>('event id');
export const zArtifactId = branded<ArtifactId>('artifact id');
export const zMessageId = branded<MessageId>('message id');

/** ISO 8601，带时区。不做严格校验，避免把合法时间挡在外面。 */
export const zIsoDateTime = z.string().min(10);

/** '20m' / '1h30m' / '90s' / '500ms' */
export const zDuration = z
  .string()
  .regex(/^(\d+(ms|s|m|h|d))+$/, '时长格式应为 20m / 1h30m / 90s');

export const zArtifactKind = z.enum([
  'file',
  'dir',
  'text',
  'json',
  'diff',
  'image',
  'audio',
  'video',
  'binary',
]);

export const zArtifactRef = z.object({
  name: z.string().min(1),
  kind: zArtifactKind,
  path: z.string().optional(),
  commit: z.string().optional(),
  contentHash: z.string().optional(),
  schema: z.string().optional(),
  data: z.unknown().optional(),
  bytes: z.number().int().nonnegative().optional(),
});

export const zUsage = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  usd: z.number().nonnegative(),
});

export const zErrorInfo = z.object({
  code: z.string().min(1),
  message: z.string(),
  detail: z.unknown().optional(),
});

export const zModelSelector = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});

/* ---------------- 漂移检查 ---------------- */

const _artifact: ArtifactRef = {} as z.infer<typeof zArtifactRef>;
const _artifactBack: z.infer<typeof zArtifactRef> = {} as ArtifactRef;
const _usage: Usage = {} as z.infer<typeof zUsage>;
const _usageBack: z.infer<typeof zUsage> = {} as Usage;
const _error: ErrorInfo = {} as z.infer<typeof zErrorInfo>;
const _errorBack: z.infer<typeof zErrorInfo> = {} as ErrorInfo;
const _model: ModelSelector = {} as z.infer<typeof zModelSelector>;
const _modelBack: z.infer<typeof zModelSelector> = {} as ModelSelector;
const _kind: ArtifactKind = {} as z.infer<typeof zArtifactKind>;
const _kindBack: z.infer<typeof zArtifactKind> = {} as ArtifactKind;

void [
  _artifact,
  _artifactBack,
  _usage,
  _usageBack,
  _error,
  _errorBack,
  _model,
  _modelBack,
  _kind,
  _kindBack,
];
