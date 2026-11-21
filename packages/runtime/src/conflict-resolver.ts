/**
 * 用 Agent 解决 git 合并冲突。
 *
 * 只让它改冲突文件，不允许执行 git 命令；提交仍由 git 包装器完成，
 * 这样合并提交的 trailer 不会被绕过。
 */

import type {
  AgentRuntime,
  ConflictResolver,
  ProviderConfig,
} from '@spec-agent/core';

export type AgentConflictResolverOptions = {
  runtime: AgentRuntime;
  provider: ProviderConfig;
  model: string;
  maxTurns?: number;
  maxUsd?: number;
};

export function createAgentConflictResolver(
  options: AgentConflictResolverOptions,
): ConflictResolver {
  return async ({ worktree, files, attempt }) => {
    const output = await options.runtime.run({
      systemPrompt:
        '你是 git 合并冲突解决器。只解决冲突，不做无关改动，不运行 git 命令。',
      task: [
        `工作区：${worktree}`,
        `有冲突的文件：${files.join(', ')}`,
        `这是第 ${attempt} 次合并尝试。`,
        '读取这些文件，删除 <<<<<<<、=======、>>>>>>> 冲突标记，',
        '保留双方的意图，写出一个可运行的最终版本。',
        '只编辑这些文件；不要提交；完成后回复 DONE。',
      ].join('\n'),
      cwd: worktree,
      allowedTools: ['Read', 'Edit', 'Write'],
      skills: [],
      provider: options.provider,
      model: options.model,
      budget: {
        maxTurns: options.maxTurns ?? 12,
        maxUsd: options.maxUsd ?? 0.5,
      },
      signal: new AbortController().signal,
    });

    return output.stopReason === 'finished';
  };
}
