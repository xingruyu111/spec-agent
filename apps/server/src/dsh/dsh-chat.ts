/**
 * DSH chat runtime.
 *
 * DSH SDK 启动的是完整 Harness 子进程，不是一个无状态的 messages API。
 * 这里把它限制在“项目聊天”边界：每个项目一个 harness，每个 chat session 一个
 * DSH session；Hive 仍然保存消息正文和变更草案。
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderConfig } from '@spec-agent/core';
import {
  DeepSeekHarness,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client';
import { migrateLegacyProjectData } from '@spec-agent/runtime';
import { installDshLiveBridge } from './dsh-live-bridge.js';
import { prepareMcpToolsPatch } from './mcp-profile.js';

export type ChatDelta = {
  kind: 'text' | 'reasoning';
  text: string;
};

export type ChatEngineRunInput = {
  root: string;
  sessionId?: string | null;
  providerId?: string;
  model?: string;
  prompt: string;
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  onStatus?: (status: string) => void;
  onDelta?: (delta: ChatDelta) => void;
};

export type ChatEngineRunResult = {
  sessionId: string;
  text: string;
  reasoning?: string;
};

export type ChatEngine = {
  run(input: ChatEngineRunInput): Promise<ChatEngineRunResult>;
  close(): Promise<void>;
};

type HarnessEntry = {
  harness: DeepSeekHarness;
  loadedSessions: Set<string>;
};

export type DshChatEngineOptions = {
  provider: (providerId?: string) => ProviderConfig;
  model: () => string;
  dshHomeRoot?: (root: string) => string;
  dshBin?: string;
  timeoutMs?: number;
  mcpToolsScript?: string;
};

export class DshChatEngine implements ChatEngine {
  private readonly harnesses = new Map<string, HarnessEntry>();
  private readonly require = createRequire(import.meta.url);

  constructor(private readonly options: DshChatEngineOptions) {}

  async run(input: ChatEngineRunInput): Promise<ChatEngineRunResult> {
    const entry = await this.ensureHarness(
      input.root,
      input.providerId,
      input.model,
      input.permissionMode ?? 'read-only',
    );
    input.onStatus?.('连接 DSH Runtime…');
    let session = entry.loadedSessions.has(input.sessionId ?? '')
      ? entry.harness.session(input.sessionId ?? undefined)
      : null;

    if (!session && input.sessionId) {
      try {
        session = await entry.harness.resumeSession(input.sessionId);
        entry.loadedSessions.add(input.sessionId);
      } catch {
        // Hive DB 里仍有消息；恢复失败时用新 session，继续工作而不是阻断聊天。
        session = entry.harness.session();
      }
    }
    if (!session) session = entry.harness.session();

    const rootSessionId = session.id;
    input.onStatus?.('DSH 正在读取项目上下文…');
    let result;
    try {
      result = await session.run(input.prompt, {
        onNotification: (notification) =>
          this.observe(notification, rootSessionId, input.onStatus, input.onDelta),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DSH chat 失败：${message}`);
    }
    entry.loadedSessions.add(result.sessionId);
    const extracted = extractAssistantParts(result.events);
    const text = result.finalResponse || extracted.text;
    if (!text) {
      console.warn(
        'DSH returned no assistant text',
        JSON.stringify(result.events.slice(-3)).slice(0, 2000),
      );
    }
    return {
      sessionId: result.sessionId,
      text,
      ...(extracted.reasoning ? { reasoning: extracted.reasoning } : {}),
    };
  }

  async close(): Promise<void> {
    const entries = [...this.harnesses.values()];
    this.harnesses.clear();
    await Promise.all(entries.map((entry) => entry.harness.close()));
  }

  private async ensureHarness(
    root: string,
    requestedProvider?: string,
    requestedModel?: string,
    permissionMode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only',
  ): Promise<HarnessEntry> {
    const projectRoot = resolve(root);
    const provider = this.options.provider(requestedProvider);
    const token = provider.authToken;
    if (!token) {
      throw new Error('DSH 聊天需要配置 provider.authToken');
    }
    const routeModel =
      process.env.SPEC_AGENT_DSH_MODEL || requestedModel || this.options.model();
    if (!routeModel) {
      throw new Error('DSH 聊天没有可用模型');
    }
    // 凭证/端点/模型变化必须重建 harness；旧进程会一直保留旧 Key。
    const credentialFingerprint = createHash('sha256')
      .update(token)
      .digest('hex')
      .slice(0, 12);
    const routeId = dshChatRouteId(provider.id, credentialFingerprint);
    const key = [
      projectRoot,
      provider.id,
      routeModel,
      provider.baseUrl ?? '',
      credentialFingerprint,
      permissionMode,
    ].join('::');
    const existing = this.harnesses.get(key);
    if (existing) return existing;
    migrateLegacyProjectData(projectRoot);

    const dshBin = this.options.dshBin ?? resolveDshBin(this.require);
    if (!dshBin || !existsSync(dshBin)) {
      throw new Error(
        'DSH runtime 未安装：找不到 @deepseek-ai/dsh 的 lib/bin.js。请安装 server 依赖。',
      );
    }
    const dshHome =
      this.options.dshHomeRoot?.(projectRoot) ?? join(projectRoot, '.spec-agent', 'dsh');
    mkdirSync(dshHome, { recursive: true });
    const bridge = installDshLiveBridge(dshHome);
    const providerPatch = writeDshProviderPatch(
      dshHome,
      routeId,
      provider,
      routeModel,
    );
    const approvalPatch = join(dshHome, `${routeId}.approval.patch.yml`);
    writeFileSync(
      approvalPatch,
      [
        '# Headless chat: keep the sandbox, do not block on approval prompts.',
        '- id: approval',
        '  config:',
        '    policy: never',
        '',
      ].join('\n'),
      'utf8',
    );
    const mcpPatch = prepareMcpToolsPatch(
      dshHome,
      this.options.mcpToolsScript ??
        fileURLToPath(new URL('../mcp/spec-agent-tools.mjs', import.meta.url)),
      projectRoot,
      basename(projectRoot),
      process.env.SPEC_AGENT_SERVER_URL ?? 'http://127.0.0.1:4317',
    );
    const harness = new DeepSeekHarness({
      profile: 'sdk',
      dshBin,
      dshHome,
      cwd: projectRoot,
      patches: [
        providerPatch,
        approvalPatch,
        ...(bridge.enabled ? [bridge.patchPath] : []),
        ...(mcpPatch ? [mcpPatch] : []),
      ],
      provider: routeId,
      model: routeModel,
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: permissionMode,
        SPEC_AGENT_CHAT_API_KEY: token,
      },
      initializeTimeoutMs: 60_000,
      requestTimeoutMs: this.options.timeoutMs ?? 180_000,
      shutdownTimeoutMs: 2_000,
    });
    const entry = { harness, loadedSessions: new Set<string>() };
    this.harnesses.set(key, entry);
    return entry;
  }

  private observe(
    notification: HarnessNotification,
    rootSessionId: string,
    onStatus?: (status: string) => void,
    onDelta?: (delta: ChatDelta) => void,
  ): void {
    if (notification.method === 'spec-agent.assistant.delta') {
      const params = notification.params as {
        sessionId?: string;
        kind?: string;
        text?: string;
      };
      if (params.sessionId === rootSessionId && typeof params.text === 'string') {
        if (params.kind === 'text' || params.kind === 'reasoning') {
          if (params.text.length > 0) {
            onDelta?.({ kind: params.kind, text: params.text });
          }
        }
      }
      return;
    }
    const params = notification.params as {
      sessionId?: string;
      event?: { type?: string; data?: Record<string, unknown> };
      status?: string;
    };
    const event = params.event;
    if (!onStatus) return;
    if (params.status === 'running') {
      onStatus('DSH 正在处理…');
      return;
    }
    if (!event?.type) return;
    if (event.type === 'turn/start' || event.type === 'step/start') {
      onStatus('DSH 正在思考…');
    } else if (event.type === 'tool/call' || event.type === 'tool/start') {
      const name =
        typeof event.data?.tool === 'string' ? event.data.tool : '工具';
      onStatus(`正在调用 ${name}…`);
    } else if (event.type === 'assistant/message') {
      onStatus('正在整理回复…');
    }
  }
}

/** Extract assistant text and reasoning from DSH events. */
function extractAssistantParts(events: unknown[]): {
  text: string;
  reasoning: string;
} {
  let text = '';
  let reasoning = '';
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as {
      type?: string;
      data?: {
        message?: {
          content?: Array<{ type?: string; text?: string }>;
        };
      };
    };
    if (event.type !== 'assistant/message') continue;
    const content = event.data?.message?.content ?? [];
    const nextText = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    const nextReasoning = content
      .filter(
        (block) => block.type === 'reasoning' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('\n\n');
    if (nextText.trim()) text = nextText.trim();
    if (nextReasoning.trim()) reasoning = nextReasoning.trim();
  }
  return { text, reasoning };
}

