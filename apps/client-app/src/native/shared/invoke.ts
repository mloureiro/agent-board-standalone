import { invoke } from '@tauri-apps/api/core';

export async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (failure) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
}

export interface ServerEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface OpenFailure {
  readonly name: string;
  readonly text: string;
}

export interface StoreFailure {
  readonly serverId: string;
  readonly message: string;
}

export interface WindowError {
  readonly message: string;
}
