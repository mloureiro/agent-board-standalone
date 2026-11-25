import { existsSync, readFileSync, rmSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { setClockOffset } from '../src/harness/clock.js';
import { createTmp } from '../src/harness/tmp.js';

describe('setClockOffset', () => {
  it('writes the offset in seconds to the clock file', () => {
    const tmp = createTmp('clock-test');
    setClockOffset({ tmp }, 1200);
    expect(readFileSync(tmp.clockFile, 'utf8')).toBe('1200');
    setClockOffset({ tmp }, -5);
    expect(readFileSync(tmp.clockFile, 'utf8')).toBe('-5');
    tmp.remove();
  });
});

describe('createTmp', () => {
  it('removes the folder on remove()', () => {
    const tmp = createTmp('remove-test', {});
    expect(existsSync(tmp.home)).toBe(true);
    tmp.remove();
    expect(existsSync(tmp.root)).toBe(false);
  });

  it('keeps the folder when E2E_KEEP_TMP=1', () => {
    const tmp = createTmp('keep-test', { E2E_KEEP_TMP: '1' });
    tmp.remove();
    expect(existsSync(tmp.root)).toBe(true);
    rmSync(tmp.root, { recursive: true, force: true });
  });
});
