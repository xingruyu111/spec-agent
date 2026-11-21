import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShellCli } from './shell.js';

const dir = mkdtempSync(join(tmpdir(), 'hive-shell-'));

describe('ShellCli', () => {
  it('执行命令并捕获 stdout', async () => {
    const result = await new ShellCli().run({ command: 'echo hello-hive', cwd: dir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello-hive');
    expect(result.timedOut).toBe(false);
  });

  it('返回非零退出码而不是抛异常', async () => {
    const result = await new ShellCli().run({
      command: 'node -e "process.exit(3)"',
      cwd: dir,
    });
    expect(result.exitCode).toBe(3);
  });

  it('超时会杀掉进程并标记 timedOut', async () => {
    const result = await new ShellCli().run({
      command: 'node -e "setTimeout(()=>{}, 5000)"',
      cwd: dir,
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
  });

  it('cwd 生效', async () => {
    const result = await new ShellCli().run({
      command: 'node -e "console.log(process.cwd())"',
      cwd: dir,
    });
    expect(result.stdout.trim()).toBe(dir);
  });

  it('信号中止会结束命令', async () => {
    const controller = new AbortController();
    const running = new ShellCli().run({
      command: 'node -e "setTimeout(()=>{}, 5000)"',
      cwd: dir,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;
    expect(result.timedOut).toBe(true);
  });

  it('工作目录不存在时报 E_SHELL_SPAWN 或非零退出', async () => {
    try {
      const result = await new ShellCli().run({
        command: 'echo x',
        cwd: join(dir, 'missing'),
      });
      expect(result.exitCode).not.toBe(0);
    } catch (error) {
      expect((error as { code?: string }).code).toMatch(/^E_SHELL/);
    }
  });
});

process.on('exit', () => {
  rmSync(dir, { recursive: true, force: true });
});
