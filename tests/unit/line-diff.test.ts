import { describe, expect, it } from 'vitest';
import { diffLines } from '../../apps/server/src/infra/line-diff.js';

describe('diffLines', () => {
  it('标记新增、删除和上下文行', () => {
    const lines = diffLines('A\nB\nC', 'A\nD\nC');
    expect(lines).toEqual([
      { type: 'context', text: 'A' },
      { type: 'remove', text: 'B' },
      { type: 'add', text: 'D' },
      { type: 'context', text: 'C' },
    ]);
  });
});
