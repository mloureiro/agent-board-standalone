import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { LAYOUT, PART_VERSION_PATTERN, SCHEMA_VERSION_PATTERN } from './layout.ts';

function isExecutable(file: string): boolean {
  try {
    const info = statSync(file);
    return info.isFile() && (info.mode & 0o111) !== 0 && info.size > 0;
  } catch {
    return false;
  }
}

export function resourcesProblems(resources: string): string[] {
  const problems: string[] = [];
  for (const relative of [LAYOUT.api, LAYOUT.cli]) {
    if (!isExecutable(path.join(resources, relative)))
      problems.push(`${relative} is missing or not executable in ${resources}`);
  }
  try {
    if (!statSync(path.join(resources, LAYOUT.web, 'index.html')).isFile()) throw new Error();
  } catch {
    problems.push(`${LAYOUT.web}/index.html is missing in ${resources}`);
  }
  const versions: [string, RegExp][] = [
    [LAYOUT.schemaVersion, SCHEMA_VERSION_PATTERN],
    [LAYOUT.apiVersion, PART_VERSION_PATTERN],
    [LAYOUT.cliVersion, PART_VERSION_PATTERN],
  ];
  for (const [relative, pattern] of versions) {
    try {
      const version = readFileSync(path.join(resources, relative), 'utf8').trim();
      if (!pattern.test(version))
        problems.push(`${relative} holds "${version}", which is not a valid version`);
    } catch {
      problems.push(`${relative} is missing in ${resources}`);
    }
  }
  return problems;
}
