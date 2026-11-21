import { describe, expect, it } from 'vitest';
import { COMMIT_TRAILERS, commitTrailer } from '@spec-agent/core';

describe('Spec Agent commit trailers', () => {
  it('新提交使用 Spec-Agent，同时可读取历史 Hive trailer', () => {
    expect(COMMIT_TRAILERS).toMatchObject({
      agent: 'Spec-Agent',
      task: 'Spec-Agent-Task',
      node: 'Spec-Agent-Node',
    });
    expect(commitTrailer({ 'Spec-Agent-Task': 'new-task' }, COMMIT_TRAILERS.task)).toBe('new-task');
    expect(commitTrailer({ 'Hive-Task': 'old-task' }, COMMIT_TRAILERS.task)).toBe('old-task');
    expect(commitTrailer({ 'Hive-Agent': 'pm' }, COMMIT_TRAILERS.agent)).toBe('pm');
    expect(commitTrailer({ 'Hive-Node': 'build' }, COMMIT_TRAILERS.node)).toBe('build');
  });
});
