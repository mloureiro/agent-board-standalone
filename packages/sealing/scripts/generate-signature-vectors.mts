import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output = resolve(process.argv[2] ?? 'packages/sealing/test/vectors/signatures.json');

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

interface NamedKey {
  name: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function makeKey(name: string): NamedKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { name, privateKey, publicKey };
}

const publicText = (key: NamedKey): string =>
  b64url(key.publicKey.export({ type: 'spki', format: 'der' }));

const keyId = (key: NamedKey): string =>
  b64url(
    createHash('sha256')
      .update(key.publicKey.export({ type: 'spki', format: 'der' }))
      .digest(),
  );

const digestOf = (body: Uint8Array): string =>
  `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

const p1363 = (key: NamedKey, canonical: string): Buffer =>
  sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  });

const keys = [makeKey('first'), makeKey('second')];
const [first, second] = keys as [NamedKey, NamedKey];

const bodies = [
  { name: 'empty', body: Buffer.alloc(0) },
  { name: 'ascii', body: Buffer.from('{"title":"hello"}', 'utf8') },
  { name: '1 KiB', body: Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251)) },
];

const lines = (
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  digest: string,
): string => [method, path, timestamp, nonce, digest].join('\n');

const canonicals = [
  {
    name: 'with digest',
    key: first,
    text: lines(
      'POST',
      '/api/tasks',
      '1767225600',
      'AAAAAAAAAAAAAAAAAAAAAA',
      digestOf(bodies[1]!.body),
    ),
  },
  {
    name: 'without digest',
    key: first,
    text: lines('GET', '/api/tasks?limit=20', '1767225601', 'AQEBAQEBAQEBAQEBAQEBAQ', ''),
  },
  {
    name: 'unicode path',
    key: second,
    text: lines(
      'PUT',
      '/api/projects/café/ícone',
      '1767225602',
      'AgICAgICAgICAgICAgICAg',
      digestOf(bodies[2]!.body),
    ),
  },
];

const cases = canonicals.map((entry) => {
  const signature = p1363(entry.key, entry.text);
  if (
    !verify(
      'sha256',
      Buffer.from(entry.text, 'utf8'),
      { key: entry.key.publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    )
  )
    throw new Error(`generated signature does not verify: ${entry.name}`);
  return {
    name: entry.name,
    key: entry.key.name,
    canonical: entry.text,
    signature: b64url(signature),
  };
});

const base = canonicals[0]!;
const baseSignature = p1363(base.key, base.text);
const refusals = [
  {
    reason: 'signature over another string',
    key: first.name,
    canonical: base.text,
    signature: b64url(p1363(first, `${base.text}x`)),
  },
  {
    reason: 'other key',
    key: first.name,
    canonical: base.text,
    signature: b64url(p1363(second, base.text)),
  },
  {
    reason: 'truncated signature',
    key: first.name,
    canonical: base.text,
    signature: b64url(baseSignature.subarray(0, 63)),
  },
  {
    reason: 'DER-encoded signature',
    key: first.name,
    canonical: base.text,
    signature: b64url(
      sign('sha256', Buffer.from(base.text, 'utf8'), { key: first.privateKey, dsaEncoding: 'der' }),
    ),
  },
];

const document = {
  note: 'Synthetic keys generated for these vectors. They protect nothing and must never be used outside tests.',
  generatedBy: 'scripts/generate-signature-vectors.mts',
  keys: keys.map((key) => ({
    name: key.name,
    privateKeyJwk: key.privateKey.export({ format: 'jwk' }),
    publicKey: publicText(key),
    keyId: keyId(key),
  })),
  cases,
  digests: bodies.map((entry) => ({
    name: entry.name,
    body: b64url(entry.body),
    digest: digestOf(entry.body),
  })),
  refusals,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
