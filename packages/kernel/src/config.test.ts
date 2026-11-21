import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { loadEnv, loadEnvFile, maskSecret, parseEnvFile } from './config.js';

describe('loadEnv', () => {
  it('读取存在的变量', () => {
    expect(loadEnv({ A: {} }, { A: '1' })).toEqual({ A: '1' });
  });

  it('缺失时用默认值', () => {
    expect(loadEnv({ A: { default: 'd' } }, {})).toEqual({ A: 'd' });
  });

  it('空字符串视为缺失', () => {
    expect(loadEnv({ A: { default: 'd' } }, { A: '' })).toEqual({ A: 'd' });
  });

  it('缺少必需项时报 E_CONFIG_MISSING', () => {
    try {
      loadEnv({ A: { required: true }, B: { required: true } }, {});
      expect.unreachable('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('E_CONFIG_MISSING');
      expect((error as AppError).details).toEqual({ missing: ['A', 'B'] });
    }
  });

  it('非必需且无默认值的变量被跳过', () => {
    expect(loadEnv({ A: {} }, {})).toEqual({});
  });
});

describe('parseEnvFile', () => {
  it('忽略注释和空行，支持 export 与引号', () => {
    const text = [
      '# 注释',
      '',
      'A=1',
      'export B=two',
      'C="three"',
      "D='four'",
      'E=',
      'not a pair',
      '=value',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
      D: 'four',
      E: '',
    });
  });

  it('只有一个引号时不当成引号包裹', () => {
    expect(parseEnvFile('A="')).toEqual({ A: '"' });
  });

  it('等号后面的内容原样保留', () => {
    expect(parseEnvFile('A=a=b')).toEqual({ A: 'a=b' });
  });

  it('兼容 CRLF', () => {
    expect(parseEnvFile('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadEnvFile', () => {
  it('读取文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-kernel-'));
    const file = join(dir, 'secrets.env');
    writeFileSync(file, 'TOKEN=abc\n', 'utf8');
    try {
      expect(loadEnvFile(file)).toEqual({ TOKEN: 'abc' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件不存在时报 E_CONFIG_FILE 并保留 cause', () => {
    try {
      loadEnvFile(join(tmpdir(), 'definitely-not-here-12345.env'));
      expect.unreachable('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('E_CONFIG_FILE');
      expect((error as AppError).cause).toBeDefined();
    }
  });
});

describe('maskSecret', () => {
  it('短值全部遮蔽', () => {
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('12345678')).toBe('***');
  });

  it('长值保留首尾', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('sk-1…cdef');
  });
});
