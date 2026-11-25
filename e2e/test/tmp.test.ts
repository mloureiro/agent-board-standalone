import { realpathSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createTmp } from '../src/harness/tmp.js';

describe('createTmp', () => {
  it('roots the directory under the real path of /tmp', () => {
    const tmp = createTmp('real-root');
    try {
      expect(tmp.root.startsWith(`${realpathSync('/tmp')}/`)).toBe(true);
    } finally {
      tmp.remove();
    }
  });
});
