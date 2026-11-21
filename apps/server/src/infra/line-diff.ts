/**
 * 简单行级 diff。用于记忆版本对比；不引入外部依赖。
 */

export type DiffLine = {
  type: 'context' | 'add' | 'remove';
  text: string;
};

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split('\n').slice(0, 500);
  const right = after.split('\n').slice(0, 500);
  const rows = left.length;
  const cols = right.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    Array<number>(cols + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      lines.push({ type: 'context', text: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ type: 'remove', text: left[i]! });
      i += 1;
    } else {
      lines.push({ type: 'add', text: right[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    lines.push({ type: 'remove', text: left[i]! });
    i += 1;
  }
  while (j < cols) {
    lines.push({ type: 'add', text: right[j]! });
    j += 1;
  }
  return lines;
}
