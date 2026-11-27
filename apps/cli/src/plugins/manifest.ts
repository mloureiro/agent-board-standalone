import { isRecord } from '../domain/values.js';

export const MANIFEST_PATH = '.rumo/marketplace.json';
export const PROTOCOL = 1;

const MAX_BYTES = 64 * 1024;
const MAX_INTEGRATIONS = 50;
const MAX_TEXT = 300;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const COMMIT = /^[0-9a-f]{40}$/;

export interface Integration {
  readonly program: string;
  readonly description: string | undefined;
}

export interface Marketplace {
  readonly name: string;
  readonly description: string | undefined;
  readonly integrations: Readonly<Record<string, Integration>>;
}

function programPath(program: string): boolean {
  return (
    program.length > 0 &&
    program.length <= 200 &&
    program.split('/').every((part) => SEGMENT.test(part) && part !== '.' && part !== '..')
  );
}

function text(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value.length <= MAX_TEXT ? value : null;
}

export function parseMarketplace(source: string): Marketplace | string {
  if (Buffer.byteLength(source) > MAX_BYTES)
    return `the marketplace manifest is larger than ${MAX_BYTES / 1024} KB`;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return 'the marketplace manifest is not valid JSON';
  }
  if (!isRecord(raw)) return 'the marketplace manifest must be a JSON object';
  const unknown = Object.keys(raw).find(
    (key) => !['protocol', 'name', 'description', 'feeds'].includes(key),
  );
  if (unknown !== undefined)
    return `unknown key "${unknown.slice(0, 40)}" in the marketplace manifest`;
  if (raw.protocol !== PROTOCOL) {
    return `the marketplace speaks protocol ${String(raw.protocol).slice(0, 20)}; this CLI speaks ${PROTOCOL}`;
  }
  const { name, feeds } = raw;
  if (typeof name !== 'string' || !NAME.test(name)) {
    return 'the marketplace name must be 1 to 40 lowercase letters, digits or dashes';
  }
  const description = text(raw.description);
  if (description === null) return 'the marketplace description must be short text';
  if (!isRecord(feeds)) return 'the marketplace manifest needs a feeds object (it may be empty)';
  if (Object.keys(feeds).length > MAX_INTEGRATIONS) {
    return `a marketplace lists at most ${MAX_INTEGRATIONS} feeds`;
  }
  const integrations: Record<string, Integration> = {};
  for (const [key, entry] of Object.entries(feeds)) {
    if (!NAME.test(key))
      return `the feed name "${key.slice(0, 40)}" must be lowercase letters, digits or dashes`;
    if (!isRecord(entry)) return `feeds.${key} must be an object`;
    if (Object.keys(entry).some((field) => field !== 'program' && field !== 'description')) {
      return `feeds.${key} takes program and description only`;
    }
    if (typeof entry.program !== 'string' || !programPath(entry.program)) {
      return `feeds.${key}.program must be a relative path of plain segments`;
    }
    const entryDescription = text(entry.description);
    if (entryDescription === null) return `feeds.${key}.description must be short text`;
    integrations[key] = { program: entry.program, description: entryDescription };
  }
  return { name, description, integrations };
}

export function isInstallUrl(url: string): string | null {
  if (url === '' || url.length > 500) return 'the install URL is empty or too long';
  if (url.startsWith('-')) return 'the install URL must not start with a dash';
  if ([...url].some((char) => /\s/.test(char) || char < ' ' || char === '\x7f')) {
    return 'the install URL must not contain whitespace or control characters';
  }
  if (url.startsWith('/')) return null;
  const forms = [
    /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/,
    /^ssh:\/\/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/,
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/,
  ];
  return forms.some((form) => form.test(url))
    ? null
    : 'the install URL must be https://host/path, ssh://user@host/path, user@host:path or an absolute path to a local repository';
}
