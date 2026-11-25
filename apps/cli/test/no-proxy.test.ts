import { describe, expect, it } from 'vitest';

import { loopbackNoProxy } from '../src/no-proxy.js';

describe('loopbackNoProxy', () => {
  it('appends the loopback names to an empty value', () => {
    expect(loopbackNoProxy(undefined)).toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('keeps existing entries and adds only the missing loopback names', () => {
    expect(loopbackNoProxy('example.org, localhost')).toBe(
      'example.org,localhost,127.0.0.1,::1,[::1]',
    );
  });
});
