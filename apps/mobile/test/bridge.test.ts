import { describe, expect, it } from 'vitest';
import { createMobileBridge, type TauriChannel, type TauriCore } from '../src/index.js';

type Call = { command: string; args: Record<string, unknown> | undefined };

const fakeCore = (
  answer: (call: Call, channel: TauriChannel<unknown> | null) => unknown,
): { core: TauriCore; calls: Call[] } => {
  const calls: Call[] = [];
  class Channel<T> implements TauriChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  const core: TauriCore = {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      const call = { command, args };
      calls.push(call);
      const channel = (args?.onChunk as TauriChannel<unknown> | undefined) ?? null;
      return answer(call, channel) as T;
    },
    Channel: Channel as unknown as TauriCore['Channel'],
  };
  return { core, calls };
};

const readAll = async (body: ReadableStream<Uint8Array> | null): Promise<string> => {
  const reader = body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
};

const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('mobile bridge shim', () => {
  it('[mobile-008] is a mobile bridge and sends serverFetch through the server_fetch command', async () => {
    const { core, calls } = fakeCore((_call, channel) => {
      channel!.onmessage(bytes('hel'));
      channel!.onmessage(bytes('lo'));
      channel!.onmessage({ type: 'end' });
      return { status: 201, headers: { 'content-type': 'text/event-stream' } };
    });
    const bridge = createMobileBridge(core);
    expect(bridge.kind).toBe('mobile');
    const response = await bridge.serverFetch(
      'srv-1',
      'POST',
      '/api/client/tasks/create',
      { 'content-type': 'application/json' },
      '{"a":1}',
    );
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(await readAll(response.body)).toBe('hello');
    expect(calls[0]).toMatchObject({
      command: 'server_fetch',
      args: {
        serverId: 'srv-1',
        method: 'POST',
        path: '/api/client/tasks/create',
        headers: [['content-type', 'application/json']],
        body: '{"a":1}',
      },
    });
  });

  it('[mobile-008] errors the stream when the native side reports one', async () => {
    const { core } = fakeCore((_call, channel) => {
      channel!.onmessage(bytes('x'));
      channel!.onmessage({ type: 'error', message: 'connection reset' });
      return { status: 200, headers: {} };
    });
    const response = await createMobileBridge(core).serverFetch('s', 'GET', '/api/x', {}, null);
    await expect(readAll(response.body)).rejects.toThrow('connection reset');
  });

  it('[mobile-008] routes credential commands to their own native commands and never to server_fetch', async () => {
    const { core, calls } = fakeCore(() => undefined);
    const bridge = createMobileBridge(core);
    await bridge.handoffFinish('s', 'flow', 'v'.repeat(43));
    await bridge.pair('s', 'ABCD-1234', 'Pixel');
    await bridge.signOut('s');
    expect(calls.map((c) => c.command)).toEqual(['handoff_finish', 'pair', 'sign_out']);
    expect(calls[1]?.args).toEqual({ serverId: 's', code: 'ABCD-1234', label: 'Pixel' });
  });

  it('[mobile-002] keeps the server list native: list, add, rename and remove are commands', async () => {
    const { core, calls } = fakeCore(({ command }) =>
      command === 'add_server' ? { id: 'u', name: 'Home', url: 'https://board.example.com/' } : [],
    );
    const bridge = createMobileBridge(core);
    await bridge.listServers();
    expect(await bridge.addServer({ name: 'Home', address: 'https://board.example.com' })).toEqual({
      id: 'u',
      name: 'Home',
      url: 'https://board.example.com/',
    });
    await bridge.renameServer('u', 'Office');
    await bridge.removeServer('u');
    expect(calls.map((c) => c.command)).toEqual([
      'list_servers',
      'add_server',
      'rename_server',
      'remove_server',
    ]);
  });

  it('[mobile-004] hands external links to the native open_link command', async () => {
    const { core, calls } = fakeCore(() => undefined);
    await createMobileBridge(core).openLink('https://example.com');
    expect(calls[0]).toEqual({ command: 'open_link', args: { url: 'https://example.com' } });
  });
});

describe('mobile bridge notifications', () => {
  it('[mobile-005] tells the native side when the notification setting changes and passes page notifications through', async () => {
    const { core, calls } = fakeCore(() => undefined);
    const bridge = createMobileBridge(core);
    await bridge.setNotifications?.('s', true);
    await bridge.notify({ serverId: 's', taskId: 't1', title: 'Fix the build' });
    expect(calls).toEqual([
      { command: 'set_notifications', args: { serverId: 's', enabled: true } },
      { command: 'notify', args: { serverId: 's', taskId: 't1', title: 'Fix the build' } },
    ]);
  });
});
