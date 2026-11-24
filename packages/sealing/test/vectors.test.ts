import { describe, expect, it } from 'vitest';
import bindings from './vectors/bindings.json' with { type: 'json' };
import blindIndexes from './vectors/blind-indexes.json' with { type: 'json' };
import envelopes from './vectors/envelopes.json' with { type: 'json' };
import keys from './vectors/keys.json' with { type: 'json' };
import recoveryKeys from './vectors/recovery-keys.json' with { type: 'json' };
import slots from './vectors/slots.json' with { type: 'json' };
import tokenHashes from './vectors/token-hashes.json' with { type: 'json' };

const REFUSAL_REASONS = [
  'tampered-ciphertext',
  'tampered-nonce',
  'tampered-tag',
  'wrong-owner',
  'wrong-field',
  'wrong-context',
  'wrong-key-kind',
  'non-canonical-base64url',
  'too-short',
  'bad-prefix',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error('expected a list of objects');
  return value;
}

function text(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  if (typeof value !== 'string') throw new Error(`expected ${key} to be a string`);
  return value;
}

describe('golden vectors', () => {
  it('[sealing-002] envelope vectors cover every refusal reason and both key kinds', () => {
    const reasons = records(envelopes.refusals).map((entry) => entry['reason']);
    expect(new Set(reasons)).toEqual(new Set(REFUSAL_REASONS));
    const fields = records(envelopes.cases).map((entry) => text(entry, 'field'));
    expect(fields.some((field) => field.startsWith('tr.'))).toBe(true);
    expect(fields.some((field) => !field.startsWith('tr.'))).toBe(true);
  });

  it('[sealing-002] every envelope vector starts with abe1. and every index with abh1.', () => {
    for (const entry of records(envelopes.cases))
      expect(text(entry, 'envelope')).toMatch(/^abe1\.[A-Za-z0-9_-]+$/);
    for (const entry of records(blindIndexes.cases))
      expect(text(entry, 'index')).toMatch(/^abh1\.[A-Za-z0-9_-]{43}$/);
  });

  it('[sealing-003] each owner has a 16-hex key id', () => {
    const owners = records(keys.owners);
    expect(owners.map((entry) => entry['owner'])).toEqual(['vector-owner', 'vector-owner-2']);
    for (const entry of owners) {
      expect(text(entry, 'keyId')).toMatch(/^[0-9a-f]{16}$/);
      expect(text(entry, 'dataKeyText')).toBe(`abk1_${text(entry, 'dataKey')}`);
    }
  });

  it('[sealing-007] the same value has different indexes for the two owners', () => {
    const cases = records(blindIndexes.cases);
    const byValue = new Map<string, Set<string>>();
    for (const entry of cases) {
      const indexes = byValue.get(text(entry, 'value')) ?? new Set<string>();
      indexes.add(text(entry, 'index'));
      byValue.set(text(entry, 'value'), indexes);
    }
    expect(byValue.size).toBe(5);
    for (const indexes of byValue.values()) expect(indexes.size).toBe(2);
  });

  it('[sealing-004] slot vectors hold a passphrase and a recovery slot', () => {
    for (const setup of records(slots.setups)) {
      const kinds = records(records([setup['setup']])[0]?.['slots']).map((slot) => slot['kind']);
      expect(kinds).toEqual(['passphrase', 'recovery']);
      expect(text(setup, 'recoveryKey')).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
    }
    expect(records(slots.variants).some((variant) => variant['opens'] === true)).toBe(true);
    expect(slots.replaced.keyId).toBe(slots.replaced.setup.keyId);
  });

  it('[sealing-002] token hashes are 64 lower-case hex characters', () => {
    const cases = records(tokenHashes.cases);
    expect(cases.map((entry) => text(entry, 'token').slice(0, 4))).toEqual([
      'abs_',
      'abm_',
      'abc_',
    ]);
    for (const entry of cases) expect(text(entry, 'hash')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[sealing-002] binding vectors carry a field and a context and mark the new builders', () => {
    const cases = records(bindings.cases);
    for (const entry of cases) {
      expect(text(entry, 'field')).not.toBe('');
      expect(text(entry, 'context')).not.toContain('\0');
    }
    const added = new Set(
      cases.filter((entry) => entry['new'] === true).map((entry) => entry['builder']),
    );
    expect(added).toEqual(
      new Set([
        'input',
        'projectName',
        'projectIcon',
        'directoryPath',
        'directoryRepo',
        'settings',
      ]),
    );
  });

  it('[sealing-002] recovery key vectors are 56 characters in groups of four', () => {
    for (const entry of records(recoveryKeys.cases))
      expect(text(entry, 'text')).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
    expect(new Set(records(recoveryKeys.refusals).map((entry) => entry['reason']))).toEqual(
      new Set(['checksum', 'length', 'alphabet', 'spare-bits']),
    );
  });
});
