import { vi } from 'vitest';

export interface Internals {
  invoke: ReturnType<typeof vi.fn>;
  transformCallback(callback: (message: unknown) => void): number;
  unregisterCallback(id: number): void;
  deliver(channel: unknown, index: number, message: unknown): void;
}

export function installInternals(
  onInvoke: (command: string, args: Record<string, unknown>) => unknown,
): Internals {
  const callbacks = new Map<number, (message: unknown) => void>();
  let next = 1;
  const internals: Internals = {
    invoke: vi.fn(async (command: string, args: Record<string, unknown>) =>
      onInvoke(command, args),
    ),
    transformCallback(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    deliver(channel, index, message) {
      const id = Number(String(JSON.parse(JSON.stringify(channel))).split(':')[1]);
      callbacks.get(id)?.({ index, message });
    },
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: internals,
    configurable: true,
    writable: true,
  });
  return internals;
}

export function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[][]> {
  const reader = stream.getReader();
  const chunks: number[][] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push([...value]);
  }
}
