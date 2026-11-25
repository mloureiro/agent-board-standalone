import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { createRequestSigner, type RequestSigner } from '../client/signer.js';
import { controlClient, type ControlClient } from '../fixtures/control.js';
import { noLoginUser, type BoardUser } from '../fixtures/users.js';
import type { Board } from '../harness/board.js';

export const PAIR_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
export const PAIR_VALIDITY_SECONDS = 600;
export const OVERSIZED_BODY_BYTES = 20 * 1024 * 1024;

export function shortTempPath(label: string): string {
  return path.join(os.tmpdir(), `ab-e2e-${label}-${randomBytes(4).toString('hex')}`);
}

export function pairCodeIn(text: string): string | null {
  return PAIR_CODE.exec(text)?.[0] ?? null;
}

export function controlOf(socketPath: string): ControlClient {
  return controlClient(socketPath);
}

export interface PairedDevice {
  readonly signer: RequestSigner;
  readonly user: BoardUser;
}

export async function pairedDevice(
  board: Pick<Board, 'url'>,
  control: ControlClient,
  label = 'e2e device',
): Promise<PairedDevice> {
  const signer = await createRequestSigner();
  const user = await noLoginUser(board, { signer, pairing: control, label });
  return { signer, user };
}

export function readLines(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

export function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(root);
  return found;
}

export function signingKeyFiles(configDir: string): string[] {
  return filesUnder(configDir).filter((file) => /sign/i.test(path.basename(file)));
}

export function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

export interface StoredKey {
  readonly database: string;
  readonly store: string;
  readonly extractable: boolean;
  readonly type: string;
}

export interface BrowserKeyStorage {
  readonly databases: readonly string[];
  readonly keys: readonly StoredKey[];
}

export async function readBrowserKeyStorage(page: Page): Promise<BrowserKeyStorage> {
  return page.evaluate(async (prefix) => {
    const named = (await indexedDB.databases())
      .map((entry) => entry.name ?? '')
      .filter((name) => name.startsWith(prefix));
    const keys: { database: string; store: string; extractable: boolean; type: string }[] = [];
    const collect = (database: string, store: string, value: unknown, depth: number): void => {
      if (value instanceof CryptoKey) {
        keys.push({ database, store, extractable: value.extractable, type: value.type });
        return;
      }
      if (depth > 0 && value !== null && typeof value === 'object') {
        for (const inner of Object.values(value)) collect(database, store, inner, depth - 1);
      }
    };
    for (const name of named) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const value of values) collect(name, store, value, 2);
      }
      db.close();
    }
    return { databases: named, keys };
  }, 'agent-board:');
}
