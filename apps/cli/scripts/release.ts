import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CLI_ROOT } from './bundle.ts';
import { RELEASE_DIR, compile } from './compile.ts';
import { planRelease, releaseCommands } from './release-plan.ts';
import { RELEASE_TARGETS, assetFile } from './targets.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    notes: { type: 'string', default: '' },
    'no-build': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

const [version] = positionals;
if (version === undefined) {
  console.error('usage: node scripts/release.ts <x.y.z> [--notes <text>] [--no-build] [--dry-run]');
  process.exit(2);
}

const file = (name: string): string => path.join(CLI_ROOT, name);
const plan = planRelease({
  version,
  packageJson: readFileSync(file('package.json'), 'utf8'),
  versionSource: readFileSync(file('src/version.ts'), 'utf8'),
  changelog: readFileSync(file('CHANGELOG.md'), 'utf8'),
  notes: values.notes ?? '',
});

if (values['dry-run'] === true) {
  console.log(`would set the CLI to ${version} in package.json, src/version.ts and CHANGELOG.md`);
} else {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'apps/cli'], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
  });
  if (dirty.trim() !== '')
    throw new Error('apps/cli has uncommitted changes; commit or stash them');
  writeFileSync(file('package.json'), plan.packageJson);
  writeFileSync(file('src/version.ts'), plan.versionSource);
  writeFileSync(file('CHANGELOG.md'), plan.changelog);
  console.log(`prepared the CLI ${version}`);
}

if (values['no-build'] !== true && values['dry-run'] !== true) {
  const sums: string[] = [];
  for (const target of RELEASE_TARGETS) {
    const built = compile(target);
    const digest = createHash('sha256').update(readFileSync(built)).digest('hex');
    sums.push(`${digest}  ${assetFile(target)}`);
  }
  writeFileSync(path.join(RELEASE_DIR, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  console.log(`built ${RELEASE_TARGETS.length} binaries and SHA256SUMS in ${RELEASE_DIR}`);
}

console.log('\nnothing is tagged or published; to release, review the changes and run:');
for (const command of releaseCommands(version)) console.log(`  ${command}`);
