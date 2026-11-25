import { execFile } from 'node:child_process';
import os from 'node:os';

export interface ExecOptions {
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
}

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readonly stdoutIsTty: boolean;
  readonly stderrIsTty: boolean;
}

export interface Runtime {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: Io;
  readonly fetch: typeof fetch;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly hostname: string;
  exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

function execFileText(
  file: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { timeout: options.timeoutMs, maxBuffer: options.maxBytes, encoding: 'utf8' },
      (error, stdout) => {
        if (error === null) {
          resolve({ code: 0, stdout });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ code, stdout });
          return;
        }
        reject(error);
      },
    );
    child.stdin?.end(options.stdin);
  });
}

export function systemRuntime(): Runtime {
  return {
    env: process.env,
    io: {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
      stdoutIsTty: process.stdout.isTTY === true,
      stderrIsTty: process.stderr.isTTY === true,
    },
    fetch: globalThis.fetch,
    platform: process.platform,
    homedir: os.homedir(),
    hostname: os.hostname(),
    exec: execFileText,
  };
}
