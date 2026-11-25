import type { Feature } from '@agent-board/contract';
import { test } from '@playwright/test';

import { createBoard, resolveDatabaseKind, type Board, type BoardDeclaration } from './board.js';
import { missingParts } from './paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from './skip.js';

export interface PlaywrightBoardHandle {
  readonly board: Board;
  needs(features: readonly Feature[]): void;
}

const START_TIMEOUT_MS = 120_000;
const POSTGRES_PROJECT = 'chromium-desktop';

export function useBoard(declaration: BoardDeclaration): PlaywrightBoardHandle {
  let board: Board | null = null;
  let reason: string | null = null;

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(START_TIMEOUT_MS);
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    board = await createBoard({
      ...declaration,
      database: resolveDatabaseKind(declaration, testInfo.project.name === POSTGRES_PROJECT),
    });
    if (board.missingFeatures.length > 0) reason = featureSkipReason(board.missingFeatures);
  });

  test.afterAll(async () => {
    await board?.stop();
    board = null;
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured first hook argument
  test.beforeEach(async ({}, testInfo) => {
    if (reason === null) return;
    recordSkip({
      file: testInfo.file,
      titlePath: testInfo.titlePath.slice(1),
      project: testInfo.project.name,
      reason,
    });
    test.skip(true, reason);
  });

  return {
    get board() {
      if (board === null) throw new Error('the board is not started');
      return board;
    },
    needs(features) {
      const missing = (board as Board | null)?.missing(features) ?? [];
      if (missing.length === 0) return;
      const featureReason = featureSkipReason(missing);
      const info = test.info();
      recordSkip({
        file: info.file,
        titlePath: info.titlePath.slice(1),
        project: info.project.name,
        reason: featureReason,
      });
      test.skip(true, featureReason);
    },
  };
}
