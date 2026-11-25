import { createHash } from 'node:crypto';

import pg from 'pg';

import type { EventBus, EventMessage } from '../events/bus.js';

type Listener = (message: EventMessage) => void;

interface Channel {
  listeners: Set<Listener>;
  ready: Promise<void>;
}

const RECONNECT_MS = 1000;
const NOTIFY_POOL_SIZE = 2;

export const channelOf = (owner: string): string =>
  `board_ev_${createHash('sha256').update(owner).digest('hex').slice(0, 32)}`;

const parse = (payload: string | undefined): EventMessage | null => {
  try {
    const value = JSON.parse(payload ?? '') as EventMessage;
    return typeof value === 'object' && value !== null && typeof value.kind === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
};

export const createPostgresEvents = async (url: string): Promise<EventBus> => {
  const channels = new Map<string, Channel>();
  const notifier = new pg.Pool({ connectionString: url, max: NOTIFY_POOL_SIZE });
  let listener: pg.Client | null = null;
  let closing = false;
  let closed: Promise<void> | null = null;
  let reconnect: NodeJS.Timeout | null = null;

  const deliver = (channel: string, message: EventMessage): void => {
    for (const each of [...(channels.get(channel)?.listeners ?? [])]) each(message);
  };

  const connect = async (): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString: url });
    client.on('notification', (notification) => {
      const message = parse(notification.payload);
      if (message !== null) deliver(notification.channel, message);
    });
    client.on('error', () => undefined);
    client.on('end', () => {
      if (closing || listener !== client) return;
      listener = null;
      reconnect = setTimeout(() => void recover(), RECONNECT_MS);
    });
    await client.connect();
    return client;
  };

  const recover = async (): Promise<void> => {
    reconnect = null;
    if (closing) return;
    try {
      const client = await connect();
      listener = client;
      for (const channel of channels.keys()) await client.query(`LISTEN "${channel}"`);
      for (const channel of channels.keys()) deliver(channel, { kind: 'resync' });
    } catch {
      if (!closing) reconnect = setTimeout(() => void recover(), RECONNECT_MS);
    }
  };

  listener = await connect();

  return {
    publish: async (owner, message) => {
      await notifier.query('select pg_notify($1, $2)', [channelOf(owner), JSON.stringify(message)]);
    },
    subscribe: async (owner, subscriber) => {
      const name = channelOf(owner);
      let channel = channels.get(name);
      if (channel === undefined) {
        const created: Channel = {
          listeners: new Set(),
          ready: Promise.resolve(),
        };
        created.ready = (async () => {
          if (listener !== null) await listener.query(`LISTEN "${name}"`);
        })();
        channels.set(name, created);
        channel = created;
      }
      channel.listeners.add(subscriber);
      try {
        await channel.ready;
      } catch (error) {
        channel.listeners.delete(subscriber);
        if (channel.listeners.size === 0) channels.delete(name);
        throw error;
      }
      const joined = channel;
      return async () => {
        joined.listeners.delete(subscriber);
        if (joined.listeners.size > 0 || channels.get(name) !== joined) return;
        channels.delete(name);
        if (listener !== null && !closing) await listener.query(`UNLISTEN "${name}"`);
      };
    },
    close: () =>
      (closed ??= (async () => {
        closing = true;
        if (reconnect !== null) clearTimeout(reconnect);
        channels.clear();
        const client = listener;
        listener = null;
        await Promise.all([client?.end(), notifier.end()]);
      })()),
  };
};
