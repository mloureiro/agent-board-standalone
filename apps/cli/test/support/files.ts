import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach } from 'vitest';

const made: string[] = [];

afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

export function tmpFile(content: string, name = 'input.txt'): string {
  const directory = mkdtempSync('/tmp/board-cli-test-');
  made.push(directory);
  const file = path.join(directory, name);
  writeFileSync(file, content);
  return file;
}

export function tmpDir(): string {
  const directory = mkdtempSync('/tmp/board-cli-dir-');
  made.push(directory);
  return directory;
}
