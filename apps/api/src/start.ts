import { createCredentialStore } from './auth/index.js';
import { clockFromEnv } from './clock.js';
import { DEFAULT_SESSION_DAYS } from './modules/sign-in/index.js';
import type { ServerServices } from './context.js';
import { ANY_HOST, effectiveHost } from './modules/listen/index.js';
import { DatabaseRefusal, openDatabase, type OpenDatabase } from './modules/database/index.js';
import { ConfigError, loadConfig, type Env } from './modules/index.js';
import { createServer } from './server.js';
import { createOpenStreams } from './streams.js';

export interface Started {
  url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  openDatabase?: OpenDatabase;
  write?: (line: string) => void;
}

const printableHost = (host: string): string => {
  if (host === ANY_HOST) return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
};

export const startServer = async (env: Env, options: StartOptions = {}): Promise<Started> => {
  const config = loadConfig(env);
  const open = options.openDatabase ?? openDatabase;
  const clock = clockFromEnv(env);
  const database = await open(config.database);
  const services: ServerServices = {
    database,
    credentials: createCredentialStore({
      database,
      clock,
      sessionDays:
        config.signIn.mode === 'login' ? config.signIn.sessionDays : DEFAULT_SESSION_DAYS,
    }),
    streams: createOpenStreams(),
  };
  const app = await createServer(config, services, { clock });
  const host = effectiveHost(config.listen, config.signIn.mode === 'login');
  try {
    await app.listen({ host, port: config.listen.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.listen.port;
  const url = `http://${printableHost(host)}:${port}`;
  (options.write ?? ((line) => process.stdout.write(line)))(
    `${JSON.stringify({ listening: url })}\n`,
  );
  let closing: Promise<void> | null = null;
  return {
    url,
    close: () => (closing ??= app.close()),
  };
};

export const serve = async (env: Env): Promise<number> => {
  let stopRequested = false;
  let stopping: (() => void) | null = null;
  const requestStop = (): void => {
    stopRequested = true;
    stopping?.();
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);

  let started: Started;
  try {
    started = await startServer(env);
  } catch (error) {
    process.stderr.write(
      error instanceof ConfigError || error instanceof DatabaseRefusal
        ? `agent-board-api: ${error.message}\n`
        : `agent-board-api: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  }
  return new Promise<number>((resolve) => {
    const stop = (): void => {
      started.close().then(
        () => resolve(0),
        (error: unknown) => {
          process.stderr.write(`agent-board-api: shutdown failed: ${String(error)}\n`);
          resolve(1);
        },
      );
    };
    stopping = stop;
    if (stopRequested) stop();
  });
};
