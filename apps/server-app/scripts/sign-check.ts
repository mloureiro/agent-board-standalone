import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { APP_BINARY, BUNDLED_APP } from './layout.ts';
import { readSignature, signingProblems, verifyStrict } from './signing.ts';

export function executablesIn(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...executablesIn(full));
    else if (entry.isFile() && (statSync(full).mode & 0o111) !== 0) found.push(full);
  }
  return found;
}

export function bundleTargets(app: string): string[] {
  return [
    app,
    path.join(app, 'Contents', 'MacOS', APP_BINARY),
    ...executablesIn(path.join(app, 'Contents', 'Resources')),
  ];
}

if (import.meta.main) {
  const app = path.resolve(process.argv[2] ?? BUNDLED_APP);
  const targets = bundleTargets(app);
  const problems = [
    ...signingProblems(targets.map((target) => readSignature(target))),
    ...targets.flatMap((target) => verifyStrict(target) ?? []),
  ];
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `- ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${targets.length} signed objects share one identity in ${app}\n`);
  }
}
