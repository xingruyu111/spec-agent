import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { REDACTED, redactString, redactValue } from './redact.js';

describe('redactString', () => {
  it('遮蔽 sk- 开头的 key', () => {
    expect(redactString('key=sk-abcdefghijklmnop1234')).toBe('key=sk-***');
  });

  it('遮蔽 GitHub token', () => {
    expect(redactString('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('ghp_***');
  });

  it('遮蔽 AWS access key', () => {
    expect(redactString('AKIAABCDEFGHIJKLMNOP')).toBe('AKIA***');
  });

  it('遮蔽 Bearer 头', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer ***',
    );
  });

  it('普通文本保持不变', () => {
    expect(redactString('hello world')).toBe('hello world');
  });
});

describe('redactValue', () => {
  it('按字段名遮蔽', () => {
    expect(
      redactValue({
        token: 'abc',
        apiKey: 'def',
        Authorization: 'Bearer x',
        password: 'p',
        normal: 'ok',
      }),
    ).toEqual({
      token: REDACTED,
      apiKey: REDACTED,
      Authorization: REDACTED,
      password: REDACTED,
      normal: 'ok',
    });
  });

  it('递归处理嵌套对象和数组', () => {
    expect(
      redactValue({
        outer: [{ secret: 'x' }, { value: 'sk-abcdefghijklmnop' }],
      }),
    ).toEqual({
      outer: [{ secret: REDACTED }, { value: 'sk-***' }],
    });
  });

  it('保留原始类型', () => {
    expect(redactValue({ n: 1, b: true, nil: null })).toEqual({ n: 1, b: true, nil: null });
  });

  it('循环引用标记为 Circular', () => {
    const source: Record<string, unknown> = { a: 1 };
    source.self = source;
    expect(redactValue(source)).toEqual({ a: 1, self: '[Circular]' });
  });

  it('过深的对象截断', () => {
    let nested: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 9; i += 1) nested = { child: nested };
    const output = JSON.stringify(redactValue(nested));
    expect(output).toContain('[Truncated]');
  });

  it('Date 转 ISO', () => {
    expect(redactValue({ at: new Date(0) })).toEqual({ at: '1970-01-01T00:00:00.000Z' });
  });

  it('Error 转成 ErrorInfo', () => {
    const output = redactValue({ err: new AppError('E_X', '坏了') }) as {
      err: { code: string; message: string };
    };
    expect(output.err.code).toBe('E_X');
    expect(output.err.message).toBe('坏了');
  });

  it('不修改输入', () => {
    const source = { token: 'abc', nested: { value: 'sk-abcdefghijklmnop' } };
    const before = JSON.stringify(source);
    redactValue(source);
    expect(JSON.stringify(source)).toBe(before);
  });
});
