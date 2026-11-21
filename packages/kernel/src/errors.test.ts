import { describe, expect, it } from 'vitest';
import {
  AppError,
  err,
  isAppError,
  isErr,
  isOk,
  ok,
  toErrorInfo,
  unwrap,
  unwrapOr,
} from './errors.js';

describe('AppError', () => {
  it('保留 code / message / details', () => {
    const error = new AppError('E_X', '出错了', { details: { id: 1 } });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('E_X');
    expect(error.message).toBe('出错了');
    expect(error.details).toEqual({ id: 1 });
    expect(error.toJSON()).toEqual({
      code: 'E_X',
      message: '出错了',
      detail: { id: 1 },
    });
  });

  it('没有 details 时 toJSON 不带 detail', () => {
    expect(new AppError('E_X', '出错了').toJSON()).toEqual({
      code: 'E_X',
      message: '出错了',
    });
  });

  it('保留 cause', () => {
    const cause = new Error('底层');
    const error = new AppError('E_X', '包装', { cause });
    expect(error.cause).toBe(cause);
  });

  it('isAppError 只认自己', () => {
    expect(isAppError(new AppError('E_X', 'x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('toErrorInfo', () => {
  it('AppError 用自身序列化', () => {
    expect(toErrorInfo(new AppError('E_X', 'x'))).toEqual({ code: 'E_X', message: 'x' });
  });

  it('普通 Error 带上名字与栈', () => {
    const info = toErrorInfo(new TypeError('坏了'));
    expect(info.code).toBe('E_UNKNOWN');
    expect(info.message).toBe('TypeError: 坏了');
    expect(typeof info.detail).toBe('string');
  });

  it('字符串原样作为 message', () => {
    expect(toErrorInfo('炸了')).toEqual({ code: 'E_UNKNOWN', message: '炸了' });
  });

  it('对象转成 JSON 字符串', () => {
    expect(toErrorInfo({ a: 1 })).toEqual({ code: 'E_UNKNOWN', message: '{"a":1}' });
  });

  it('循环对象不会抛异常', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const info = toErrorInfo(circular);
    expect(info.code).toBe('E_UNKNOWN');
    expect(typeof info.message).toBe('string');
  });

  it('undefined 也能转成字符串', () => {
    expect(toErrorInfo(undefined)).toEqual({ code: 'E_UNKNOWN', message: 'undefined' });
  });
});

describe('Result', () => {
  it('ok / err 的判别', () => {
    const good = ok(1);
    const bad = err(new AppError('E_X', 'x'));
    expect(isOk(good)).toBe(true);
    expect(isErr(good)).toBe(false);
    expect(isOk(bad)).toBe(false);
    expect(isErr(bad)).toBe(true);
  });

  it('unwrap 取出值', () => {
    expect(unwrap(ok('value'))).toBe('value');
  });

  it('unwrap 抛出原始 Error', () => {
    const error = new AppError('E_X', 'x');
    expect(() => unwrap(err(error))).toThrow(error);
  });

  it('unwrap 对非 Error 的失败值包一层 AppError', () => {
    expect(() => unwrap(err('boom'))).toThrowError(/unwrap 失败/);
  });

  it('unwrapOr 给默认值', () => {
    expect(unwrapOr(ok(1), 0)).toBe(1);
    expect(unwrapOr(err(new AppError('E_X', 'x')), 0)).toBe(0);
  });
});
