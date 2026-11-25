import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { E2E_ROOT } from './paths.js';

export interface SkipEntry {
  readonly file: string;
  readonly titlePath: readonly string[];
  readonly project: string | null;
  readonly reason: string;
}

export function partSkipReason(missing: readonly { part: string; path: string }[]): string {
  const first = missing[0];
  if (first === undefined) throw new Error('no missing part to report');
  return `part missing: ${first.part} (${first.path})`;
}

export function featureSkipReason(missing: readonly { name: string; label: string }[]): string {
  const first = missing[0];
  if (first === undefined) throw new Error('no missing feature to report');
  return `missing feature: ${first.name} (${first.label})`;
}

export function recordSkip(entry: SkipEntry, env: NodeJS.ProcessEnv = process.env): void {
  const target = env.E2E_SKIP_LOG;
  if (!target) return;
  const relative = path.relative(E2E_ROOT, entry.file);
  const file = relative.startsWith('..') ? entry.file : relative.split(path.sep).join('/');
  const line = JSON.stringify({
    file,
    titlePath: entry.titlePath,
    project: entry.project,
    reason: entry.reason,
  });
  appendFileSync(target, `${line}\n`);
}
