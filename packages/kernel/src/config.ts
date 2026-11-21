/**
 * 配置与密钥。
 *
 * 密钥只从环境变量或 .spec-agent/secrets.env 读，绝不写进数据库或事件。
 * 这里不做任何"打印配置"的事——要打印先 mask。
 */

import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';

export type EnvVarSpec = {
  required?: boolean;
  default?: string;
  secret?: boolean;
};

export type EnvSpec = Record<string, EnvVarSpec>;

export type EnvSource = Record<string, string | undefined>;

export function loadEnv(spec: EnvSpec, env: EnvSource = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, definition] of Object.entries(spec)) {
    const raw = env[key];
    if (raw !== undefined && raw !== '') {
      out[key] = raw;
      continue;
    }
    if (definition.default !== undefined) {
      out[key] = definition.default;
      continue;
    }
    if (definition.required) missing.push(key);
  }

  if (missing.length > 0) {
    throw new AppError('E_CONFIG_MISSING', `缺少必需的环境变量：${missing.join(', ')}`, {
      details: { missing },
    });
  }
  return out;
}

/** 解析 dotenv 风格文本：支持 # 注释、export 前缀、单双引号。 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    out[key] = value;
  }
  return out;
}

export function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new AppError('E_CONFIG_FILE', `读取密钥文件失败：${path}`, { cause });
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
