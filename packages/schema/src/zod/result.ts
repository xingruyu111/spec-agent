import { z } from 'zod';
import type { ResultStatus, TaskResult } from '../common.js';
import { zArtifactRef, zErrorInfo, zUsage } from './common.js';

export const zResultStatus = z.enum(['ok', 'failed', 'blocked', 'needs_input']);

export const zTaskResult = z.object({
  status: zResultStatus,
  summary: z.string().max(4000, 'summary 不要超过 4000 字，细节放 artifact'),
  artifacts: z.array(zArtifactRef),
  decisions: z.array(z.string()).optional(),
  openIssues: z.array(z.string()).optional(),
  suggestions: z.array(z.string()).optional(),
  error: zErrorInfo.optional(),
  usage: zUsage.optional(),
});

/* ---------------- 漂移检查 ---------------- */

const _status: ResultStatus = {} as z.infer<typeof zResultStatus>;
const _result: TaskResult = {} as z.infer<typeof zTaskResult>;
const _resultBack: z.infer<typeof zTaskResult> = {} as TaskResult;

void [_status, _result, _resultBack];
