import type { CredentialStore } from './auth/index.js';
import type { Database } from './modules/database/index.js';
import type { ApiConfig } from './modules/registry.js';
import type { OpenStreams } from './streams.js';

export interface ServerServices {
  database: Database;
  credentials: CredentialStore;
  streams: OpenStreams;
}

export interface ServerContext {
  config: ApiConfig;
  services: ServerServices;
  listeningPort(): number;
}
