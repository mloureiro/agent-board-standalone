import { StatementRefused } from './errors.js';

const FORBIDDEN: readonly RegExp[] = [
  /\b(?:set|reset)\s+(?:local\s+|session\s+)?(?:role|session\s+authorization)\b/,
  /\b(?:set|reset)\s+(?:local\s+|session\s+)?row_security\b/,
  /\breset\s+all\b/,
  /\bdiscard\s+(?:all|sessions?)\b/,
  /\bset_config\b/,
  /\bsession_authorization\b/,
  /\bexecute\b/,
  /\bdo\s+(?:\$|'|language\b)/,
  /u&/,
  /\/\*/,
  /--/,
];

export const assertAllowedStatement = (text: string): void => {
  const normalised = text.toLowerCase().replaceAll('"', '').replace(/\s+/g, ' ');
  if (FORBIDDEN.some((pattern) => pattern.test(normalised))) throw new StatementRefused();
};

export interface QueryClient {
  query(text: string, params?: unknown[], options?: unknown): Promise<unknown>;
  transaction<T>(callback: (client: QueryClient) => Promise<T>): Promise<T>;
}

export interface Unlock {
  unlocked: boolean;
}

export const guardClient = <C extends QueryClient>(client: C, unlock: Unlock): C => {
  const guarded = {
    query: (text: string, params?: unknown[], options?: unknown) => {
      if (!unlock.unlocked) assertAllowedStatement(text);
      return client.query(text, params, options);
    },
    transaction: <T>(callback: (inner: QueryClient) => Promise<T>) =>
      client.transaction((inner) => callback(guardClient(inner as C, unlock))),
  };
  return guarded as unknown as C;
};
