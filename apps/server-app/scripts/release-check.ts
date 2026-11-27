import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BUNDLED_APP, PART_ROOT } from './layout.ts';

export interface ReleaseInputs {
  readonly target: string;
  readonly packageVersion: string;
  readonly sourceVersion: string;
  readonly cargoVersions: Readonly<Record<string, string>>;
  readonly changelog: string;
  readonly bundleVersion: string | null;
}

export function releaseProblems(inputs: ReleaseInputs): string[] {
  const problems: string[] = [];
  const same: [string, string][] = [
    ['package.json', inputs.packageVersion],
    ['src/version.ts', inputs.sourceVersion],
    ...Object.entries(inputs.cargoVersions),
  ];
  for (const [file, version] of same) {
    if (version !== inputs.target) problems.push(`${file} is ${version}, not ${inputs.target}`);
  }
  if (!inputs.changelog.split('\n').some((line) => line.trim() === `## ${inputs.target}`))
    problems.push(`CHANGELOG.md has no "## ${inputs.target}" heading`);
  if (inputs.bundleVersion === null)
    problems.push('the built .app is missing: run `pnpm --filter @rumo/server-app bundle`');
  else if (inputs.bundleVersion !== inputs.target)
    problems.push(`the built .app is ${inputs.bundleVersion}, not ${inputs.target}`);
  return problems;
}

const read = (relative: string): string => readFileSync(path.join(PART_ROOT, relative), 'utf8');

function bundleVersion(): string | null {
  try {
    const plist = readFileSync(path.join(BUNDLED_APP, 'Contents', 'Info.plist'), 'utf8');
    return (
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
    );
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const target = process.argv[2];
  if (target === undefined) throw new Error('usage: release-check <version>');
  const cargoVersion = (file: string): string =>
    /^version = "([^"]+)"/m.exec(read(file))?.[1] ?? '';
  const problems = releaseProblems({
    target,
    packageVersion: (JSON.parse(read('package.json')) as { version: string }).version,
    sourceVersion: /PART_VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1] ?? '',
    cargoVersions: {
      'src-tauri/Cargo.toml': cargoVersion('src-tauri/Cargo.toml'),
      'src-tauri/core/Cargo.toml': cargoVersion('src-tauri/core/Cargo.toml'),
    },
    changelog: read('CHANGELOG.md'),
    bundleVersion: bundleVersion(),
  });
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `server-app ${target} is ready: run pnpm release:tags to create server-app-v${target}\n`,
    );
  }
}
