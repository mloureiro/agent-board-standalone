import { createHash } from 'node:crypto';

function counterBytes(counter: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
}

export function seededRandom(seed: string): <T extends ArrayBufferView>(array: T) => T {
  let counter = 0;
  let block: Buffer = Buffer.alloc(0);
  let offset = 0;
  return (array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let index = 0; index < bytes.length; index++) {
      if (offset >= block.length) {
        block = createHash('sha256').update(seed).update(counterBytes(counter++)).digest();
        offset = 0;
      }
      bytes[index] = block[offset++] ?? 0;
    }
    return array;
  };
}

export function withSeededRandom<T>(seed: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'getRandomValues');
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: seededRandom(seed),
    configurable: true,
    writable: true,
  });
  return run().finally(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis.crypto, 'getRandomValues');
    else Object.defineProperty(globalThis.crypto, 'getRandomValues', original);
  });
}
