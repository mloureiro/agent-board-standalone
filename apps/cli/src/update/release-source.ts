import { CliError } from '../errors.js';

export const RELEASE_REPOSITORY = 'mloureiro/agent-board-standalone';
export const RELEASE_TAG_PREFIX = 'cli-v';
export const RELEASES_URL_ENV = 'AGENT_BOARD_RELEASES_URL';
export const CHECKSUMS_ASSET = 'SHA256SUMS';
export const UPDATE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const;

export type UpdateTarget = (typeof UPDATE_TARGETS)[number];

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
}

export interface Release {
  readonly version: string;
  readonly tag: string;
  readonly assets: readonly ReleaseAsset[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const FETCH_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseSemver(text: string): [number, number, number] | null {
  const match = SEMVER.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) throw new CliError(`"${left}" and "${right}" are not both x.y.z`);
  for (const [at, part] of a.entries()) {
    const other = b[at] ?? 0;
    if (part !== other) return part < other ? -1 : 1;
  }
  return 0;
}

export function updateTarget(platform: string, arch: string): UpdateTarget | null {
  const target = `${platform}-${arch}`;
  return (UPDATE_TARGETS as readonly string[]).includes(target) ? (target as UpdateTarget) : null;
}

export const assetName = (target: UpdateTarget): string => `board-${target}`;

export function releasesUrl(env: Readonly<Record<string, string | undefined>>): string {
  const override = env[RELEASES_URL_ENV];
  const raw =
    override !== undefined && override !== ''
      ? override
      : `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=30`;
  assertFetchable(raw, RELEASES_URL_ENV);
  return raw;
}

export function assertFetchable(raw: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(`${what} is not a URL`);
  }
  const loopback = LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new CliError(`${what} must be https, or http for localhost`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assetsOf(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const { name, browser_download_url: url } = entry;
    return typeof name === 'string' && typeof url === 'string' ? [{ name, url }] : [];
  });
}

export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) throw new CliError('the release list is not a JSON array');
  const releases: Release[] = [];
  for (const entry of json as unknown[]) {
    if (!isRecord(entry) || entry.draft === true || entry.prerelease === true) continue;
    const tag = entry.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith(RELEASE_TAG_PREFIX)) continue;
    const version = tag.slice(RELEASE_TAG_PREFIX.length);
    if (parseSemver(version) === null) continue;
    releases.push({ version, tag, assets: assetsOf(entry.assets) });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

export async function fetchReleases(
  fetchFn: typeof fetch,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Release[]> {
  const url = releasesUrl(env);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`could not reach the release list at ${url} (${reason})`);
  }
  if (!response.ok) throw new CliError(`the release list answered ${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new CliError('the release list is not JSON');
  }
  return parseReleases(json);
}

export async function newestRelease(
  fetchFn: typeof fetch,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Release | null> {
  return (await fetchReleases(fetchFn, env))[0] ?? null;
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sums.set(match[2], match[1].toLowerCase());
    }
  }
  return sums;
}
