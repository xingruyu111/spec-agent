import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeInput } from '@spec-agent/core';
import { DshAgentRuntime } from '../../apps/server/src/dsh/dsh-agent-runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function input(cwd: string): AgentRuntimeInput {
  return {
    systemPrompt: '只执行任务',
    task: '回复完成',
    cwd,
    allowedTools: ['Read'],
    skills: [],
    provider: {
      id: 'ds',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      authToken: 'test-token',
      models: { 'deepseek-flash': {} },
    },
    model: 'deepseek-flash',
    budget: { maxTurns: 4, maxUsd: 0.1 },
    signal: new AbortController().signal,
  };
}

describe('DshAgentRuntime', () => {
  it('把 DSH 事件映射为 AgentRuntimeOutput', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-dsh-runtime-'));
    roots.push(root);
    const session = {
      id: 'dsh-session-1',
      run: vi.fn(async () => ({
        sessionId: 'dsh-session-1',
        finalResponse: '完成',
        events: [
          {
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: '完成' }] },
              usage: { inputTokens: 12, outputTokens: 4 },
            },
          },
          {
            type: 'tool/call',
            data: { callId: 'call-1', name: 'Read', arguments: '{"path":"a"}' },
          },
          {
            type: 'tool/result',
            data: {
              callId: 'call-1',
              message: {
                content: [{ type: 'text', text: 'file body' }],
                isError: false,
              },
            },
          },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ],
        notifications: [],
      })),
    };
    const harness = {
      session: () => session,
      resumeSession: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const toolEvents: string[] = [];
    const runtime = new DshAgentRuntime({
      createHarness: () => harness as never,
    });
    const output = await runtime.run({
      ...input(root),
      onToolEvent: (event) => toolEvents.push(`${event.phase}:${event.tool}`),
    });
    expect(output.stopReason).toBe('finished');
    expect(output.text).toBe('完成');
    expect(output.transcriptRef).toBe('dsh-session-1');
    expect(output.usage).toEqual({ usd: 0, inputTokens: 12, outputTokens: 4 });
    expect(toolEvents).toEqual(['call:Read', 'result:Read']);
    await runtime.close();
  });

  it('turn/end error 映射为失败并带错误信息', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hive-dsh-runtime-'));
    roots.push(root);
    const session = {
      id: 'dsh-session-2',
      run: vi.fn(async () => ({
        sessionId: 'dsh-session-2',
        finalResponse: '',
        events: [
          {
            type: 'turn/end',
            data: {
              reason: {
                kind: 'error',
                error: { code: 'E_PROVIDER', message: 'provider down' },
              },
            },
          },
        ],
        notifications: [],
      })),
    };
    const runtime = new DshAgentRuntime({
      createHarness: () =>
        ({
          session: () => session,
          close: vi.fn(async () => undefined),
        }) as never,
    });
    const output = await runtime.run(input(root));
    expect(output.stopReason).toBe('failed');
    expect(output.error?.message).toContain('provider down');
    await runtime.close();
  });
});
