import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';

import { UsageError } from '../errors.js';

const NOTE_FILE_DIR = '/tmp/';
const NOTE_FILE_MAX_BYTES = 1024 * 1024;

export function readNoteFile(path: string, platform: NodeJS.Platform = process.platform): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new UsageError(`cannot read the file ${path}`);
  }
  try {
    if (platform === 'linux') {
      if (!readlinkSync(`/proc/self/fd/${fd}`).startsWith(NOTE_FILE_DIR)) {
        throw new UsageError(`the file must be inside ${NOTE_FILE_DIR}`);
      }
    } else {
      let real: string;
      let tmp: string;
      try {
        real = realpathSync(path);
        tmp = `${realpathSync(NOTE_FILE_DIR)}/`;
      } catch {
        throw new UsageError(`cannot read the file ${path}`);
      }
      if (!real.startsWith(tmp)) throw new UsageError(`the file must be inside ${NOTE_FILE_DIR}`);
      const opened = fstatSync(fd, { bigint: true });
      const named = statSync(real, { bigint: true });
      if (opened.dev !== named.dev || opened.ino !== named.ino) {
        throw new UsageError(`the file must be inside ${NOTE_FILE_DIR}`);
      }
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NOTE_FILE_MAX_BYTES) {
      throw new UsageError('the file must be a regular file of at most 1 MiB');
    }
    if (stat.nlink !== 1) throw new UsageError('the file must not be a hard link to another file');
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}
