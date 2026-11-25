import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { LOG_TAIL_BYTES, LOG_TAIL_LINES } from './limits.js';

export function readLogTail(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').slice(-LOG_TAIL_LINES).join('\n').trim();
  } finally {
    closeSync(fd);
  }
}

export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
