export const GOLDEN_SIGNING_KEY = {
  privateKeyJwk: {
    kty: 'EC',
    x: 'DoNYYzHaxqsBPL8GWcd1bm7zaq6WLgvZgia5Avl00AU',
    y: 'wKzQ0PeqclCBTvIo7PQ0BS8zl-nMLBWQNsGr-b8N2vQ',
    crv: 'P-256',
    d: 'hzwV95Ca95SYHavUkeyHVNw0M7ORiu6nRklBQId5d4g',
  },
  publicKey:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDoNYYzHaxqsBPL8GWcd1bm7zaq6WLgvZgia5Avl00AXArNDQ96pyUIFO8ijs9DQFLzOX6cwsFZA2wav5vw3a9A',
  keyId: 'rr_1-5kEEUr00F8thATM27RT89kxftIAgIpcX0-Ousw',
} as const;

export const GOLDEN_CANONICAL = {
  withDigest:
    'POST\n/api/tasks\n1767225600\nAAAAAAAAAAAAAAAAAAAAAA\nsha-256=:z2xjziURawTjt3ailXYG4Y2Kx5jd4h4+wwiCrC374Ms=:',
  withoutDigest: 'GET\n/api/tasks?limit=20\n1767225601\nAQEBAQEBAQEBAQEBAQEBAQ\n',
} as const;
