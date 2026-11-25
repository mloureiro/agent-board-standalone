import { readFileSync, statSync } from 'node:fs';

import { UsageError } from '../errors.js';

export function readTextFile(file: string, maxBytes: number): string {
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new UsageError(`${file} is not a file`);
    size = stats.size;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`cannot read ${file}`);
  }
  if (size > maxBytes) throw new UsageError(`${file} is larger than ${maxBytes / 1024} KB`);
  return readFileSync(file, 'utf8');
}
