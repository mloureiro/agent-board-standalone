import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PartInfo {
  name: string;
  version: string;
  changelog: string;
  ranges: { contract?: string; sealing?: string };
}

export interface TagPlan {
  tag: string;
  message: string;
}

const UNRELEASED = '0.0.0';

export function planTags(parts: PartInfo[], existingTags: ReadonlySet<string>): TagPlan[] {
  const plans: TagPlan[] = [];
  for (const part of parts) {
    const tag = `${part.name}-v${part.version}`;
    if (part.version === UNRELEASED || existingTags.has(tag)) continue;
    const heading = `## ${part.version}`;
    if (!part.changelog.split('\n').some((line) => line.trim() === heading)) {
      throw new Error(`${part.name}: CHANGELOG.md has no "${heading}" heading`);
    }
    const lines = [`${part.name} ${part.version}`];
    if (part.ranges.contract) lines.push(`supports @agent-board/contract ${part.ranges.contract}`);
    if (part.ranges.sealing) lines.push(`supports @agent-board/sealing ${part.ranges.sealing}`);
    plans.push({ tag, message: lines.join('\n') });
  }
  return plans;
}

const PART_DIRECTORIES = [
  ['api', 'apps/api'],
  ['cli', 'apps/cli'],
  ['web', 'apps/web'],
  ['migrate', 'apps/migrate'],
  ['server-app', 'apps/server-app'],
  ['client-app', 'apps/client-app'],
  ['mobile', 'apps/mobile'],
  ['contract', 'packages/contract'],
  ['sealing', 'packages/sealing'],
] as const;

function readPart(root: string, name: string, directory: string): PartInfo {
  const manifest = JSON.parse(readFileSync(`${root}/${directory}/package.json`, 'utf8'));
  const dependencies = manifest.dependencies ?? {};
  const ranges: PartInfo['ranges'] = {};
  const contract = dependencies['@agent-board/contract'];
  const sealing = dependencies['@agent-board/sealing'];
  if (contract) ranges.contract = contract.replace(/^workspace:/, '');
  if (sealing) ranges.sealing = sealing.replace(/^workspace:/, '');
  return {
    name,
    version: manifest.version,
    changelog: readFileSync(`${root}/${directory}/CHANGELOG.md`, 'utf8'),
    ranges,
  };
}

function main(): void {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const dryRun = process.argv.includes('--dry-run');
  const parts = PART_DIRECTORIES.map(([name, directory]) => readPart(root, name, directory));
  const existing = new Set(
    execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  );
  for (const { tag, message } of planTags(parts, existing)) {
    console.log(`${dryRun ? 'would create' : 'creating'} ${tag}\n${message}\n`);
    if (!dryRun) execFileSync('git', ['tag', '-a', tag, '-m', message], { cwd: root });
  }
}

if (import.meta.main) main();
