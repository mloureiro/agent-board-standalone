import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ReleaseInputs {
  readonly target: string;
  readonly packageVersion: string;
  readonly sourceVersion: string;
  readonly cargoVersion: string;
  readonly changelog: string;
  readonly built: boolean;
}

export function releaseProblems(inputs: ReleaseInputs): string[] {
  const problems: string[] = [];
  const same: ReadonlyArray<readonly [string, string]> = [
    ['package.json', inputs.packageVersion],
    ['src/version.ts', inputs.sourceVersion],
    ['src-tauri/Cargo.toml', inputs.cargoVersion],
  ];
  for (const [file, version] of same) {
    if (version !== inputs.target) problems.push(`${file} is ${version}, not ${inputs.target}`);
  }
  if (!inputs.changelog.split('\n').some((line) => line.trim() === `## ${inputs.target}`))
    problems.push(`CHANGELOG.md has no "## ${inputs.target}" heading`);
  if (!inputs.built) problems.push('dist/version.json is missing: run the build first');
  return problems;
}

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

function isBuilt(): boolean {
  try {
    read('dist/version.json');
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const target = process.argv[2];
  if (target === undefined) throw new Error('usage: release-check <version>');
  const problems = releaseProblems({
    target,
    packageVersion: (JSON.parse(read('package.json')) as { version: string }).version,
    sourceVersion: /PART_VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1] ?? '',
    cargoVersion: /^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1] ?? '',
    changelog: read('CHANGELOG.md'),
    built: isBuilt(),
  });
  if (problems.length > 0) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(
    `client-app ${target} is ready: run pnpm release:tags to create client-app-v${target}`,
  );
}

if (import.meta.main) main();
