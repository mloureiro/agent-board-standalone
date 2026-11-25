import type { Page } from '@playwright/test';

import type { EnrolledMachine } from '../fixtures/machines.js';
import { partPath } from '../harness/paths.js';
import { runProcess, type RunResult } from '../harness/run.js';

export interface PollOptions {
  readonly label: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean | Promise<boolean>,
  options: PollOptions,
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const interval = options.intervalMs ?? 500;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (await accept(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`${options.label} did not happen: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export function runIn(
  machine: Pick<EnrolledMachine, 'env'>,
  cwd: string,
  args: readonly string[],
  options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<RunResult> {
  return runProcess(partPath('cli'), args, {
    env: machine.env,
    cwd,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
