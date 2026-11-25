import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyAllowList,
  formatFinding,
  parseAllowList,
  scanText,
  type AllowEntry,
} from '../src/hygiene.js';

const BODY = 'A'.repeat(43);
const HEX = '0123abcd';

const SAMPLES: Record<string, string> = {
  'home-path-macos': `cd ${'/Users/'}alice/work`,
  'home-path-linux': `cd ${'/home/'}alice/work`,
  'home-path-windows': `cd ${'C:\\Users\\'}alice\\work`,
  'session-id': `id: local_${HEX}-${'0123'}-${'4567'}-${'89ab'}-${HEX}${'cdef'}`,
  'pem-private-key': `${'-----BEGIN '}EC PRIVATE KEY-----`,
  'jwk-private-d': `{ "d": "${'B'.repeat(43)}" }`,
  'board-token': `token = ${'abs_'}${BODY}`,
  'github-token': `${'ghp_'}${'C'.repeat(36)}`,
  'anthropic-key': `${'sk-ant-'}${'D'.repeat(30)}`,
  'aws-access-key': `${'AKIA'}${'E'.repeat(16)}`,
  'slack-token': `${'xoxb-'}${'1234567890'}-abcdef`,
};

describe('scanText', () => {
  for (const [rule, line] of Object.entries(SAMPLES)) {
    it(`[repo-007] flags ${rule} with its line number`, () => {
      expect(scanText('a.txt', `clean\n${line}\nclean`)).toEqual([
        { path: 'a.txt', line: 2, rule },
      ]);
    });
  }

  it('[repo-007] accepts the other board token prefixes', () => {
    expect(scanText('a.txt', `${'abc_'}${BODY}\n${'abm_'}${BODY}`).map((f) => f.rule)).toEqual([
      'board-token',
      'board-token',
    ]);
  });

  it('[repo-007] passes ordinary text and short or placeholder values', () => {
    const text = [
      'const home = process.env.HOME;',
      'token abs_<43 characters>',
      `"d": "short"`,
      'see /Users/<name>/ in the docs',
      'ssh://git@example.test/home',
    ].join('\n');
    expect(scanText('a.txt', text)).toEqual([]);
  });
});

describe('applyAllowList', () => {
  const findings = [
    { path: 'a.txt', line: 1, rule: 'board-token' },
    { path: 'a.txt', line: 2, rule: 'session-id' },
    { path: 'b.txt', line: 1, rule: 'board-token' },
  ];
  const allow: AllowEntry[] = [{ path: 'a.txt', rule: 'board-token', reason: 'vector' }];

  it('[repo-007] suppresses only the allowed path and rule', () => {
    expect(applyAllowList(findings, allow)).toEqual([findings[1], findings[2]]);
  });

  it('[repo-007] suppresses nothing with an empty list', () => {
    expect(applyAllowList(findings, [])).toEqual(findings);
  });
});

describe('parseAllowList', () => {
  it('[repo-007] reads entries with a reason', () => {
    expect(parseAllowList('[{"path":"a","rule":"r","reason":"why"}]')).toEqual([
      { path: 'a', rule: 'r', reason: 'why' },
    ]);
  });

  it('[repo-007] refuses an entry without a reason', () => {
    expect(() => parseAllowList('[{"path":"a","rule":"r","reason":" "}]')).toThrow('entry 0');
    expect(() => parseAllowList('[{"path":"a","rule":"r"}]')).toThrow('entry 0');
  });

  it('[repo-007] refuses a document that is not an array', () => {
    expect(() => parseAllowList('{}')).toThrow('JSON array');
  });
});

describe('formatFinding', () => {
  it('[repo-007] prints path:line rule', () => {
    expect(formatFinding({ path: 'a.txt', line: 3, rule: 'session-id' })).toBe(
      'a.txt:3 session-id',
    );
  });
});

describe('the repository', () => {
  it('[repo-007] passes the scan with its allow list', () => {
    const script = fileURLToPath(new URL('../src/hygiene.ts', import.meta.url));
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(output).toMatch(/0 findings/);
  });
});
