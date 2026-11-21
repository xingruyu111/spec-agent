/**
 * Hive HTTP server。
 *
 * 只做三件事：读任务/节点/闸门、审批、托管前端静态文件。
 * 没有 websocket；前端轮询。当前阶段够用，也少一层状态同步的坑。
 */

import { execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentConfig,
  AgentId,
  GateId,
  LlmNode,
  NodeId,
  TaskId,
  WorkflowSpec,
} from '@spec-agent/schema';
import { zWorkflowSpec } from '@spec-agent/schema';
import type { AgentRuntime, GateRow, ProviderConfig, TaskRow } from '@spec-agent/core';
import { GitCli, ShellCli, specHash, commitTrailer } from '@spec-agent/core';
import {
  agentsPath,
  assistText,
  createRuntime,
  loadAgents,
  parseAgents,
  planWorkflowWithUsage,
  PLAN_GATE_ID,
  saveAgents,
  type AiAssistKind,
  type SpecAgentRuntime,
  type PlannerLimits,
} from '@spec-agent/runtime';
import { ChatRepository, type ChatMode, type ChatPermissionMode } from '../chat/chat-store.js';
import { ChatService, type ChatTaskCreator, type PlannedTask } from '../chat/chat.js';
import { DshChatEngine, type ChatEngine } from '../dsh/dsh-chat.js';
import { ProjectPlanService } from '../chat/project-plans.js';
import type { ProjectPlanDetail } from '../chat/project-plans.js';
import { WorkStore, type WorkItemState } from '../work/work-store.js';
import { WorkService } from '../work/work-service.js';
import { WorkExecutor } from '../work/work-executor.js';
import { WorkTriage } from '../work/work-triage.js';
import { ContextAssembler } from '../infra/context-assembler.js';
import { WorkMemoryStore, WorkMemoryWriter } from '../work/work-memory.js';
import { PrivateAssistant } from '../assistant/private-assistant.js';
import { WorkPlanner } from '../work/work-planner.js';
import {
  OutboxWorker,
  createOutboxTransport,
} from '../work/outbox-worker.js';
import { api } from './task-routes.js';
import { createTaskForGoal, executePlannedTask, planTaskForGoal } from './task-plans.js';
import { normalizeGitHubPayload } from '../integrations/github-source.js';
import { createEmbeddingProvider } from '../infra/embeddings.js';
import { MemoryJanitor } from '../work/memory-janitor.js';
import { diffLines } from '../infra/line-diff.js';
import {
  sourceSecret,
  verifySourceSignature,
} from '../integrations/source-signature.js';
import { AppError } from '@spec-agent/kernel';
import {
  createNotificationService,
  type NotificationOptions,
} from '../integrations/notifications.js';
import { handleLlmProxy } from '../infra/llm-proxy.js';
import {
  formatChecks,
  preflightRoot,
  validateServerConfig,
  type PreflightResult,
} from '../infra/preflight.js';
import {
  defaultProviderFile,
  loadProviderFile,
  providerFromEnvironment,
  publicProviderSettings,
  saveProviderFile,
  validateProviderInput,
  validateProviderRegistryInput,
  type ProviderFileData,
  type ProviderSettings,
} from '../infra/provider-config.js';
import {
  collectProjectMetrics,
  createHttpMetrics,
  recordHttp,
  renderPrometheus,
  type HttpMetrics,
} from '../infra/metrics.js';

export type TaskRouteIo = {
  json: (response: ServerResponse, status: number, body: unknown) => void;
  readJson: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  readRawBody: (request: IncomingMessage) => Promise<string>;
};

import { assertProjects, loadProjectsFile, projectErrorStatus, saveProjectsFile } from '../projects/registry.js';
import type { ProjectConfig } from '../projects/types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
};

export type ImportedFile = { path: string; data: Buffer };
const MAX_IMPORT_FILES = 2000;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export function serveStatic(webDist: string, path: string, response: ServerResponse): void {
  const relative = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
  let target = resolve(webDist, relative);
  if (!target.startsWith(webDist + sep) && target !== webDist) {
    json(response, 403, { error: { code: 'E_FORBIDDEN', message: path } });
    return;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = join(webDist, 'index.html');
  }
  if (!existsSync(target)) {
    json(response, 404, { error: { code: 'E_NOT_FOUND', message: path } });
    return;
  }
  const isHtml = target.endsWith('.html');
  response.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': isHtml
      ? 'no-store, no-cache, must-revalidate'
      : 'public, max-age=31536000, immutable',
  });
  createReadStream(target).pipe(response);
}

