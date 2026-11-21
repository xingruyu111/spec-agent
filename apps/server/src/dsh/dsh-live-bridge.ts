/**
 * DSH live-stream bridge.
 *
 * DSH 的 `agent/assistant-stream` 是进程内实时帧，SDK 默认只投影 committed
 * `session.event`。这个极小的 Cordis plugin 把 text/reasoning delta 重新发成
 * 一个自定义 `session.event`，SDK client 会原样收到；Hive 再转成 SSE。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PLUGIN = `export const name = 'hive-live-bridge'
export const inject = []
export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!frame || frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk) return
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
    // 直接发自定义 JSON-RPC notification，不进入 session/event 总线，
    // 避免 synthetic event 干扰 DSH 的 seq 记账。
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'spec-agent.assistant.delta',
      params: {
        sessionId: String(agent.session.id),
        kind: chunk.type === 'text-delta' ? 'text' : 'reasoning',
        text: chunk.text,
        index: chunk.index,
        attemptId: frame.attemptId,
      },
    }) + '\\n')
  })
}
`;

const PATCH = `- insert:
    - id: spec-agent-live-bridge
      name: '@spec-agent/dsh-live-bridge'
`;

export type DshLiveBridge = {
  patchPath: string;
  enabled: boolean;
};

/** Install the bridge inside one isolated dshHome. Idempotent. */
export function installDshLiveBridge(dshHome: string): DshLiveBridge {
  if (process.env.SPEC_AGENT_DSH_LIVE_STREAM === '0') {
    return { patchPath: '', enabled: false };
  }
  const profileDir = join(dshHome, 'profiles', 'sdk');
  const packageDir = join(
    profileDir,
    'node_modules',
    '@spec-agent',
    'dsh-live-bridge',
  );
  mkdirSync(packageDir, { recursive: true });
  writeIfChanged(join(packageDir, 'package.json'), JSON.stringify({
    name: '@spec-agent/dsh-live-bridge',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'index.mjs',
  }, null, 2));
  writeIfChanged(join(packageDir, 'index.mjs'), PLUGIN);
  const patchPath = join(dshHome, 'spec-agent-live.patch.yml');
  writeIfChanged(patchPath, PATCH);
  return { patchPath, enabled: true };
}

function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    // 文件不存在时继续写
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}
