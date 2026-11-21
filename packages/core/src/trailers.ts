/** Spec Agent Git trailer contract. */

export const COMMIT_TRAILERS = {
  agent: 'Spec-Agent',
  task: 'Spec-Agent-Task',
  node: 'Spec-Agent-Node',
  taskAgent: 'Spec-Agent-Task-Agent',
} as const;

const LEGACY_TRAILERS: Record<string, string> = {
  [COMMIT_TRAILERS.agent]: 'Hive-Agent',
  [COMMIT_TRAILERS.task]: 'Hive-Task',
  [COMMIT_TRAILERS.node]: 'Hive-Node',
  [COMMIT_TRAILERS.taskAgent]: 'Hive-Task-Agent',
};

/** 新代码只写新 trailer；读取时允许历史 Hive 提交。 */
export function commitTrailer(
  trailers: Readonly<Record<string, string>>,
  key: (typeof COMMIT_TRAILERS)[keyof typeof COMMIT_TRAILERS],
): string | undefined {
  return trailers[key] ?? trailers[LEGACY_TRAILERS[key]!];
}