export async function readRawBody(request: IncomingMessage): Promise<string> {
  const maxBytes = 1024 * 1024;
  const declared = Number(request.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError('E_BODY_TOO_LARGE', '请求体过大（上限 1MB）');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new AppError('E_BODY_TOO_LARGE', '请求体过大（上限 1MB）');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(request);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AppError('E_BAD_JSON', '请求体不是合法 JSON');
  }
}

export function safeImportPath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!path) return null;
  if (path.length > 1000 || path.includes('\0')) {
    throw new AppError('E_IMPORT_INVALID', '导入文件路径不合法');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '..')) {
    throw new AppError('E_IMPORT_INVALID', `导入文件路径不合法：${raw}`);
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new AppError('E_IMPORT_INVALID', '导入文件不能使用绝对路径');
  }
  if (['.git', '.spec-agent', 'node_modules'].includes(segments[0]!)) return null;
  return segments.join('/');
}

export function writeImportedFiles(repo: string, files: ImportedFile[]): void {
  if (files.length > MAX_IMPORT_FILES) {
    throw new AppError(
      'E_IMPORT_INVALID',
      `文件过多：${files.length}，最多 ${MAX_IMPORT_FILES} 个`,
    );
  }

  const root = resolve(repo);
  const base = root + sep;
  for (const file of files) {
    const relative = safeImportPath(file.path);
    if (!relative) continue;
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(base)) {
      throw new AppError('E_IMPORT_INVALID', `导入路径越界：${file.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
}

export async function readMultipart(
  request: IncomingMessage,
): Promise<{ fields: Map<string, string>; files: ImportedFile[] }> {
  const contentType = String(request.headers['content-type'] ?? '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]?.trim();
  if (!boundary) {
    throw new AppError('E_IMPORT_INVALID', '导入请求必须是 multipart/form-data');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_IMPORT_BYTES) {
      throw new AppError('E_BODY_TOO_LARGE', '导入内容过大（上限 64MB）');
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  const files: ImportedFile[] = [];
  let offset = 0;

  while (offset < body.length) {
    const start = body.indexOf(delimiter, offset);
    if (start < 0) break;
    let cursor = start + delimiter.length;
    if (body.subarray(cursor, cursor + 2).toString() === '--') break;
    if (body.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;

    const next = body.indexOf(delimiter, cursor);
    if (next < 0) break;
    let end = next;
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2;

    const part = body.subarray(cursor, end);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const data = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headers);
      const filenameMatch = /filename="([^"]*)"/i.exec(headers);
      if (nameMatch) {
        if (filenameMatch) {
          files.push({
            path: filenameMatch[1]!,
            data: Buffer.from(data),
          });
          if (files.length > MAX_IMPORT_FILES) {
            throw new AppError(
              'E_IMPORT_INVALID',
              `文件过多，最多 ${MAX_IMPORT_FILES} 个`,
            );
          }
        } else {
          fields.set(nameMatch[1]!, data.toString('utf8'));
        }
      }
    }
    offset = next;
  }

  return { fields, files };
}

export async function nativePickFolder(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dialog.Description = '选择 Hive 项目文件夹'",
        '$dialog.ShowNewFolderButton = $true',
        '$result = $dialog.ShowDialog()',
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
      ].join('; ');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', script],
        { timeout: 300_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return String(stdout).trim() || null;
    }

    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "选择 Hive 项目文件夹")'],
        { timeout: 300_000, maxBuffer: 1024 * 1024 },
      );
      return String(stdout).trim() || null;
    }

    const { stdout } = await execFileAsync(
      'zenity',
      ['--file-selection', '--directory', '--title=选择 Hive 项目文件夹'],
      { timeout: 300_000, maxBuffer: 1024 * 1024 },
    );
    return String(stdout).trim() || null;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 1 || error.code === '1')
    ) {
      return null;
    }
    throw new AppError(
      'E_FOLDER_PICKER',
      '无法打开系统文件夹选择器；请确认 server 运行在有图形界面的本机',
      { cause: error },
    );
  }
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function cors(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-spec-agent-project',
  };
}

export function applySecurityHeaders(response: ServerResponse, path: string): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (!path.startsWith('/api/')) {
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'self'",
    );
  }
}



