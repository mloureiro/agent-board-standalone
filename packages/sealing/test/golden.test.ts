import { describe, expect, it } from 'vitest';
import {
  bindings,
  blindIndex,
  contentDigest,
  decodeDataKey,
  deriveKeys,
  formatRecoveryKey,
  fromBase64Url,
  importPublicKey,
  KeyError,
  open,
  parseRecoveryKey,
  replacePassphrase,
  sign,
  signingKeyId,
  tokenHash,
  toBase64Url,
  unlockKeys,
  unwrapSlot,
  verify,
  type Binding,
  type Keys,
  type KeySetup,
} from '../src/index.js';
import { additionalData, encryptBytes } from '../src/envelope.js';
import bindingVectors from './vectors/bindings.json' with { type: 'json' };
import blindIndexVectors from './vectors/blind-indexes.json' with { type: 'json' };
import envelopeVectors from './vectors/envelopes.json' with { type: 'json' };
import keyVectors from './vectors/keys.json' with { type: 'json' };
import recoveryVectors from './vectors/recovery-keys.json' with { type: 'json' };
import signatureVectors from './vectors/signatures.json' with { type: 'json' };
import slotVectors from './vectors/slots.json' with { type: 'json' };
import tokenVectors from './vectors/token-hashes.json' with { type: 'json' };

interface Row {
  kind: string;
  id: string;
  createdBy?: string;
  scheduleId?: string | null;
  agent: string | null;
  forkOf?: string | null;
}

async function keysOf(owner: string, as: string = owner): Promise<Keys> {
  const vector = keyVectors.owners.find((entry) => entry.owner === owner);
  if (vector === undefined) throw new Error(`unknown owner ${owner}`);
  return deriveKeys(decodeDataKey(vector.dataKeyText), as);
}

const originOf = (row: Row) =>
  row.kind === 'schedule' || row.scheduleId
    ? { schedule: row.kind === 'schedule' ? row.id : String(row.scheduleId) }
    : { task: row.id };

type Args = Record<string, unknown> & { row?: Row };

function build(builder: string, args: Args): Binding {
  const { row } = args;
  const call = bindings as unknown as Record<string, (arg?: unknown, second?: unknown) => Binding>;
  const fn = call[builder];
  if (fn === undefined) throw new Error(`unknown builder ${builder}`);
  if (builder === 'input' && row)
    return fn({
      origin: originOf(row),
      creator: row.createdBy ?? 'user',
      forkOf: row.forkOf ?? null,
      agent: row.agent,
      directoryId: (args['directoryId'] as string | undefined) ?? null,
    });
  if (builder === 'workdir' && row)
    return row.kind === 'task' && row.scheduleId
      ? fn({ task: row.id, schedule: row.scheduleId })
      : fn(originOf(row));
  if (builder === 'occurrenceWorkdir' && row)
    return fn({ taskId: row.id, scheduleId: row.scheduleId });
  if (row) return fn(originOf(row));
  if (builder === 'machineDocument') return fn(args['field'], args['machine']);
  if (['sharedAgents', 'links', 'titles', 'settings'].includes(builder)) return fn(args['version']);
  if (builder === 'pr' || builder === 'watches') return fn(args['taskId']);
  if (builder === 'projectName' || builder === 'projectIcon') return fn(args['projectId']);
  if (builder === 'directoryPath' || builder === 'directoryRepo') return fn(args['directoryId']);
  return fn(args);
}

