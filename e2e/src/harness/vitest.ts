import type { Feature } from '@agent-board/contract';
import { afterAll, beforeAll, beforeEach, type TestContext } from 'vitest';

import { createBoard, resolveDatabaseKind, type Board, type BoardDeclaration } from './board.js';
import { missingParts } from './paths.js';
import { featureSkipReason, partSkipReason, recordSkip } from './skip.js';

export interface VitestBoardHandle {
  readonly board: Board;
  needs(context: TestContext, features: readonly Feature[]): void;
}

function titlePathOf(context: TestContext): string[] {
  const titles = [context.task.name];
  for (let suite = context.task.suite; suite; suite = suite.suite) {
    if (suite.type === 'suite' && suite.name) titles.unshift(suite.name);
  }
  return titles;
}

function skipWith(context: TestContext, reason: string): never {
  recordSkip({
    file: context.task.file.filepath,
    titlePath: titlePathOf(context),
    project: 'blackbox',
    reason,
  });
  return context.skip(reason);
}

export function useBoard(declaration: BoardDeclaration): VitestBoardHandle {
  let board: Board | null = null;
  let reason: string | null = null;

  beforeAll(async () => {
    const missing = missingParts(declaration.parts);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    board = await createBoard({
      ...declaration,
      database: resolveDatabaseKind(declaration, true),
    });
    if (board.missingFeatures.length > 0) reason = featureSkipReason(board.missingFeatures);
  });

  afterAll(async () => {
    await board?.stop();
    board = null;
  });

  beforeEach((context) => {
    if (reason !== null) skipWith(context, reason);
  });

  return {
    get board() {
      if (board === null) throw new Error('the board is not started');
      return board;
    },
    needs(context, features) {
      const missing = (board as Board | null)?.missing(features) ?? [];
      if (missing.length > 0) skipWith(context, featureSkipReason(missing));
    },
  };
}
