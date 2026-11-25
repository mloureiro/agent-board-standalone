import { spawn } from 'node:child_process';
import type { OwnerCounts } from './count-check.js';

export interface ApiResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runApiImport(
  api: string,
  file: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ApiResult> {
  const script = /\.[cm]?js$/.test(api);
  const command = script ? process.execPath : api;
  const args = script ? [api, 'import', '--file', file] : ['import', '--file', file];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export interface ImportReport {
  readonly passed: boolean;
  readonly owners: OwnerCounts;
}

const OWNER_LINE = /^owner (.+)$/;
const TABLE_LINE = /^ {2}(\w+): (\d+)$/;

export function parseImportReport(stdout: string): ImportReport {
  const owners: Record<string, Record<string, number>> = {};
  let current: Record<string, number> | null = null;
  let passed = false;
  for (const line of stdout.split('\n')) {
    const owner = OWNER_LINE.exec(line);
    const table = TABLE_LINE.exec(line);
    if (owner?.[1] !== undefined) {
      current = {};
      owners[owner[1]] = current;
    } else if (table?.[1] !== undefined && table[2] !== undefined && current !== null) {
      current[table[1]] = Number(table[2]);
    } else if (line.trim() === 'count check passed') passed = true;
  }
  return { passed, owners };
}
