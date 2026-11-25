import type { DatabaseConfig, DatabaseKind } from './config.js';

export interface Database {
  readonly kind: DatabaseKind;
  close(): Promise<void>;
}

export type OpenDatabase = (config: DatabaseConfig) => Promise<Database>;

export const openStubDatabase: OpenDatabase = async (config) => ({
  kind: config.kind,
  close: async () => undefined,
});
