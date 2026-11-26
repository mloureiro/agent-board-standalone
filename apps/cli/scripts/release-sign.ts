import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_ROOT, UPDATE_KEY_FILE } from './bundle.ts';

const TAG = /^cli-v\d+\.\d+\.\d+$/;
const CHECKSUMS_ASSET = 'SHA256SUMS';
const SIGNATURE_ASSET = `${CHECKSUMS_ASSET}.minisig`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function run(file: string, args: readonly string[], cwd: string): void {
  execFileSync(file, [...args], { cwd, stdio: 'inherit' });
}

const [tag] = process.argv.slice(2);
if (tag === undefined || !TAG.test(tag)) {
  fail('usage: node apps/cli/scripts/release-sign.ts <cli-vX.Y.Z>');
}
try {
  execFileSync('minisign', ['-v'], { stdio: 'ignore' });
} catch {
  fail('minisign is not installed (brew install minisign)');
}
if (!existsSync(UPDATE_KEY_FILE)) {
  fail(`${UPDATE_KEY_FILE} is missing; create the key pair with scripts/keys/minisign-init.sh`);
}
const secretKey =
  process.env.MINISIGN_SECRET_KEY ?? path.join(os.homedir(), '.minisign', 'minisign.key');
if (!existsSync(secretKey)) fail(`no minisign secret key at ${secretKey}`);

const work = mkdtempSync(path.join(os.tmpdir(), 'board-release-sign-'));
try {
  run('gh', ['release', 'download', tag, '--pattern', CHECKSUMS_ASSET, '--dir', work], CLI_ROOT);
  run('minisign', ['-S', '-s', secretKey, '-m', CHECKSUMS_ASSET, '-t', tag], work);
  run('minisign', ['-V', '-p', UPDATE_KEY_FILE, '-m', CHECKSUMS_ASSET], work);
  run('gh', ['release', 'upload', tag, path.join(work, SIGNATURE_ASSET)], CLI_ROOT);
  run('gh', ['release', 'edit', tag, '--draft=false'], CLI_ROOT);
  console.log(`signed ${CHECKSUMS_ASSET} of ${tag} and published the release`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
