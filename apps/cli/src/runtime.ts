import { execFile, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import os from 'node:os';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { terminalPrompter, type Prompter } from './input/prompter.js';

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

export interface DetachedOptions {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logFile: string;
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
  spawnDetached(file: string, args: readonly string[], options: DetachedOptions): number | null;
  readonly fetch: typeof fetch;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly homedir: string;
  readonly hostname: string;
  readonly uid: number;
  readonly self: readonly string[];
  readonly prompts: Prompter | null;
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

function spawnDetached(
  file: string,
  args: readonly string[],
  options: DetachedOptions,
): number | null {
  mkdirSync(path.dirname(options.logFile), { recursive: true, mode: 0o700 });
  const log = openSync(options.logFile, 'a', 0o600);
  try {
    const child = spawn(file, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env },
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', () => undefined);
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(log);
  }
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

const BUN_EMBEDDED_ROOT = '/$bunfs/';

function selfCommand(): readonly string[] {
  const script = process.argv[1];
  if (script === undefined || script.startsWith(BUN_EMBEDDED_ROOT) || !existsSync(script)) {
    return [process.execPath];
  }
  return [process.execPath, realpathSync(script)];
}

export function systemRuntime(): Runtime {
  return {
    env: process.env,
    interrupt: interruptSignal(),
    cwd: () => process.cwd(),
    readStdin: readProcessStdin,
    ask: askOnTerminal,
    spawnInteractive,
    spawnDetached,
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
    arch: process.arch,
    homedir: os.homedir(),
    hostname: os.hostname(),
    uid: process.getuid?.() ?? 0,
    self: selfCommand(),
    prompts: process.stdin.isTTY && process.stderr.isTTY ? terminalPrompter() : null,
    exec: execFileText,
  };
}
