import { spawn } from 'node:child_process';

import { STREAM_MAX_BYTES } from './stream-limit.js';

export interface StreamProcess {
  drain(): string;
  readonly ended: { readonly code: number | null } | null;
  kill(): void;
}

const KEPT_BYTES = STREAM_MAX_BYTES * 2;

export function startStream(command: string, cwd: string): StreamProcess {
  let pending = '';
  let ended: { code: number | null } | null = null;
  const child = spawn('sh', ['-c', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const take = (chunk: Buffer): void => {
    pending += chunk.toString('utf8');
    if (pending.length > KEPT_BYTES) pending = pending.slice(-KEPT_BYTES);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('error', () => {
    ended = { code: null };
  });
  child.on('close', (code) => {
    ended = { code };
  });
  return {
    drain() {
      const text = pending;
      pending = '';
      return text;
    },
    get ended() {
      return ended;
    },
    kill() {
      if (ended !== null || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
  };
}
