import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

const INDEX = 'index.html';

export type Resolved = { kind: 'file'; path: string } | { kind: 'refused' } | { kind: 'missing' };

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

export const contentTypeOf = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

const safeSegments = (rawPath: string): string[] | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || !decoded.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '..') return null;
    if (segment !== '' && segment !== '.') segments.push(segment);
  }
  return segments;
};

export const openRoot = async (root: string) => {
  const real = await realpath(root);
  const inside = (path: string): boolean => path === real || path.startsWith(real + sep);

  const existingFile = async (candidate: string): Promise<string | null> => {
    try {
      const resolved = (await stat(candidate)).isDirectory() ? join(candidate, INDEX) : candidate;
      const path = await realpath(resolved);
      return inside(path) && (await stat(path)).isFile() ? path : null;
    } catch {
      return null;
    }
  };

  return async (rawPath: string, asset: boolean): Promise<Resolved> => {
    const segments = safeSegments(rawPath);
    if (segments === null) return { kind: 'refused' };
    const found = await existingFile(join(real, ...segments));
    if (found !== null) return { kind: 'file', path: found };
    if (asset) return { kind: 'missing' };
    const page = await existingFile(join(real, INDEX));
    return page === null ? { kind: 'missing' } : { kind: 'file', path: page };
  };
};
