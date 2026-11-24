import { describe, expect, it } from 'vitest';
import { canonicalString, NONCE_BYTES, SIGNATURE_MAX_SKEW_SECONDS } from '../src/index.js';

const base = {
  method: 'post',
  pathWithQuery: '/api/tasks?x=1',
  ts: 1_700_000_000,
  nonce: 'bm9uY2Vub25jZW5vbmNl',
};

describe('signature', () => {
  it('[contract-014] canonicalString joins method, path with query, timestamp, nonce and digest with newlines', () => {
    const digest = 'sha-256=:abc=:';
    expect(canonicalString({ ...base, digest })).toBe(
      `POST\n/api/tasks?x=1\n1700000000\nbm9uY2Vub25jZW5vbmNl\n${digest}`,
    );
    expect(canonicalString({ ...base, method: 'GET', digest: null })).toBe(
      'GET\n/api/tasks?x=1\n1700000000\nbm9uY2Vub25jZW5vbmNl\n',
    );
    expect(SIGNATURE_MAX_SKEW_SECONDS).toBe(120);
    expect(NONCE_BYTES).toBe(16);
  });

  it('[contract-014] canonicalString refuses a newline in a value and a bad timestamp', () => {
    expect(() => canonicalString({ ...base, pathWithQuery: '/a\nb', digest: null })).toThrow(
      TypeError,
    );
    expect(() => canonicalString({ ...base, nonce: 'a\nb', digest: null })).toThrow(TypeError);
    expect(() => canonicalString({ ...base, digest: 'x\ny' })).toThrow(TypeError);
    expect(() => canonicalString({ ...base, ts: -1, digest: null })).toThrow(TypeError);
    expect(() => canonicalString({ ...base, ts: 1.5, digest: null })).toThrow(TypeError);
    expect(() =>
      canonicalString({ ...base, ts: Number.MAX_SAFE_INTEGER + 1, digest: null }),
    ).toThrow(TypeError);
  });
});
