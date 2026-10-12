import { exec } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
}

/**
 * Minimal shell: run a single command, capture stdout/stderr/exit code. No PTY, no
 * interactive session, no cross-command state.
 */
export function runShell(command: string, opts: { cwd: string; timeoutMs: number }): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        const timed_out = err?.killed === true;
        const exitCode = typeof err?.code === 'number' ? err.code : err ? (timed_out ? -1 : 1) : 0;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exit_code: exitCode,
          timed_out,
        });
      },
    );
  });
}
