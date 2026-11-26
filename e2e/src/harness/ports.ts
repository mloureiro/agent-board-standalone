import net from 'node:net';

export const LOOPBACK = '127.0.0.1';

export function freePort(host: string = LOOPBACK): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not read the allocated port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

const BIND_RACE = /EADDRINUSE|address already in use/i;
const PORT_RACE = /EADDRINUSE|address already in use|not ready after|exited before it was ready/i;
const BIND_ATTEMPTS = 3;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function retryOnBindRace<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tried = 1; ; tried++) {
    try {
      return await attempt();
    } catch (error) {
      if (tried >= BIND_ATTEMPTS || !BIND_RACE.test(messageOf(error))) throw error;
    }
  }
}

export async function retryOnPortRace<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!PORT_RACE.test(messageOf(error))) throw error;
    return attempt();
  }
}
