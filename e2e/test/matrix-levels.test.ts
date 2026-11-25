import { describe, expect, it } from 'vitest';

import { parseApiLevel, parseCliLevel, parseWebLevel } from '../src/matrix/levels.js';
import {
  MATRIX_CELLS,
  decideCell,
  refusalEnvironment,
  type HeadLevels,
} from '../src/matrix/plan.js';

const HEAD: HeadLevels = {
  contract: 2,
  minClient: { cli: 2, web: 1 },
  minServer: 1,
  versions: { api: '1.1.0', cli: '1.2.0', web: '1.3.0' },
};

describe('parseApiLevel', () => {
  it('[repo-003] reads the contract level and minimum clients from the version answer', () => {
    expect(
      parseApiLevel({
        contract: 1,
        minClient: { cli: 1, web: 1 },
        server: { version: '1.0.0', commit: null },
        features: [],
      }),
    ).toEqual({ version: '1.0.0', contract: 1, minClient: { cli: 1, web: 1 } });
  });

  it('[repo-003] refuses an answer without a contract level', () => {
    expect(() =>
      parseApiLevel({ minClient: { cli: 1, web: 1 }, server: { version: '1.0.0' } }),
    ).toThrow('contract');
    expect(() => parseApiLevel('nope')).toThrow('not an object');
  });
});

describe('parseCliLevel', () => {
  it('[repo-003] reads a plain contract level with an optional minimum server', () => {
    expect(parseCliLevel({ version: '1.0.0', contract: 1 })).toEqual({
      version: '1.0.0',
      contract: 1,
    });
    expect(parseCliLevel({ version: '1.0.0', contract: 2, minServer: 1 })).toEqual({
      version: '1.0.0',
      contract: 2,
      minServer: 1,
    });
  });

  it('[repo-003] reads a contract range as level and minimum server', () => {
    expect(parseCliLevel({ version: '1.0.0', contract: { min: 1, max: 3 } })).toEqual({
      version: '1.0.0',
      contract: 3,
      minServer: 1,
    });
  });
});

describe('parseWebLevel', () => {
  it('[repo-003] reads version.json', () => {
    expect(parseWebLevel({ version: '1.0.0', contract: 1 })).toEqual({
      version: '1.0.0',
      contract: 1,
    });
    expect(() => parseWebLevel({ version: '', contract: 1 })).toThrow('version');
  });
});

describe('refusalEnvironment', () => {
  it('[repo-003] names the cell, the reason and both versions for the refusal test', () => {
    const cell = MATRIX_CELLS.find((entry) => entry.id === 'api-n/cli-n-1');
    if (!cell) throw new Error('cell missing');
    const level = { version: '1.0.0', contract: 1, minServer: 1 };
    const decision = decideCell(cell, 'cli-v1.0.0', level, HEAD);
    if (decision.kind !== 'refusal') throw new Error('expected a refusal');
    expect(refusalEnvironment(decision, level, HEAD)).toEqual({
      E2E_MATRIX_CELL: 'api-n/cli-n-1',
      E2E_MATRIX_EXPECT: 'refusal',
      E2E_MATRIX_REFUSAL: 'client-too-old',
      E2E_MATRIX_PEER_VERSION: '1.0.0',
      E2E_MATRIX_PEER_CONTRACT: '1',
      E2E_MATRIX_HEAD_VERSION: '1.1.0',
    });
  });
});
