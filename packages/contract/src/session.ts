export const SESSION_COOKIE_HTTPS = '__Host-board-session';
export const SESSION_COOKIE_HTTP = 'board-session';

export const sessionCookieName = (scheme: 'http' | 'https'): string =>
  scheme === 'https' ? SESSION_COOKIE_HTTPS : SESSION_COOKIE_HTTP;

export const TOKEN_PREFIXES = { session: 'abs_', client: 'abc_', machine: 'abm_' } as const;

export type TokenKind = keyof typeof TOKEN_PREFIXES;

export const TOKEN_PATTERN = /^(abs|abc|abm)_[A-Za-z0-9_-]{43}$/;

export const tokenKind = (value: string): TokenKind | null => {
  if (!TOKEN_PATTERN.test(value)) return null;
  const prefix = value.slice(0, 4);
  const kinds = Object.keys(TOKEN_PREFIXES) as TokenKind[];
  return kinds.find((kind) => TOKEN_PREFIXES[kind] === prefix) ?? null;
};

export const AUTHORIZATION_TOKEN_KINDS = [
  'client',
  'machine',
] as const satisfies readonly TokenKind[];

export const JSON_CONTENT_TYPE = 'application/json';

export const isJsonContentType = (header: string | null | undefined): boolean => {
  if (!header) return false;
  const [type] = header.split(';');
  return type!.trim().toLowerCase() === JSON_CONTENT_TYPE;
};