describe('golden vectors', () => {
  for (const vector of keyVectors.owners)
    it(`[sealing-003] key id of ${vector.owner} matches the reference`, async () => {
      const keys = await keysOf(vector.owner);
      expect(keys.keyId).toBe(vector.keyId);
      expect(toBase64Url(decodeDataKey(vector.dataKeyText))).toBe(vector.dataKey);
    });

  for (const entry of envelopeVectors.cases) {
    const title = `${entry.field} envelope of ${entry.owner} (${entry.plaintext.length} chars)`;
    it(`[sealing-002] opens ${title}`, async () => {
      const keys = await keysOf(entry.owner);
      const binding = { field: entry.field, context: entry.context } as Binding;
      await expect(open(keys, binding, entry.envelope)).resolves.toBe(entry.plaintext);
    });

    it(`[sealing-002] sealing with the recorded nonce reproduces ${title}`, async () => {
      const keys = await keysOf(entry.owner);
      const body = fromBase64Url(entry.envelope.slice('abe1.'.length));
      if (body === null) throw new Error('vector is not canonical');
      const key = entry.field.startsWith('tr.') ? keys.transcript : keys.content;
      const sealed = await encryptBytes(
        key,
        additionalData(entry.owner, entry.field, entry.context),
        new TextEncoder().encode(entry.plaintext),
        body.slice(0, 12),
      );
      expect(`abe1.${toBase64Url(sealed)}`).toBe(entry.envelope);
    });
  }

  for (const entry of envelopeVectors.refusals)
    it(`[sealing-002] refuses ${entry.reason}`, async () => {
      const keys = await keysOf(
        entry.owner,
        'openAsOwner' in entry ? entry.openAsOwner : entry.owner,
      );
      const binding = { field: entry.field, context: entry.context } as Binding;
      await expect(open(keys, binding, entry.envelope)).rejects.toThrow();
    });

  for (const entry of blindIndexVectors.cases)
    it(`[sealing-007] blind index of ${entry.value.slice(0, 20)} (${entry.value.length} chars) for ${entry.owner} matches the reference`, async () => {
      const keys = await keysOf(entry.owner);
      await expect(blindIndex(keys, entry.value)).resolves.toBe(entry.index);
    });

  for (const entry of bindingVectors.cases)
    it(`[sealing-005] binding ${entry.builder} gives the reference context ${entry.context}`, () => {
      const built = build(entry.builder, entry.args as Args);
      expect(built).toEqual({ field: entry.field, context: entry.context });
    });

  for (const entry of tokenVectors.cases)
    it(`[sealing-002] token hash of ${entry.token.slice(0, 4)} token matches the reference board`, async () => {
      await expect(tokenHash(entry.token)).resolves.toBe(entry.hash);
    });

  for (const entry of slotVectors.setups) {
    const setup = entry.setup as KeySetup;
    const label = `${entry.owner} (m=${entry.kdf.m}, t=${entry.kdf.t})`;

    it(`[sealing-004] unlocks ${label} with the passphrase and with the recovery key`, async () => {
      const viaPassphrase = await unlockKeys(entry.owner, setup, {
        kind: 'passphrase',
        passphrase: entry.passphrase,
      });
      const viaRecovery = await unlockKeys(entry.owner, setup, {
        kind: 'recovery',
        recoveryKey: entry.recoveryKey,
      });
      expect(viaPassphrase.keyId).toBe(entry.keyId);
      expect(viaRecovery.keyId).toBe(entry.keyId);
      const dataKey = await unwrapSlot(setup.slots, {
        kind: 'passphrase',
        passphrase: entry.passphrase,
      });
      expect(toBase64Url(dataKey)).toBe(entry.dataKey);
    });

    it(`[sealing-004] a normalised passphrase variant unlocks ${label} and a different capitalisation does not`, async () => {
      for (const variant of slotVectors.variants) {
        const attempt = unlockKeys(entry.owner, setup, {
          kind: 'passphrase',
          passphrase: variant.typed,
        });
        if (variant.opens) await expect(attempt).resolves.toMatchObject({ keyId: entry.keyId });
        else await expect(attempt).rejects.toThrow(KeyError);
      }
    });
  }

  it('[sealing-004] the replaced passphrase opens the same data key and key id; the recovery slot is unchanged', async () => {
    const { replaced } = slotVectors;
    const before = slotVectors.setups.find((entry) => entry.owner === replaced.owner);
    if (before === undefined) throw new Error('setup of the replacement is missing');
    const setup = { keyId: replaced.keyId, slots: replaced.slots } as KeySetup;
    const keys = await unlockKeys(replaced.owner, setup, {
      kind: 'passphrase',
      passphrase: replaced.newPassphrase,
    });
    expect(keys.keyId).toBe(replaced.keyId);
    expect(replaced.keyId).toBe(before.keyId);
    expect(replaced.slots[1]).toEqual(before.setup.slots[1]);
    const dataKey = await unwrapSlot(setup.slots, {
      kind: 'passphrase',
      passphrase: replaced.newPassphrase,
    });
    expect(toBase64Url(dataKey)).toBe(replaced.dataKey);
    await expect(
      unlockKeys(replaced.owner, setup, { kind: 'passphrase', passphrase: before.passphrase }),
    ).rejects.toThrow(KeyError);

    const again = await replacePassphrase(
      replaced.owner,
      before.setup as KeySetup,
      { kind: 'recovery', recoveryKey: before.recoveryKey },
      replaced.newPassphrase,
      replaced.kdf,
    );
    expect(again.keyId).toBe(before.keyId);
    expect(again.slots[1]).toEqual(before.setup.slots[1]);
    await expect(
      unlockKeys(replaced.owner, again, { kind: 'passphrase', passphrase: replaced.newPassphrase }),
    ).resolves.toMatchObject({ keyId: before.keyId });
  });

  for (const entry of recoveryVectors.cases)
    it(`[sealing-004] recovery key text ${entry.text.slice(0, 9)} encodes and parses`, async () => {
      const bytes = fromBase64Url(entry.bytes);
      if (bytes === null) throw new Error('vector is not canonical');
      await expect(formatRecoveryKey(bytes)).resolves.toBe(entry.text);
      await expect(parseRecoveryKey(entry.text)).resolves.toEqual(bytes);
    });

  for (const entry of recoveryVectors.typed)
    it(`[sealing-004] typed recovery key ${JSON.stringify(entry.input.slice(0, 24))} parses`, async () => {
      const parsed = await parseRecoveryKey(entry.input);
      expect(toBase64Url(parsed)).toBe(entry.bytes);
    });

  for (const entry of recoveryVectors.refusals)
    it(`[sealing-004] recovery key refused for ${entry.reason}`, async () => {
      await expect(parseRecoveryKey(entry.input)).rejects.toThrow(KeyError);
    });

  const signingKeys = new Map(signatureVectors.keys.map((key) => [key.name, key]));
  const signingKey = (name: string) => {
    const key = signingKeys.get(name);
    if (key === undefined) throw new Error(`unknown signing key ${name}`);
    return key;
  };

  it('[contract-014] verifies the signature vectors and refuses the refusal cases', async () => {
    for (const key of signatureVectors.keys)
      await expect(signingKeyId(key.publicKey)).resolves.toBe(key.keyId);
    for (const entry of signatureVectors.cases) {
      const publicKey = await importPublicKey(signingKey(entry.key).publicKey);
      await expect(verify(publicKey, entry.canonical, entry.signature)).resolves.toBe(true);
    }
    for (const entry of signatureVectors.refusals) {
      const publicKey = await importPublicKey(signingKey(entry.key).publicKey);
      await expect(verify(publicKey, entry.canonical, entry.signature)).resolves.toBe(false);
    }
  });

  it('[contract-014] a signature made here verifies against the vector public key', async () => {
    const key = signingKey('first');
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      key.privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const publicKey = await importPublicKey(key.publicKey);
    const signature = await sign(privateKey, 'GET\n/ok\n1\nn\n');
    await expect(verify(publicKey, 'GET\n/ok\n1\nn\n', signature)).resolves.toBe(true);
  });

  for (const entry of signatureVectors.digests)
    it(`[contract-014] digest of ${entry.name} matches`, async () => {
      const body = fromBase64Url(entry.body);
      if (body === null) throw new Error('vector is not canonical');
      await expect(contentDigest(body)).resolves.toBe(entry.digest);
    });
});
