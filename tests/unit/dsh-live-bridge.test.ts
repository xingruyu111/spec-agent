import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installDshLiveBridge } from '../../apps/server/src/dsh/dsh-live-bridge.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('installDshLiveBridge', () => {
  it('在 dshHome 内安装 Cordis plugin 和 patch', () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-dsh-bridge-'));
    roots.push(home);
    const bridge = installDshLiveBridge(home);
    expect(bridge.enabled).toBe(true);
    expect(existsSync(bridge.patchPath)).toBe(true);
    expect(readFileSync(bridge.patchPath, 'utf8')).toContain('spec-agent-live-bridge');
    const plugin = join(
      home,
      'profiles',
      'sdk',
      'node_modules',
      '@spec-agent',
      'dsh-live-bridge',
      'index.mjs',
    );
    expect(existsSync(plugin)).toBe(true);
    expect(readFileSync(plugin, 'utf8')).toContain('agent/assistant-stream');
    expect(readFileSync(plugin, 'utf8')).toContain('spec-agent.assistant.delta');
  });

  it('SPEC_AGENT_DSH_LIVE_STREAM=0 时关闭 bridge', () => {
    const old = process.env.SPEC_AGENT_DSH_LIVE_STREAM;
    process.env.SPEC_AGENT_DSH_LIVE_STREAM = '0';
    try {
      const home = mkdtempSync(join(tmpdir(), 'hive-dsh-bridge-'));
      roots.push(home);
      const bridge = installDshLiveBridge(home);
      expect(bridge.enabled).toBe(false);
      expect(existsSync(bridge.patchPath)).toBe(false);
    } finally {
      if (old === undefined) delete process.env.SPEC_AGENT_DSH_LIVE_STREAM;
      else process.env.SPEC_AGENT_DSH_LIVE_STREAM = old;
    }
  });
});
