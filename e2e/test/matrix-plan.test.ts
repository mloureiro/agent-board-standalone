import { describe, expect, it } from 'vitest';

import {
  MATRIX_CELLS,
  decideCell,
  noN1Message,
  olderParts,
  type HeadLevels,
  type MatrixCell,
  type PeerLevel,
} from '../src/matrix/plan.js';

const HEAD: HeadLevels = {
  contract: 2,
  minClient: { cli: 1, web: 1 },
  minServer: 1,
  versions: { api: '1.1.0', cli: '1.1.0', web: '1.1.0' },
};

const cell = (id: string): MatrixCell => {
  const found = MATRIX_CELLS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
};

const oldClient: PeerLevel = { version: '1.0.0', contract: 1, minServer: 1 };
const oldServer: PeerLevel = {
  version: '1.0.0',
  contract: 1,
  minClient: { cli: 1, web: 1 },
};

describe('MATRIX_CELLS', () => {
  it('[repo-003] holds the four cells of the dependency decision', () => {
    expect(MATRIX_CELLS.map((entry) => entry.id)).toEqual([
      'api-n/cli-n-1',
      'api-n/web-n-1',
      'api-n-1/cli-n',
      'api-n-1/web-n',
    ]);
    expect(olderParts()).toEqual(['cli', 'web', 'api']);
  });
});

describe('decideCell', () => {
  it('[repo-003] reports "no N-1 for <part>" for every cell without a release', () => {
    for (const entry of MATRIX_CELLS) {
      const decision = decideCell(entry, null, null, HEAD);
      expect(decision).toEqual({
        kind: 'no-n-1',
        cell: entry,
        message: noN1Message(entry.older),
      });
    }
    expect(noN1Message('api')).toBe('no N-1 for api');
  });

  it('[repo-003] runs a cell whose N-1 peer the minimums still admit', () => {
    expect(decideCell(cell('api-n/cli-n-1'), 'cli-v1.0.0', oldClient, HEAD).kind).toBe('run');
    expect(decideCell(cell('api-n/web-n-1'), 'web-v1.0.0', oldClient, HEAD).kind).toBe('run');
    expect(decideCell(cell('api-n-1/cli-n'), 'api-v1.0.0', oldServer, HEAD).kind).toBe('run');
    expect(decideCell(cell('api-n-1/web-n'), 'api-v1.0.0', oldServer, HEAD).kind).toBe('run');
  });

  it('[repo-003] refuses the CLI cell when MIN_CLIENT excludes the N-1 CLI, and only that cell', () => {
    const head = { ...HEAD, minClient: { cli: 2, web: 1 } };
    const decision = decideCell(cell('api-n/cli-n-1'), 'cli-v1.0.0', oldClient, head);
    expect(decision).toMatchObject({ kind: 'refusal', reason: 'client-too-old' });
    expect(decision.message).toContain('1.0.0');
    expect(decision.message).toContain('1.1.0');
    expect(decideCell(cell('api-n/web-n-1'), 'web-v1.0.0', oldClient, head).kind).toBe('run');
    expect(decideCell(cell('api-n-1/cli-n'), 'api-v1.0.0', oldServer, head).kind).toBe('run');
    expect(decideCell(cell('api-n-1/web-n'), 'api-v1.0.0', oldServer, head).kind).toBe('run');
  });

  it('[repo-003] refuses the web cell when MIN_CLIENT excludes the N-1 web build', () => {
    const head = { ...HEAD, minClient: { cli: 1, web: 2 } };
    expect(decideCell(cell('api-n/web-n-1'), 'web-v1.0.0', oldClient, head)).toMatchObject({
      kind: 'refusal',
      reason: 'client-too-old',
    });
    expect(decideCell(cell('api-n/cli-n-1'), 'cli-v1.0.0', oldClient, head).kind).toBe('run');
  });

  it('[repo-003] refuses the N-1 API cells when MIN_SERVER excludes the N-1 API', () => {
    const head = { ...HEAD, minServer: 2 };
    for (const id of ['api-n-1/cli-n', 'api-n-1/web-n']) {
      expect(decideCell(cell(id), 'api-v1.0.0', oldServer, head)).toMatchObject({
        kind: 'refusal',
        reason: 'client-too-new',
      });
    }
    expect(decideCell(cell('api-n/cli-n-1'), 'cli-v1.0.0', oldClient, head).kind).toBe('run');
    expect(decideCell(cell('api-n/web-n-1'), 'web-v1.0.0', oldClient, head).kind).toBe('run');
  });

  it('[repo-003] refuses the N-1 API cell when the N-1 API demands a newer client than HEAD sends', () => {
    const demanding: PeerLevel = { ...oldServer, minClient: { cli: 3, web: 1 } };
    expect(decideCell(cell('api-n-1/cli-n'), 'api-v1.0.0', demanding, HEAD)).toMatchObject({
      kind: 'refusal',
      reason: 'client-too-old',
    });
    expect(decideCell(cell('api-n-1/web-n'), 'api-v1.0.0', demanding, HEAD).kind).toBe('run');
  });

  it('[repo-003] refuses the N-1 client cell when the N-1 client needs a newer server', () => {
    const demanding: PeerLevel = { ...oldClient, minServer: 3 };
    expect(decideCell(cell('api-n/cli-n-1'), 'cli-v1.0.0', demanding, HEAD)).toMatchObject({
      kind: 'refusal',
      reason: 'client-too-new',
    });
  });

  it('[repo-003] runs the web cell when the web build reports no minimum server', () => {
    const web: PeerLevel = { version: '1.0.0', contract: 1 };
    expect(decideCell(cell('api-n/web-n-1'), 'web-v1.0.0', web, HEAD).kind).toBe('run');
  });

  it('[repo-003] fails loudly when a built N-1 reported no level', () => {
    expect(() => decideCell(cell('api-n/cli-n-1'), 'cli-v1.0.0', null, HEAD)).toThrow(
      'contract level is unknown',
    );
    expect(() =>
      decideCell(cell('api-n-1/cli-n'), 'api-v1.0.0', { version: '1.0.0', contract: 1 }, HEAD),
    ).toThrow('minimum client levels');
  });
});
