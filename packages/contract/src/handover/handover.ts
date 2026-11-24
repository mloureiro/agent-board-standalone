import { isLoopbackUrl } from '../address/rule.js';

export const HANDOVER_SCHEME = 'agentboard';
export const HANDOVER_VERSION = 1;
export const CLIENT_APP_BUNDLE_ID = 'com.mloureiro.agent-board-client';

export type HandoverProblem =
  'not-handover' | 'unknown-version' | 'bad-url' | 'not-loopback' | 'credentials';

export type HandoverResult = { ok: true; url: string } | { ok: false; problem: HandoverProblem };

const fail = (problem: HandoverProblem): HandoverResult => ({ ok: false, problem });

const parseLink = (link: string): URL | undefined => {
  try {
    const parsed = new URL(link);
    return parsed.protocol === `${HANDOVER_SCHEME}:` &&
      parsed.hostname === 'open' &&
      parsed.pathname === ''
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

const parseTarget = (value: string | null): URL | undefined => {
  if (value === null) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

export const parseHandover = (link: string): HandoverResult => {
  const parsed = parseLink(link);
  if (parsed === undefined) return fail('not-handover');
  if (parsed.searchParams.get('v') !== String(HANDOVER_VERSION)) return fail('unknown-version');

  const target = parseTarget(parsed.searchParams.get('url'));
  if (target === undefined) return fail('bad-url');
  if (target.username !== '' || target.password !== '') return fail('credentials');

  if ((target.protocol === 'http:' || target.protocol === 'https:') && isLoopbackUrl(target)) {
    return { ok: true, url: target.href };
  }

  return fail('not-loopback');
};

export const buildHandover = (url: string): string => {
  const link = `${HANDOVER_SCHEME}://open?v=${HANDOVER_VERSION}&url=${encodeURIComponent(url)}`;
  const result = parseHandover(link);
  if (!result.ok) throw new TypeError(`cannot hand over ${url}: ${result.problem}`);
  return link;
};
