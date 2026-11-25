import { describe, expect, it } from 'vitest';
import { nMinusOne } from '../src/n-minus-one.js';

describe('nMinusOne', () => {
  it('[repo-008] returns null when there are no tags', () => {
    expect(nMinusOne('api', '1.1.0', [])).toBeNull();
  });

  it('[repo-008] ignores the tags of other parts', () => {
    expect(nMinusOne('api', '1.1.0', ['cli-v1.0.0', 'web-v1.0.0', 'contract-v1.0.0'])).toBeNull();
  });

  it('[repo-008] does not mistake a part whose name starts with another part', () => {
    expect(nMinusOne('client', '2.0.0', ['client-app-v1.0.0'])).toBeNull();
    expect(nMinusOne('server', '2.0.0', ['server-app-v1.0.0'])).toBeNull();
  });

  it('[repo-008] returns the one lower tag', () => {
    expect(nMinusOne('api', '1.1.0', ['api-v1.0.0'])).toBe('api-v1.0.0');
  });

  it('[repo-008] picks the newest lower tag by numeric order', () => {
    const tags = ['api-v1.2.0', 'api-v1.10.0', 'api-v1.9.3', 'api-v0.9.0'];
    expect(nMinusOne('api', '1.11.0', tags)).toBe('api-v1.10.0');
  });

  it('[repo-008] ignores a tag equal to or above HEAD', () => {
    expect(nMinusOne('api', '1.0.0', ['api-v1.0.0'])).toBeNull();
    expect(nMinusOne('api', '1.0.0', ['api-v1.0.0', 'api-v2.0.0', 'api-v0.9.0'])).toBe(
      'api-v0.9.0',
    );
  });

  it('[repo-008] ignores pre-release tags', () => {
    expect(nMinusOne('api', '1.1.0', ['api-v1.0.0-rc.1', 'api-v1.0.1-beta'])).toBeNull();
    expect(nMinusOne('api', '1.1.0', ['api-v1.0.0', 'api-v1.0.5-rc.1'])).toBe('api-v1.0.0');
  });

  it('[repo-008] ignores malformed tags', () => {
    const tags = ['api-v1', 'api-v1.0', 'api-v1.0.0.0', 'api-vx.y.z', 'api-1.0.0', 'api-v01.0.0x'];
    expect(nMinusOne('api', '2.0.0', tags)).toBeNull();
  });

  it('[repo-008] treats a pre-release HEAD as sitting below its own release', () => {
    expect(nMinusOne('api', '1.1.0-rc.1', ['api-v1.1.0', 'api-v1.0.0'])).toBe('api-v1.0.0');
  });

  it('[repo-008] refuses a HEAD version that is not semver', () => {
    expect(() => nMinusOne('api', 'next', [])).toThrow('not a semver version');
  });
});
