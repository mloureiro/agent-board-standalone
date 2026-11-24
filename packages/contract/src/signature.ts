export const SIGNATURE_HEADERS = {
  key: 'x-board-key',
  ts: 'x-board-ts',
  nonce: 'x-board-nonce',
  sig: 'x-board-sig',
  digest: 'content-digest',
} as const;

export const SIGNATURE_MAX_SKEW_SECONDS = 120;
export const NONCE_BYTES = 16;

export type CanonicalInput = {
  method: string;
  pathWithQuery: string;
  ts: number;
  nonce: string;
  digest: string | null;
};

export const canonicalString = (input: CanonicalInput): string => {
  if (!Number.isSafeInteger(input.ts) || input.ts < 0) {
    throw new TypeError('ts must be a non-negative safe integer');
  }
  const parts = [
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(input.ts),
    input.nonce,
    input.digest ?? '',
  ];
  if (parts.some((part) => part.includes('\n')))
    throw new TypeError('a signed value must not contain a newline');
  return parts.join('\n');
};
