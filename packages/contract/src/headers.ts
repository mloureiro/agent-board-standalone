export const WEB_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const DATA_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'content-security-policy': "sandbox; default-src 'none'",
  'content-disposition': 'attachment',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
};

export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': WEB_CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export const ASSET_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
};

export const HSTS_HEADER: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export const CORS_ALLOWED_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-headers':
    'x-board-contract, x-board-client, x-board-key, x-board-ts, x-board-nonce, x-board-sig, content-digest, authorization, content-type',
};

export const VERSION_CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
};
