import { execFileSync, spawnSync } from 'node:child_process';

export interface Signature {
  readonly path: string;
  readonly signed: boolean;
  readonly adHoc: boolean;
  readonly authorities: readonly string[];
  readonly teamIdentifier: string | null;
}

export function parseCodesign(file: string, output: string): Signature {
  const lines = output.split('\n').map((line) => line.trim());
  const value = (key: string): string[] =>
    lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  const unsigned = /not signed at all/i.test(output);
  const team = value('TeamIdentifier')[0];
  return {
    path: file,
    signed: !unsigned && value('Signature').length + value('Identifier').length > 0,
    adHoc: value('Signature').includes('adhoc'),
    authorities: value('Authority'),
    teamIdentifier: team === undefined || team === 'not set' ? null : team,
  };
}

export function identityOf(signature: Signature): string {
  if (!signature.signed) return 'unsigned';
  if (signature.adHoc) return 'ad hoc';
  const leaf = signature.authorities[0] ?? 'unnamed identity';
  return signature.teamIdentifier === null ? leaf : `${leaf} (${signature.teamIdentifier})`;
}

export function signingProblems(signatures: readonly Signature[]): string[] {
  if (signatures.length === 0) return ['nothing to check: no signatures were read'];
  const problems = signatures
    .filter((signature) => !signature.signed)
    .map((signature) => `${signature.path} is not signed`);
  const identities = new Set(
    signatures.filter((signature) => signature.signed).map((signature) => identityOf(signature)),
  );
  if (identities.size > 1) {
    const listing = signatures
      .filter((signature) => signature.signed)
      .map((signature) => `  ${signature.path}: ${identityOf(signature)}`)
      .join('\n');
    problems.push(`the signers differ:\n${listing}`);
  }
  return problems;
}

export function readSignature(file: string): Signature {
  const result = spawnSync('codesign', ['-d', '--verbose=4', file], { encoding: 'utf8' });
  return parseCodesign(file, `${result.stdout}\n${result.stderr}`);
}

export function verifyStrict(file: string): string | null {
  const result = spawnSync('codesign', ['--verify', '--strict', '--deep', file], {
    encoding: 'utf8',
  });
  return result.status === 0 ? null : `${file} fails codesign --verify: ${result.stderr.trim()}`;
}

export function signAdHoc(file: string): void {
  execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'inherit' });
}
