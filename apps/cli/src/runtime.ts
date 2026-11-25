import { execFile, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';

export interface ExecOptions {
  readonly stdin?: string;
  readonly cwd?: string;
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

export interface InteractiveOptions {
  readonly cwd: string;
}

export interface Runtime {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: Io;
  readonly interrupt: AbortSignal;
  cwd(): string;
  readStdin(): Promise<string>;
  ask(question: string): Promise<string | null>;
  spawnInteractive(
    file: string,
    args: readonly string[],
    options: InteractiveOptions,
  ): Promise<number>;
  readonly fetch: typeof fetch;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly hostname: string;
  exec(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult>;
}

export function execFileText(
  file: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        encoding: 'utf8',
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
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

function spawnInteractive(
  file: string,
  args: readonly string[],
  options: InteractiveOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { cwd: options.cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve(code ?? 128 + (signal === null ? 0 : (osConstants.signals[signal] ?? 0)));
    });
  });
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function askOnTerminal(question: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.on('error', stop);
  return controller.signal;
}

export function systemRuntime(): Runtime {
  return {
    env: process.env,
    interrupt: interruptSignal(),
    cwd: () => process.cwd(),
    readStdin: readProcessStdin,
    ask: askOnTerminal,
    spawnInteractive,
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
