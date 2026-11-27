import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const UNRELEASED = /^## 0\.0\.0\n+Not released\n*/m;

const triple = (version: string): [number, number, number] => {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`"${version}" is not a release version like 1.0.0`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const isNewer = (next: string, current: string): boolean => {
  const [a, b] = [triple(next), triple(current)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! > b[index]!;
  }
  return false;
};

export const changelogWith = (changelog: string, version: string, notes: string): string => {
  const entry = `## ${version}\n\n${notes.trim()}\n\n`;
  if (UNRELEASED.test(changelog)) return changelog.replace(UNRELEASED, entry);
  const firstEntry = changelog.search(/^## /m);
  if (firstEntry < 0) return `${changelog.trimEnd()}\n\n${entry.trimEnd()}\n`;
  return `${changelog.slice(0, firstEntry)}${entry}${changelog.slice(firstEntry)}`;
};

export const prepareRelease = async (
  root: string,
  version: string,
  notes: string,
): Promise<void> => {
  triple(version);
  if (notes.trim() === '') throw new Error('the changelog needs release notes: pass --notes "..."');
  const manifestPath = join(root, 'package.json');
  const manifest = await readFile(manifestPath, 'utf8');
  const current = /"version":\s*"([^"]+)"/.exec(manifest)?.[1];
  if (current === undefined) throw new Error('package.json has no version');
  if (!isNewer(version, current))
    throw new Error(`${version} is not newer than the current version ${current}`);
  const changelogPath = join(root, 'CHANGELOG.md');
  const versionPath = join(root, 'src', 'version.ts');
  const [changelog, source] = await Promise.all([
    readFile(changelogPath, 'utf8'),
    readFile(versionPath, 'utf8'),
  ]);
  if (changelog.split('\n').some((line) => line.trim() === `## ${version}`))
    throw new Error(`CHANGELOG.md already has a "## ${version}" heading`);
  await Promise.all([
    writeFile(manifestPath, manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)),
    writeFile(versionPath, source.replace(/(PART_VERSION = ')[^']+(')/, `$1${version}$2`)),
    writeFile(changelogPath, changelogWith(changelog, version, notes)),
  ]);
};

const optionOf = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = args.find((argument) => SEMVER.test(argument));
  if (version === undefined) {
    process.stderr.write('usage: pnpm --filter @rumo/migrate release <version> --notes "<text>"\n');
    process.exit(2);
  }
  await prepareRelease(resolve(here, '..'), version, optionOf(args, '--notes') ?? '');
  process.stdout.write(
    `migrate ${version} prepared: package.json, src/version.ts and CHANGELOG.md are updated.\n` +
      `Review and commit them, then run \`pnpm release:tags\` to create the migrate-v${version} tag.\n`,
  );
}
