import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { killStubTree, stubTreePids } from '../src/harness/run.js';
import { createTmp } from '../src/harness/tmp.js';

function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = new Promise<string | null>((resolve) => child.once('exit', (_c, s) => resolve(s)));
  return { child, exited };
}

describe('killStubTree', () => {
  it('kills every pid and ppid in the log and ignores the rest', async () => {
    const first = sleeper();
    const second = sleeper();
    const tmp = createTmp('kill-tree');
    try {
      const log = tmp.path('stub.log');
      writeFileSync(
        log,
        [
          JSON.stringify({ kind: 'start', pid: first.child.pid, ppid: second.child.pid }),
          'not json',
          JSON.stringify({ kind: 'start', pid: 1, ppid: process.pid }),
          JSON.stringify({ kind: 'other', pid: 'x' }),
        ].join('\n'),
      );
      killStubTree(log);
      expect(await first.exited).toBe('SIGKILL');
      expect(await second.exited).toBe('SIGKILL');
    } finally {
      first.child.kill('SIGKILL');
      second.child.kill('SIGKILL');
      tmp.remove();
    }
  });

  it('never targets pid 0 or 1, the test process or its parent', () => {
    const log = [
      JSON.stringify({ pid: 0, ppid: 1 }),
      JSON.stringify({ pid: -5, ppid: 1.5 }),
      JSON.stringify({ pid: process.pid, ppid: process.ppid }),
      JSON.stringify({ pid: 424242, ppid: process.pid }),
    ].join('\n');
    expect(stubTreePids(log)).toEqual([424242]);
  });

  it('does nothing when the log does not exist', () => {
    const tmp = createTmp('kill-tree-missing');
    try {
      expect(() => killStubTree(tmp.path('missing.log'))).not.toThrow();
    } finally {
      tmp.remove();
    }
  });
});
