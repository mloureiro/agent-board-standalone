interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function internals(): TauriInternals {
  const found = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!found) {
    throw new Error('the native bridge is not available');
  }
  return found;
}

export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return (await internals().invoke(command, args)) as T;
  } catch (failure) {
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
}
