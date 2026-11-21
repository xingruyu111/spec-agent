import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '@spec-agent/server';
import type { ChatEngine } from '../../apps/server/src/dsh/dsh-chat.js';

describe('Tencent Memory remote fallback', () => {
  it('远程不可达时聊天使用本地记忆，写入失败不影响服务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spec-agent-memory-fallback-'));
    mkdirSync(join(root, '.spec-agent'), { recursive: true });
    writeFileSync(join(root, '.spec-agent', 'settings.json'), JSON.stringify({
      capabilities: {
        memory: {
          provider: 'tencent',
          baseUrl: 'http://127.0.0.1:9',
          serviceId: 'offline-test',
          userId: 'local-user',
        },
      },
    }));
    const engine: ChatEngine = {
      run: vi.fn(async ({ sessionId }) => ({
        sessionId: sessionId ?? 'dsh-local',
        text: '远程不可用，但本地回答成功',
      })),
      close: vi.fn(async () => undefined),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await startServer({
      root,
      port: 0,
      webDist: join(root, 'missing-web'),
      providerFile: join(root, 'provider.json'),
      chatEngine: engine,
      autoMemory: false,
    });
    try {
      const session = await fetch(`${server.url}/api/chat/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }).then((r) => r.json());
      const response = await fetch(`${server.url}/api/chat/sessions/${session.session.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '测试记忆降级', mode: 'qa' }),
      });
      expect(response.status).toBe(200);
      const detail = await response.json();
      expect(detail.messages.at(-1).content).toBe('远程不可用，但本地回答成功');
      expect(vi.mocked(engine.run).mock.calls[0]?.[0].prompt).toContain('当前项目动态摘要');
      expect((await fetch(`${server.url}/api/health`).then((r) => r.json())).ok).toBe(true);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
