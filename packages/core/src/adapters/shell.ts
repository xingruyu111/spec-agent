/**
 * shell 执行适配器。
 *
 * 用 shell:true 交给系统解释器；超时杀进程树（Windows 用 taskkill /T /F）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { AppError } from '@spec-agent/kernel';
import type { ShellInput, ShellResult, ShellRunner } from '../ports/shell.js';

const OUTPUT_CAP = 1024 * 1024;

export class ShellCli implements ShellRunner {
  async run(input: ShellInput): Promise<ShellResult> {
    const started = Date.now();

    return new Promise<ShellResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(input.command, {
          cwd: input.cwd,
          shell: true,
          env: { ...process.env, ...(input.env ?? {}) },
          windowsHide: true,
        });
      } catch (error) {
        reject(new AppError('E_SHELL_SPAWN', '无法启动命令', { cause: error }));
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += chunk.toString();
      });

      const timer = input.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, input.timeoutMs)
        : undefined;

      const onAbort = (): void => {
        timedOut = true;
        killTree(child);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (error) => {
        cleanup();
        reject(new AppError('E_SHELL', '命令执行失败', { cause: error }));
      });

      child.on('close', (code) => {
        cleanup();
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
        });
      });
    });
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGKILL');
  }
}
