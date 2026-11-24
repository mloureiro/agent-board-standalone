import { describe, expect, it } from 'vitest';
import {
  bindings,
  blindIndex,
  decodeDataKey,
  deriveKeys,
  fromBase64Url,
  open,
  tokenHash,
  toBase64Url,
  type Binding,
  type Keys,
} from '../src/index.js';
import { additionalData, encryptBytes } from '../src/envelope.js';
import bindingVectors from './vectors/bindings.json' with { type: 'json' };
import blindIndexVectors from './vectors/blind-indexes.json' with { type: 'json' };
import envelopeVectors from './vectors/envelopes.json' with { type: 'json' };
import keyVectors from './vectors/keys.json' with { type: 'json' };
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
});
