import { PassThrough } from 'node:stream';

import type { FastifyReply } from 'fastify';

import type { ServerContext } from '../../context.js';
import type { EventMessage } from './bus.js';

export interface StreamHooks {
  onMessage(message: EventMessage, send: (event: string) => void): void;
  recheck(): Promise<boolean>;
  dispose?(): void;
}

export interface Timings {
  pingMs: number;
  debounceMs: number;
}

const frame = (event: string): string => `event: ${event}\ndata: {}\n\n`;

export const openStream = async (
  reply: FastifyReply,
  context: ServerContext,
  owner: string,
  timings: Timings,
  hooks: (send: (event: string) => void, end: () => void) => StreamHooks,
): Promise<never> => {
  const body = new PassThrough();
  let finished = false;
  let unsubscribe: (() => Promise<void>) | null = null;
  let ping: NodeJS.Timeout | null = null;
  let forget = (): void => undefined;
  let active: StreamHooks | null = null;

  const end = (): void => {
    if (finished) return;
    finished = true;
    if (ping !== null) clearInterval(ping);
    forget();
    active?.dispose?.();
    body.end();
    void unsubscribe?.().catch(() => undefined);
  };
  const send = (event: string): void => {
    if (!finished) body.write(frame(event));
  };

  active = hooks(send, end);
  body.on('close', end);
  forget = context.services.streams.add(end);
  try {
    unsubscribe = await context.services.events.subscribe(owner, (message) => {
      if (!finished) active?.onMessage(message, send);
    });
  } catch (error) {
    end();
    throw error;
  }
  if (finished) void unsubscribe().catch(() => undefined);

  ping = setInterval(() => {
    if (finished) return;
    active
      ?.recheck()
      .then((valid) => {
        if (!valid) end();
        else if (!finished) body.write(': ping\n\n');
      })
      .catch(end);
  }, timings.pingMs);
  body.write(': open\n\n');

  reply
    .code(200)
    .header('content-type', 'text/event-stream; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('x-accel-buffering', 'no')
    .send(body);
  return reply as never;
};
