import { SERVER_LIST_KEY } from './names.js';

export interface StoredServer {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

const isStoredServer = (value: unknown): value is StoredServer => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.name === 'string' &&
    typeof candidate.url === 'string'
  );
};

export const readServerList = (): StoredServer[] | null => {
  const raw = localStorage.getItem(SERVER_LIST_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredServer) : [];
  } catch {
    return [];
  }
};

export const writeServerList = (servers: readonly StoredServer[]): void => {
  localStorage.setItem(
    SERVER_LIST_KEY,
    JSON.stringify(servers.map(({ id, name, url }) => ({ id, name, url }))),
  );
};
