import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PART_ROOT } from './layout.ts';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const UNRELEASED = /^## 0\.0\.0\n+Not released\n*/m;
const CRATES = ['rumo-server', 'rumo-server-core'] as const;

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

const hasHeading = (changelog: string, version: string): boolean =>
  changelog.split('\n').some((line) => line.trim() === `## ${version}`);

export const changelogWith = (changelog: string, version: string, notes: string): string => {
  const entry = `## ${version}\n\n${notes.trim()}\n\n`;
  if (UNRELEASED.test(changelog)) return changelog.replace(UNRELEASED, entry);
  const firstEntry = changelog.search(/^## /m);
  if (firstEntry < 0) return `${changelog.trimEnd()}\n\n${entry.trimEnd()}\n`;
  return `${changelog.slice(0, firstEntry)}${entry}${changelog.slice(firstEntry)}`;
};

export const cargoManifestWith = (manifest: string, version: string): string =>
  manifest.replace(/^(\[package\][^[]*?\nversion = ")[^"]+(")/m, `$1${version}$2`);

export const cargoLockWith = (lock: string, version: string): string =>
  CRATES.reduce(
    (text, crate) =>
      text.replace(new RegExp(`(name = "${crate}"\\nversion = ")[^"]+(")`), `$1${version}$2`),
    lock,
  );

export const prepareRelease = async (
  root: string,
  version: string,
  notes: string,
): Promise<void> => {
  triple(version);
  const manifestPath = path.join(root, 'package.json');
  const manifest = await readFile(manifestPath, 'utf8');
  const current = /"version":\s*"([^"]+)"/.exec(manifest)?.[1];
  if (current === undefined) throw new Error('package.json has no version');
  if (!isNewer(version, current))
    throw new Error(`${version} is not newer than the current version ${current}`);
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8');
  const written = hasHeading(changelog, version);
  if (notes.trim() === '' && !written)
    throw new Error('the changelog needs release notes: pass --notes "..."');
  if (notes.trim() !== '' && written)
    throw new Error(`CHANGELOG.md already has a "## ${version}" heading`);
  const versionPath = path.join(root, 'src', 'version.ts');
  const cratePaths = [
    path.join(root, 'src-tauri', 'Cargo.toml'),
    path.join(root, 'src-tauri', 'core', 'Cargo.toml'),
  ];
  const lockPath = path.join(root, 'src-tauri', 'Cargo.lock');
  const [source, lock, ...crates] = await Promise.all([
    readFile(versionPath, 'utf8'),
    readFile(lockPath, 'utf8'),
    ...cratePaths.map((file) => readFile(file, 'utf8')),
  ]);
  await Promise.all([
    writeFile(manifestPath, manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)),
    writeFile(versionPath, source.replace(/(PART_VERSION = ')[^']+(')/, `$1${version}$2`)),
    writeFile(lockPath, cargoLockWith(lock, version)),
    ...cratePaths.map((file, index) => writeFile(file, cargoManifestWith(crates[index]!, version))),
    ...(written ? [] : [writeFile(changelogPath, changelogWith(changelog, version, notes))]),
  ]);
};

const optionOf = (args: readonly string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const version = args.find((argument) => SEMVER.test(argument));
  if (version === undefined) {
    process.stderr.write(
      'usage: pnpm --filter @rumo/server-app release <version> [--notes "<text>"]\n',
    );
    process.exit(2);
  }
  await prepareRelease(PART_ROOT, version, optionOf(args, '--notes') ?? '');
  process.stdout.write(
    `server-app ${version} prepared: package.json, src/version.ts, the Cargo manifests, Cargo.lock and CHANGELOG.md are updated.\n` +
      `Review and commit them, build the app, run \`pnpm --filter @rumo/server-app release:check ${version}\`, then run \`pnpm release:tags\` to create the server-app-v${version} tag.\n`,
  );
}
