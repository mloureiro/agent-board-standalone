import { describe, expect, it } from 'vitest';

import {
  idFromLink,
  isPrefixLength,
  resolveTaskId,
  type IdResolution,
} from '../src/commands/ids.js';

const IDS = ['abcdef0123456', 'abcxyz9876543', 'fedcba98', 'x1y2z3w4v5u6'];

function resolution(overrides: Partial<IdResolution> = {}): IdResolution & { calls: number } {
  const state = { calls: 0 };
  return {
    inRun: false,
    serverUrl: 'http://localhost:8080/',
    listIds: () => {
      state.calls += 1;
      return Promise.resolve(IDS);
    },
    ...overrides,
    get calls() {
      return state.calls;
    },
  };
}

describe('id forms', () => {
  it('treats 3 to 7 and 9 to 11 characters as prefixes and 8 or 12 or more as whole ids', () => {
    expect([2, 3, 7, 8, 9, 11, 12, 13].map(isPrefixLength)).toEqual([
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it('reads the id out of a task link of this server only', () => {
    expect(idFromLink('http://localhost:8080/t/abc123?x=1', 'http://localhost:8080')).toBe(
      'abc123',
    );
    expect(idFromLink('http://other:8080/t/abc123', 'http://localhost:8080')).toBeNull();
    expect(idFromLink('http://localhost:8080/t/', 'http://localhost:8080')).toBeNull();
  });
});

describe('outside a run', () => {
  it('resolves a unique prefix to the whole id', async () => {
    expect(await resolveTaskId('abcd', resolution())).toBe('abcdef0123456');
  });

  it('resolves a link', async () => {
    expect(await resolveTaskId('http://localhost:8080/t/fedcba98', resolution())).toBe('fedcba98');
  });

  it('resolves a link that carries a prefix', async () => {
    expect(await resolveTaskId('http://localhost:8080/t/x1y2', resolution())).toBe('x1y2z3w4v5u6');
  });

  it('returns a whole id without asking the server', async () => {
    const source = resolution();
    expect(await resolveTaskId('fedcba98', source)).toBe('fedcba98');
    expect(source.calls).toBe(0);
  });

  it('refuses an ambiguous prefix, listing the candidates', async () => {
    await expect(resolveTaskId('abc', resolution())).rejects.toThrow(/matches 2 tasks/);
  });

  it('refuses a prefix nothing starts with', async () => {
    await expect(resolveTaskId('zzz', resolution())).rejects.toThrow(
      /no task id starts with "zzz"/,
    );
  });
});

describe('inside a run', () => {
  it('accepts a full id', async () => {
    expect(await resolveTaskId('abcdef0123456', resolution({ inRun: true }))).toBe('abcdef0123456');
  });

  it('refuses a prefix and a link without asking the server', async () => {
    const source = resolution({ inRun: true });
    await expect(resolveTaskId('abcd', source)).rejects.toThrow(/full id/);
    await expect(resolveTaskId('http://localhost:8080/t/fedcba98', source)).rejects.toThrow(
      /full id/,
    );
    expect(source.calls).toBe(0);
  });
});