export function dshChatRouteId(providerId: string, fingerprint: string): string {
  const safe = providerId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `spec-agent-chat-${safe || 'provider'}-${fingerprint.slice(0, 6)}`;
}

export function dshProviderPatchYaml(
  routeId: string,
  provider: ProviderConfig,
  model: string,
): string {
  const protocol = provider.protocol ?? 'anthropic';
  const api = protocol === 'openai' ? 'openai-completions' : 'anthropic-messages';
  const baseURL = dshProviderBaseUrl(provider);
  const modelMeta = provider.models?.[model];
  const lines = [
    '# Generated by Spec Agent for one chat route. Do not edit by hand.',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${routeId}:`,
    `        displayName: ${JSON.stringify(provider.name || provider.id)}`,
    `        api: ${api}`,
    `        baseURL: ${JSON.stringify(baseURL)}`,
    '        apiKeyEnv: SPEC_AGENT_CHAT_API_KEY',
    '        models:',
    `          - id: ${JSON.stringify(model)}`,
  ];
  if (modelMeta?.contextWindow) {
    lines.push(`            contextWindow: ${modelMeta.contextWindow}`);
  }
  return `${lines.join('\n')}\n`;
}

/** pi-ai's OpenAI adapter expects the API root including /v1, unlike our form hint. */
function dshProviderBaseUrl(provider: ProviderConfig): string {
  const base = (provider.baseUrl ?? '').replace(/\/+$/, '');
  if ((provider.protocol ?? 'anthropic') !== 'openai') return base;
  const path = base.replace(/^https?:\/\/[^/]+/i, '');
  return /\/v\d+[a-z0-9.-]*$/i.test(path) ? base : `${base}/v1`;
}

function writeDshProviderPatch(
  dshHome: string,
  routeId: string,
  provider: ProviderConfig,
  model: string,
): string {
  const path = join(dshHome, `${routeId}.patch.yml`);
  writeFileSync(path, dshProviderPatchYaml(routeId, provider, model), 'utf8');
  return path;
}

/** Resolve the runtime sibling installed with the SDK, without relying on .bin shims. */
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
    if (!bin) return undefined;
    return resolve(dirname(packagePath), bin);
  } catch {
    return undefined;
  }
}
