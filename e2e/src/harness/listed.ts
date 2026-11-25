import path from 'node:path';

import { beforeEach, type TestContext } from 'vitest';

import { isListed, LISTED_SKIP_REASON, loadExpectedRed, skipsListed } from '../ratchet/expected.ts';
import { VITEST_PROJECT } from '../ratchet/results.ts';
import { E2E_ROOT } from './paths.js';
import { recordSkip } from './skip.js';

type Task = TestContext['task'];

export function titlePathOf(task: Pick<Task, 'name' | 'suite'>): string[] {
  const titles: string[] = [task.name];
  for (
    let suite = task.suite;
    suite !== undefined && suite.suite !== undefined;
    suite = suite.suite
  ) {
    titles.unshift(suite.name);
  }
  return titles;
}

if (skipsListed(process.env) && process.env.E2E_MATRIX_EXPECT !== 'refusal') {
  const expected = loadExpectedRed(path.join(E2E_ROOT, 'expected-red.json'));
  beforeEach((context) => {
    const filepath = context.task.file.filepath;
    const key = {
      file: path.relative(E2E_ROOT, filepath).split(path.sep).join('/'),
      titlePath: titlePathOf(context.task),
      project: VITEST_PROJECT,
    };
    if (!isListed(expected, key)) return;
    recordSkip({
      file: filepath,
      titlePath: key.titlePath,
      project: null,
      reason: LISTED_SKIP_REASON,
    });
    context.skip(LISTED_SKIP_REASON);
  });
}
