import type { Feature } from '@agent-board/contract';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import {
  startLoginBoard,
  type LoginBoard,
  type LoginBoardOptions,
} from '../fixtures/login-board.js';
import { missingParts } from '../harness/paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from '../harness/skip.js';

export interface LoginBoardHandle {
  readonly board: LoginBoard;
}

export function useLoginBoard(
  options: Omit<LoginBoardOptions, 'features'> & { readonly features: readonly Feature[] },
): LoginBoardHandle {
  let board: LoginBoard | null = null;
  let reason: string | null = null;

  beforeAll(async () => {
    const missing = missingParts(['api']);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    board = await startLoginBoard(options);
    if (board.missingFeatures.length > 0) reason = featureSkipReason(board.missingFeatures);
  }, 120_000);

  afterAll(async () => {
    await board?.stop();
    board = null;
  });

  beforeEach((context) => {
    if (reason === null) return;
    const titlePath = [context.task.name];
    for (let suite = context.task.suite; suite; suite = suite.suite) {
      if (suite.type === 'suite' && suite.name) titlePath.unshift(suite.name);
    }
    recordSkip({
      file: context.task.file.filepath,
      titlePath,
      project: 'blackbox',
      reason,
    });
    context.skip(reason);
  });

  return {
    get board() {
      if (board === null) throw new Error('the login board is not started');
      return board;
    },
  };
}
