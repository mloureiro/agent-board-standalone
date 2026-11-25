export type SourceRow = Record<string, unknown>;

export interface SourceReader {
  readonly kind: 'postgres' | 'pglite';
  query(sql: string, params?: readonly unknown[]): Promise<SourceRow[]>;
  close(): Promise<void>;
}

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}
