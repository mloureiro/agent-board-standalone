import { afterEach } from 'vitest';

import { startApiStub, type ApiStub } from './api-stub.js';
import { cliFor, type Cli, type ProfileOptions } from './profile.js';
import type { FakeBoardOptions } from './board.js';

export interface Rig {
  readonly stub: ApiStub;
  readonly cli: Cli;
}

export function useRig(): (
  options?: ProfileOptions & { board?: FakeBoardOptions },
) => Promise<Rig> {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return async (options = {}) => {
    const stub = await startApiStub(options.board);
    cleanups.push(() => stub.stop());
    const cli = cliFor(stub, options);
    cleanups.push(() => cli.test.dispose());
    return { stub, cli };
  };
}
