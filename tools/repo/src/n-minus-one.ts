import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PARTS } from './parts.ts';

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

type Triple = readonly [number, number, number];

function parseCore(version: string): Triple | null {
  const match = RELEASE.exec(version.split(/[-+]/, 1)[0] ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function parseRelease(version: string): Triple | null {
  const match = RELEASE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function nMinusOne(
  part: string,
  headVersion: string,
  tags: readonly string[],
): string | null {
  const head = parseCore(headVersion);
  if (head === null) throw new Error(`${part}: "${headVersion}" is not a semver version`);
  const prefix = `${part}-v`;
  let best: { tag: string; version: Triple } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const version = parseRelease(tag.slice(prefix.length));
    if (version === null || compare(version, head) >= 0) continue;
    if (best === null || compare(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}

function main(argv: readonly string[]): void {
  const part = argv[0];
  const rule = PARTS.find((candidate) => candidate.name === part);
  if (part === undefined || rule === undefined) {
    console.error('usage: node tools/repo/src/n-minus-one.ts <part>');
    process.exitCode = 2;
    return;
  }
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}/${rule.directory}/package.json`, 'utf8'));
  const tags = execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  console.log(JSON.stringify({ part, tag: nMinusOne(part, manifest.version, tags) }));
}

if (import.meta.main) main(process.argv.slice(2));
