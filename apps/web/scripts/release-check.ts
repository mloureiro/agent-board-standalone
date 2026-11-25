import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ReleaseInputs {
  readonly target: string;
  readonly packageVersion: string;
  readonly sourceVersion: string;
  readonly changelog: string;
  readonly built: { readonly version: string; readonly contract: number } | null;
  readonly contract: number;
}

export function releaseProblems(inputs: ReleaseInputs): string[] {
  const problems: string[] = [];
  if (inputs.packageVersion !== inputs.target)
    problems.push(`package.json is ${inputs.packageVersion}, not ${inputs.target}`);
  if (inputs.sourceVersion !== inputs.target)
    problems.push(`src/version.ts is ${inputs.sourceVersion}, not ${inputs.target}`);
  if (!inputs.changelog.split('\n').some((line) => line.trim() === `## ${inputs.target}`))
    problems.push(`CHANGELOG.md has no "## ${inputs.target}" heading`);
  if (inputs.built === null) problems.push('dist/version.json is missing: run the build first');
  else {
    if (inputs.built.version !== inputs.target)
      problems.push(`dist/version.json says ${inputs.built.version}, not ${inputs.target}`);
    if (inputs.built.contract !== inputs.contract)
      problems.push(`dist/version.json says contract ${inputs.built.contract}`);
  }
  return problems;
}

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

async function main(): Promise<void> {
  const { CONTRACT } = await import('@agent-board/contract');
  const target = process.argv[2];
  if (target === undefined) throw new Error('usage: release-check <version>');
  let built: ReleaseInputs['built'] = null;
  try {
    built = JSON.parse(read('dist/version.json')) as NonNullable<ReleaseInputs['built']>;
  } catch {
    built = null;
  }
  const sourceVersion = /PART_VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1] ?? '';
  const problems = releaseProblems({
    target,
    packageVersion: (JSON.parse(read('package.json')) as { version: string }).version,
    sourceVersion,
    changelog: read('CHANGELOG.md'),
    built,
    contract: CONTRACT,
  });
  if (problems.length > 0) {
    console.error(problems.map((problem) => `- ${problem}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`web ${target} is ready: run pnpm release:tags to create web-v${target}`);
}

if (import.meta.main) await main();
