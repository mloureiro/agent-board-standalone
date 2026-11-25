import { deviceStore } from '../storage/index.js';

export interface PendingSignIn {
  readonly kind: 'oidc' | 'saml';
  readonly serverId: string;
  readonly verifier: string;
  readonly returnTo: string;
}

const KEY = 'pending-sign-in';

const isPending = (value: unknown): value is PendingSignIn => {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.kind === 'oidc' || entry.kind === 'saml') &&
    typeof entry.serverId === 'string' &&
    typeof entry.verifier === 'string' &&
    typeof entry.returnTo === 'string'
  );
};

export const savePending = (pending: PendingSignIn): void =>
  deviceStore().set(KEY, JSON.stringify(pending));

export const clearPending = (): void => deviceStore().remove(KEY);

export const readPending = (kind: PendingSignIn['kind']): PendingSignIn | null => {
  const raw = deviceStore().get(KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPending(parsed) && parsed.kind === kind ? parsed : null;
  } catch {
    return null;
  }
};
