/**
 * DSH AgentRuntime adapter.
 *
 * Workflow nodes and planner calls use the same runtime contract as before,
 * but each run is executed by a DeepSeek Harness session. The adapter maps
 * Hive's system prompt/task/tools onto a DSH session and maps session events
 * back to AgentRuntimeOutput (text, artifacts, usage, stop reason).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DeepSeekHarness,
  type HarnessNotification,
  type RunResult,
} from '@deepseek-ai/dsh-sdk-client';
import { artifactKindForPath } from '@spec-agent/core';
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
  AgentToolEvent,
} from '@spec-agent/core';
import type { ArtifactRef, Usage } from '@spec-agent/schema';
import { AppError, toErrorInfo } from '@spec-agent/kernel';
import {
  dshChatRouteId,
  dshProviderPatchYaml,
} from './dsh-chat.js';
import { prepareMcpToolsPatch } from './mcp-profile.js';
import { permissionPatchYaml } from './permission-patch.js';

const execFileAsync = promisify(execFile);

type HarnessEntry = {
  harness: DeepSeekHarness;
  loadedSessions: Set<string>;
  permission: 'read-only' | 'workspace-write' | 'danger-full-access';
};

export type DshAgentRuntimeOptions = {
  dshBin?: string;
  dshHomeRoot?: (cwd: string) => string;
  timeoutMs?: number;
  mcpToolsScript?: string;
  mcpServerUrl?: string;
  createHarness?: (options: ConstructorParameters<typeof DeepSeekHarness>[0]) => DeepSeekHarness;
};

export class DshAgentRuntime implements AgentRuntime {
  readonly id = 'dsh-agent-sdk';
  private readonly harnesses = new Map<string, HarnessEntry>();
  private readonly require = createRequire(import.meta.url);
  private closed = false;

  constructor(private readonly options: DshAgentRuntimeOptions = {}) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    if (this.closed) {
      return failure('E_RUNTIME_CLOSED', 'DSH AgentRuntime 已关闭');
    }
    if (input.signal.aborted) {
      return {
        outputs: [],
        transcriptRef: '',
        usage: { usd: 0 },
        stopReason: 'aborted',
      };
    }
    let entry: HarnessEntry;
    try {
      entry = await this.ensureHarness(input);
    } catch (cause) {
      return failure(
        'E_AGENT_RUNTIME',
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    let sessionId = input.resumeSessionId ?? '';
    let session;
    if (sessionId && entry.loadedSessions.has(sessionId)) {
      session = entry.harness.session(sessionId);
    } else if (sessionId) {
      try {
        session = await entry.harness.resumeSession(sessionId);
        entry.loadedSessions.add(sessionId);
      } catch {
        session = entry.harness.session();
        sessionId = session.id;
      }
    } else {
      session = entry.harness.session();
      sessionId = session.id;
    }

    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const runPromise = session.run(buildPrompt(input));
      let result: RunResult;
      try {
        result = await Promise.race([
          runPromise,
          new Promise<never>((_, reject) => {
            abort.signal.addEventListener(
              'abort',
              () => reject(new AppError('E_AGENT_ABORTED', 'Agent 运行已取消')),
              { once: true },
            );
          }),
        ]);
      } catch (cause) {
        if (abort.signal.aborted) {
          entry.loadedSessions.delete(sessionId);
          await entry.harness.close().catch(() => undefined);
          this.harnesses.delete(
            harnessKey(input, entry.permission, this.options.dshHomeRoot),
          );
          return {
            outputs: [],
            transcriptRef: sessionId,
            usage: { usd: 0 },
            stopReason: 'aborted',
          };
        }
        throw cause;
      }

      entry.loadedSessions.add(result.sessionId);
      const text = result.finalResponse?.trim() || extractFinalText(result.events);
      const usage = extractUsage(result.events);
      const stopReason = mapStopReason(result.events, abort.signal.aborted);
      const eventError = extractEventError(result.events);
      if (process.env.SPEC_AGENT_DEBUG_DSH === '1' && stopReason === 'failed') {
        console.error(
          '[dsh-agent] failed events:',
          JSON.stringify(result.events.slice(-8)).slice(0, 8000),
        );
      }
      if (eventError && stopReason === 'failed') {
        return {
          outputs: await collectGitArtifacts(input.cwd),
          text,
          transcriptRef: result.sessionId,
          usage,
          stopReason: 'failed',
          error: eventError,
        };
      }
      this.emitToolEvents(result.events, input.onToolEvent);
      return {
        outputs: await collectGitArtifacts(input.cwd),
        ...(text ? { text } : {}),
        transcriptRef: result.sessionId,
        usage,
        stopReason,
      };
    } catch (cause) {
      return failure(
        cause instanceof AppError
          ? cause.code
          : 'E_AGENT_RUNTIME',
        cause instanceof Error ? cause.message : String(cause),
        sessionId,
      );
    } finally {
      input.signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.harnesses.values()];
    this.harnesses.clear();
    await Promise.all(entries.map((entry) => entry.harness.close()));
  }

  private async ensureHarness(input: AgentRuntimeInput): Promise<HarnessEntry> {
    const permission = input.permissionMode
      ? input.permissionMode
      : needsWrite(input.allowedTools)
        ? 'workspace-write'
        : 'read-only';
    const key = harnessKey(input, permission, this.options.dshHomeRoot);
    const existing = this.harnesses.get(key);
    if (existing) return existing;

    const dshBin = this.options.dshBin ?? resolveDshBin(this.require);
    if (!dshBin) {
      throw new AppError(
        'E_DSH_NOT_INSTALLED',
        '找不到 @deepseek-ai/dsh 的 lib/bin.js，请安装 server 依赖',
      );
    }
    const provider = input.provider;
    const token = provider.authToken;
    if (!token) {
      throw new AppError('E_AGENT_PROVIDER', 'DSH Agent 需要配置 provider.authToken');
    }
    const model = provider.modelAliases?.[input.model] ?? input.model;
    const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
    const routeId = dshChatRouteId(provider.id, fingerprint);
    const homeBase =
      this.options.dshHomeRoot?.(input.cwd) ??
      join(tmpdir(), 'spec-agent-dsh-agent', fingerprint);
    const workspaceKey = createHash('sha256')
      .update(resolve(input.cwd))
      .digest('hex')
      .slice(0, 8);
    const dshHome = join(homeBase, workspaceKey);
    mkdirSync(dshHome, { recursive: true });
    const patchPath = join(dshHome, `${routeId}.patch.yml`);
    writeFileSync(
      patchPath,
      dshProviderPatchYaml(routeId, provider, model),
      'utf8',
    );
    const approvalPatchPath = join(dshHome, `${routeId}.approval.patch.yml`);
    writeFileSync(approvalPatchPath, permissionPatchYaml, 'utf8');

    const orgRoot =
      input.workspaceRoot ??
      (basename(resolve(input.cwd)) === 'repo'
        ? dirname(resolve(input.cwd))
        : resolve(input.cwd));
    const mcpPatchPath = prepareMcpToolsPatch(
      dshHome,
      this.options.mcpToolsScript ??
        fileURLToPath(new URL('../../mcp/spec-agent-tools.mjs', import.meta.url)),
      orgRoot,
      basename(orgRoot),
      this.options.mcpServerUrl ??
        process.env.SPEC_AGENT_SERVER_URL ??
        'http://127.0.0.1:4317',
    );
    const patches = [
      patchPath,
      approvalPatchPath,
      ...(mcpPatchPath ? [mcpPatchPath] : []),
    ];

    const harness: DeepSeekHarness = this.options.createHarness
      ? this.options.createHarness({
          profile: 'sdk',
          dshBin,
          dshHome,
          cwd: input.cwd,
          patches,
          provider: routeId,
          model,
          env: {
            ...process.env,
            DSH_PERMISSION_MODE: permission,
            SPEC_AGENT_CHAT_API_KEY: token,
          },
          initializeTimeoutMs: 60_000,
          requestTimeoutMs: this.options.timeoutMs ?? 600_000,
          shutdownTimeoutMs: 2_000,
        })
      : new DeepSeekHarness({
          profile: 'sdk',
          dshBin,
          dshHome,
          cwd: input.cwd,
          patches,
          provider: routeId,
          model,
          env: {
            ...process.env,
            DSH_PERMISSION_MODE: permission,
            SPEC_AGENT_CHAT_API_KEY: token,
          },
          initializeTimeoutMs: 60_000,
          requestTimeoutMs: this.options.timeoutMs ?? 600_000,
          shutdownTimeoutMs: 2_000,
        });
    const entry: HarnessEntry = { harness, loadedSessions: new Set(), permission };
    this.harnesses.set(key, entry);
    return entry;
  }

  private emitToolEvents(
    events: RunResult['events'],
    onEvent?: (event: AgentToolEvent) => void,
  ): void {
    if (!onEvent) return;
    const names = new Map<string, string>();
    for (const event of events as Array<{
      type?: string;
      data?: Record<string, unknown>;
    }>) {
      if (event.type === 'tool/call') {
        const id = String(event.data?.callId ?? '');
        const name = String(event.data?.name ?? 'tool');
        names.set(id, name);
        try {
          onEvent({
            phase: 'call',
            toolUseId: id,
            tool: name,
            inputPreview: preview(event.data?.arguments),
          });
        } catch {
          // Observability callbacks must not break the run.
        }
      } else if (event.type === 'tool/result') {
        const id = String(event.data?.callId ?? '');
        const result = event.data?.message as
          | { content?: unknown; isError?: boolean }
          | undefined;
        try {
          onEvent({
            phase: 'result',
            toolUseId: id,
            tool: names.get(id) ?? 'tool',
            outputPreview: preview(result?.content),
            ok: !result?.isError,
          });
        } catch {
          // Ignore observer failures.
        }
      }
    }
  }
}

function failure(
  code: string,
  message: string,
  transcriptRef = '',
): AgentRuntimeOutput {
  return {
    outputs: [],
    transcriptRef,
    usage: { usd: 0 },
    stopReason: 'failed',
    error: toErrorInfo(new AppError(code, message)),
  };
}

function buildPrompt(input: AgentRuntimeInput): string {
  const skills =
    input.skills.length > 0
      ? input.skills
          .map((skill) => `- ${skill.name}: ${skill.path}`)
          .join('\n')
      : '(无)';
  return [
    '你正在执行 Spec Agent 的一个受控工作流节点。',
    '严格在以下工作目录内工作，不要修改目录外的文件：',
    input.cwd,
    '',
    '系统提示词：',
    input.systemPrompt,
    '',
    '任务：',
    input.task,
    '',
    `允许使用的工具：${input.allowedTools.join(', ') || '(只读问答)'}`,
    `可用技能：\n${skills}`,
    '',
    '完成后输出简洁的最终结果；需要落盘的产物直接写入工作目录。',
    '不要声称执行了未执行的命令；不要创建或审批任务。',
  ].join('\n');
}

function needsWrite(tools: string[]): boolean {
  return tools.some((tool) =>
    /write|edit|shell|bash|command|apply_patch|multi_edit/i.test(tool),
  );
}

function harnessKey(
  input: AgentRuntimeInput,
  permission: string,
  homeRoot?: (cwd: string) => string,
): string {
  const token = input.provider.authToken ?? '';
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
  return [
    resolve(input.cwd),
    input.provider.id,
    input.provider.baseUrl ?? '',
    fingerprint,
    input.model,
    permission,
    homeRoot?.(input.cwd) ?? '',
  ].join('::');
}

function extractFinalText(events: RunResult['events']): string {
  let text = '';
  for (const event of events as Array<{
    type?: string;
    data?: { message?: { content?: Array<{ type?: string; text?: string }> } };
  }>) {
    if (event.type !== 'assistant/message') continue;
    const next = (event.data?.message?.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    if (next.trim()) text = next.trim();
  }
  return text;
}

function extractUsage(events: RunResult['events']): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  for (const event of events as Array<{
    type?: string;
    data?: { usage?: { inputTokens?: number; outputTokens?: number } };
  }>) {
    if (event.type !== 'assistant/message' || !event.data?.usage) continue;
    found = true;
    inputTokens += Number(event.data.usage.inputTokens ?? 0);
    outputTokens += Number(event.data.usage.outputTokens ?? 0);
  }
  return {
    usd: 0,
    ...(found ? { inputTokens, outputTokens } : {}),
  };
}

function mapStopReason(
  events: RunResult['events'],
  aborted: boolean,
): AgentRuntimeOutput['stopReason'] {
  if (aborted) return 'aborted';
  const last = [...(events as Array<{ type?: string; data?: { reason?: { kind?: string } } }>)]
    .reverse()
    .find((event) => event.type === 'turn/end');
  const kind = last?.data?.reason?.kind;
  if (kind === 'completed') return 'finished';
  if (kind === 'aborted') return 'aborted';
  if (kind === 'error') return 'failed';
  return kind ? 'failed' : 'finished';
}

function extractEventError(
  events: RunResult['events'],
): ReturnType<typeof toErrorInfo> | undefined {
  for (const event of events as Array<{
    type?: string;
    data?: {
      reason?: {
        kind?: string;
        error?: { message?: string; code?: string };
      };
    };
  }>) {
    if (event.type !== 'turn/end') continue;
    const error = event.data?.reason?.error;
    if (!error) continue;
    return {
      code: error.code ?? 'E_AGENT_RUNTIME',
      message: error.message ?? 'DSH Agent 运行失败',
    };
  }
  return undefined;
}

async function collectGitArtifacts(cwd: string): Promise<ArtifactRef[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, windowsHide: true },
    );
    return String(stdout)
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
      .map((path) => ({
        name: basename(path),
        kind: artifactKindForPath(path),
        path,
      }));
  } catch {
    return [];
  }
}

function preview(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断）` : text;
  } catch {
    return String(value).slice(0, 4000);
  }
}

function resolveDshBin(require: NodeJS.Require): string | undefined {
  try {
    const packagePath = require.resolve('@deepseek-ai/dsh/package.json');
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.dsh;
    return bin ? resolve(dirname(packagePath), bin) : undefined;
  } catch {
    return undefined;
  }
}


