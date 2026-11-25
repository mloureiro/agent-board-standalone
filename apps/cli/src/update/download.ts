import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CliError } from '../errors.js';
import type { Runtime } from '../runtime.js';
import {
  CHECKSUMS_ASSET,
  assertFetchable,
  assetName,
  parseChecksums,
  type Release,
  type UpdateTarget,
} from './release-source.js';

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_BINARY_BYTES = 400 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 256 * 1024;
const VERSION_PROBE_TIMEOUT_MS = 20_000;

async function open(rt: Runtime, url: string): Promise<Response> {
  assertFetchable(url, 'the release asset URL');
  let response: Response;
  try {
    response = await rt.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`could not download ${url} (${reason})`);
  }
  if (!response.ok) throw new CliError(`${url} answered ${response.status}`);
  if (response.url !== '') assertFetchable(response.url, 'the redirected release asset URL');
  return response;
}

async function checksumFor(rt: Runtime, release: Release, name: string): Promise<string> {
  const listing = release.assets.find((asset) => asset.name === CHECKSUMS_ASSET);
  if (listing === undefined) {
    throw new CliError(`release ${release.tag} has no ${CHECKSUMS_ASSET}: it cannot be verified`);
  }
  const text = await (await open(rt, listing.url)).text();
  if (text.length > MAX_CHECKSUMS_BYTES) throw new CliError(`${CHECKSUMS_ASSET} is too large`);
  const sum = parseChecksums(text).get(name);
  if (sum === undefined) {
    throw new CliError(`${CHECKSUMS_ASSET} of ${release.tag} has no checksum for ${name}`);
  }
  return sum;
}

export interface Downloaded {
  readonly file: string;
  readonly sha256: string;
}

export async function downloadVerified(
  rt: Runtime,
  release: Release,
  target: UpdateTarget,
  stagingDir: string,
): Promise<Downloaded> {
  const name = assetName(target);
  const asset = release.assets.find((entry) => entry.name === name);
  if (asset === undefined) throw new CliError(`release ${release.tag} has no ${name} asset`);
  const expected = await checksumFor(rt, release, name);

  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const file = path.join(stagingDir, `${name}.part`);
  const response = await open(rt, asset.url);
  if (response.body === null) throw new CliError(`${asset.url} sent no body`);
  const hash = createHash('sha256');
  let size = 0;
  const counted = Readable.fromWeb(response.body as never);
  counted.on('data', (chunk: Buffer) => {
    size += chunk.length;
    hash.update(chunk);
    if (size > MAX_BINARY_BYTES) counted.destroy(new CliError(`${name} is larger than allowed`));
  });
  try {
    await pipeline(counted, createWriteStream(file, { mode: 0o755 }));
  } catch (error) {
    rmSync(file, { force: true });
    if (error instanceof CliError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`the download of ${name} broke off (${reason})`);
  }
  const actual = hash.digest('hex');
  if (actual !== expected) {
    rmSync(file, { force: true });
    throw new CliError(
      `the checksum of ${name} does not match ${CHECKSUMS_ASSET} (expected ${expected}, got ${actual}); nothing was installed`,
    );
  }
  chmodSync(file, 0o755);
  return { file, sha256: actual };
}

export async function probeVersion(rt: Runtime, file: string, version: string): Promise<void> {
  let result: { code: number; stdout: string };
  try {
    result = await rt.exec(file, ['--version'], {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      maxBytes: 4096,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`the downloaded board does not run (${reason}); nothing was installed`);
  }
  if (result.code !== 0 || !result.stdout.includes(`board ${version}`)) {
    throw new CliError(
      `the downloaded board does not report version ${version}; nothing was installed`,
    );
  }
}
