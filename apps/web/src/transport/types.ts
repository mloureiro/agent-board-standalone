export type TransportKind = 'same-origin' | 'cross-origin' | 'native';

export interface TransportInit {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | null;
  readonly signal?: AbortSignal;
  readonly redirect?: 'follow' | 'manual';
}

export interface Transport {
  readonly kind: TransportKind;
  fetch(path: string, init?: TransportInit): Promise<Response>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
