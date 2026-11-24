import { describe, expect, it } from 'vitest';
import { DOCTOR_CHECK_IDS, doctorReport } from '../src/index.js';

describe('doctor', () => {
  it('[contract-011] doctor check ids are unique and doctorReport refuses an unknown id', () => {
    expect(new Set(DOCTOR_CHECK_IDS).size).toBe(DOCTOR_CHECK_IDS.length);
    expect(DOCTOR_CHECK_IDS).toEqual(
      expect.arrayContaining(['profile', 'request-signature', 'legacy-dirs']),
    );
    expect(
      doctorReport.safeParse([{ name: 'node', level: 'ok', message: 'Node 24' }]).success,
    ).toBe(true);
    expect(
      doctorReport.safeParse([{ name: 'node', level: 'fail', message: 'old', hint: 'upgrade' }])
        .success,
    ).toBe(true);
    expect(doctorReport.safeParse([{ name: 'nope', level: 'ok', message: 'x' }]).success).toBe(
      false,
    );
  });
});
