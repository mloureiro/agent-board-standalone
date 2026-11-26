import { describe, expect, it } from 'vitest';
import { identityOf, parseCodesign, signingProblems } from '../scripts/signing.ts';

const adHoc = (path: string): string => `Executable=${path}
Identifier=thing
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=175335 flags=0x2(adhoc) hashes=5473+2 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
`;

const named = (
  path: string,
  team: string,
  authority = 'Developer ID Application: Example',
): string => `Executable=${path}
Identifier=thing
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=900 flags=0x10000(runtime) hashes=20+7 location=embedded
Signature size=9000
Authority=${authority}
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=${team}
`;

const unsigned = (path: string): string => `${path}: code object is not signed at all\n`;

describe('[server-app-086] the signing identity of the app and its bundled executables', () => {
  it('reads an ad hoc signature, a named one and an unsigned file', () => {
    expect(parseCodesign('a', adHoc('a'))).toMatchObject({
      signed: true,
      adHoc: true,
      teamIdentifier: null,
    });
    expect(parseCodesign('b', named('b', 'ABCDE12345'))).toMatchObject({
      signed: true,
      adHoc: false,
      teamIdentifier: 'ABCDE12345',
      authorities: expect.arrayContaining(['Developer ID Application: Example']),
    });
    expect(parseCodesign('c', unsigned('c'))).toMatchObject({ signed: false });
  });

  it('accepts a bundle whose objects are all ad hoc', () => {
    const signatures = ['app', 'api', 'cli'].map((name) => parseCodesign(name, adHoc(name)));
    expect(signingProblems(signatures)).toEqual([]);
  });

  it('accepts a bundle whose objects are all signed by one named identity', () => {
    const signatures = ['app', 'api', 'cli'].map((name) =>
      parseCodesign(name, named(name, 'ABCDE12345')),
    );
    expect(signingProblems(signatures)).toEqual([]);
    expect(identityOf(signatures[0]!)).toBe('Developer ID Application: Example (ABCDE12345)');
  });

  it('fails when one executable is ad hoc and the app is signed with a named identity', () => {
    const problems = signingProblems([
      parseCodesign('app', named('app', 'ABCDE12345')),
      parseCodesign('api', adHoc('api')),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/signers differ/);
    expect(problems[0]).toContain('api: ad hoc');
  });

  it('fails when two named identities differ', () => {
    const problems = signingProblems([
      parseCodesign('app', named('app', 'ABCDE12345')),
      parseCodesign('cli', named('cli', 'ZZZZZ99999', 'Developer ID Application: Other')),
    ]);
    expect(problems[0]).toMatch(/signers differ/);
  });

  it('fails on an unsigned executable and on nothing to check', () => {
    expect(
      signingProblems([parseCodesign('app', adHoc('app')), parseCodesign('cli', unsigned('cli'))]),
    ).toEqual(['cli is not signed']);
    expect(signingProblems([])).toHaveLength(1);
  });
});
