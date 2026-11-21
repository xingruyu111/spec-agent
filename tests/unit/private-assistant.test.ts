import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, type AgentRuntime, type ProviderConfig } from '@spec-agent/core';
import type { ChatEngine } from '../../apps/server/src/dsh/dsh-chat.js';
import { PrivateAssistant } from '../../apps/server/src/assistant/private-assistant.js';
import { WorkMemoryStore } from '../../apps/server/src/work/work-memory.js';
import { WorkService } from '../../apps/server/src/work/work-service.js';
import { WorkStore } from '../../apps/server/src/work/work-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('PrivateAssistant', () => {
  it('把项目记忆注入私聊上下文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-private-memory-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const work = new WorkService(new WorkStore(store.db, store.clock));
      const memory = new WorkMemoryStore(store.db, store.clock);
      memory.write({
        projectId: 'p1',
        scopeType: 'project',
        scopeId: 'p1',
        content: '项目代号是 GREEN-7',
        source: 'seed',
      });
      let captured = '';
      const runtime: AgentRuntime = {
        id: 'fake',
        async run(input) {
          captured = input.systemPrompt;
          return {
            outputs: [],
            text: '项目代号是 GREEN-7。',
            transcriptRef: 'fake',
            usage: { usd: 0 },
            stopReason: 'finished',
          };
        },
      };
      const provider: ProviderConfig = {
        id: 'fake',
        protocol: 'openai',
        models: { fake: {} },
      };
      const assistant = new PrivateAssistant({
        work,
        runtime,
        provider,
        model: 'fake',
        cwd: dir,
        root: dir,
        memories: memory,
      });
      const result = await assistant.answer({
        projectId: 'p1',
        agentId: 'assistant',
        userId: 'u1',
        content: '项目代号是什么？',
      });
      expect(captured).toContain('GREEN-7');
      expect(result.messages.at(-1)?.content).toContain('GREEN-7');
    } finally {
      store.close();
    }
  });

  it('流式回答按 delta 回调并落库最终文本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-agent-private-stream-'));
    dirs.push(dir);
    const store = new Store({ path: join(dir, 'db.sqlite') });
    try {
      const work = new WorkService(new WorkStore(store.db, store.clock));
      const runtime: AgentRuntime = {
        id: 'unused',
        async run() {
          throw new Error('stream must use ChatEngine');
        },
      };
      const chatEngine: ChatEngine = {
        async run(input) {
          input.onDelta?.({ kind: 'text', text: 'AB' });
          return { sessionId: 'stream-1', text: 'AB' };
        },
        async close() {},
      };
      const provider: ProviderConfig = {
        id: 'fake',
        protocol: 'openai',
        models: { fake: {} },
      };
      const assistant = new PrivateAssistant({
        work,
        runtime,
        chatEngine,
        provider,
        model: 'fake',
        cwd: dir,
        root: dir,
      });
      const deltas: string[] = [];
      const result = await assistant.answerStream(
        {
          projectId: 'p1',
          agentId: 'assistant',
          userId: 'u1',
          content: '在吗',
        },
        { onDelta: (delta) => deltas.push(delta) },
      );
      expect(deltas.join('')).toBe('AB');
      expect(result.messages.at(-1)?.content).toBe('AB');
    } finally {
      store.close();
    }
  });
});

