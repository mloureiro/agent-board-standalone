import type { FastifyInstance } from 'fastify';

import type { ServerContext } from '../../context.js';
import { runCleanup } from './run.js';

export const CLEANUP_INTERVAL_MS = 60 * 60_000;
export const CLEANUP_FIRST_RUN_MS = 60_000;

export const registerCleanup = (app: FastifyInstance, context: ServerContext): void => {
  if (!context.config.cleanup) return;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();

  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      running = pass().finally(() => {
        if (timer !== null) schedule(CLEANUP_INTERVAL_MS);
      });
    }, delay);
    timer.unref();
  };

  const pass = async (): Promise<void> => {
    const { services, clock } = context;
    const result = await runCleanup({
      database: services.database,
      events: services.events,
      clock,
    }).catch((error: unknown) => ({ failures: [String(error)] }));
    for (const failure of result.failures)
      process.stderr.write(`agent-board-api: cleanup: ${failure}\n`);
  };

  app.addHook('onReady', async () => {
    schedule(CLEANUP_FIRST_RUN_MS);
  });
  app.addHook('preClose', async () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    await running;
  });
};
