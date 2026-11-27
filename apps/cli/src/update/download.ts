import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CliError } from '../errors.js';
import type { Runtime } from '../runtime.js';
import {
  CHECKSUMS_ASSET,
  SIGNATURE_ASSET,
  assertFetchable,
  assetName,
  parseChecksums,
  type Release,
  type UpdateTarget,
} from './release-source.js';
import { MAX_SIGNATURE_BYTES, parsePublicKey, verifySignature } from './signature.js';
import { EMBEDDED_UPDATE_KEY } from './update-key.js';

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

async function readCapped(response: Response, max: number, what: string): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new CliError(`${what} is too large`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function verifyChecksums(
  rt: Runtime,
  release: Release,
  updateKey: string,
  checksums: Buffer,
): Promise<string> {
  const publicKey = parsePublicKey(updateKey);
  const refuse = (reason: string): CliError =>
    new CliError(
      `release ${release.tag} is not signed with the key this rumo trusts (${publicKey.keyId}): ${reason}; nothing was installed`,
    );
  const listing = release.assets.find((asset) => asset.name === SIGNATURE_ASSET);
  if (listing === undefined) throw refuse(`it has no ${SIGNATURE_ASSET}`);
  const signature = await readCapped(
    await open(rt, listing.url),
    MAX_SIGNATURE_BYTES,
    SIGNATURE_ASSET,
  );
  let signedTag: string;
  try {
    signedTag = verifySignature(publicKey, checksums, signature.toString('utf8')).trustedComment;
  } catch (error) {
    if (error instanceof CliError) throw refuse(error.message);
    throw error;
  }
  if (signedTag !== release.tag) throw refuse(`its signature was made for ${signedTag}`);
  return publicKey.keyId;
}

async function checksumFor(
  rt: Runtime,
  release: Release,
  name: string,
  updateKey: string | null,
): Promise<{ sum: string; signedBy: string | null }> {
  const listing = release.assets.find((asset) => asset.name === CHECKSUMS_ASSET);
  if (listing === undefined) {
    throw new CliError(`release ${release.tag} has no ${CHECKSUMS_ASSET}: it cannot be verified`);
  }
  const checksums = await readCapped(
    await open(rt, listing.url),
    MAX_CHECKSUMS_BYTES,
    CHECKSUMS_ASSET,
  );
  const signedBy =
    updateKey === null ? null : await verifyChecksums(rt, release, updateKey, checksums);
  const sum = parseChecksums(checksums.toString('utf8')).get(name);
  if (sum === undefined) {
    throw new CliError(`${CHECKSUMS_ASSET} of ${release.tag} has no checksum for ${name}`);
  }
  return { sum, signedBy };
}

export interface Downloaded {
  readonly file: string;
  readonly sha256: string;
  readonly signedBy: string | null;
}

export async function downloadVerified(
  rt: Runtime,
  release: Release,
  target: UpdateTarget,
  stagingDir: string,
  updateKey: string | null = EMBEDDED_UPDATE_KEY,
): Promise<Downloaded> {
  const name = assetName(target);
  const asset = release.assets.find((entry) => entry.name === name);
  if (asset === undefined) throw new CliError(`release ${release.tag} has no ${name} asset`);
  const { sum: expected, signedBy } = await checksumFor(rt, release, name, updateKey);

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
  return { file, sha256: actual, signedBy };
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
    throw new CliError(`the downloaded rumo does not run (${reason}); nothing was installed`);
  }
  if (result.code !== 0 || !result.stdout.includes(`rumo ${version}`)) {
    throw new CliError(
      `the downloaded rumo does not report version ${version}; nothing was installed`,
    );
  }
}
