/**
 * 命令执行端口。
 *
 * 引擎不直接 spawn 进程；测试里可以换成完全受控的 fake。
 */

export type ShellInput = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export interface ShellRunner {
  run(input: ShellInput): Promise<ShellResult>;
}
