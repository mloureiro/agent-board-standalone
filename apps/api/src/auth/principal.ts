export interface ClientPrincipal {
  kind: 'client';
  owner: string;
}

export interface MachinePrincipal {
  kind: 'machine';
  owner: string;
  machineId: string;
}

export type Principal = ClientPrincipal | MachinePrincipal;

export interface StoredSession {
  owner: string;
  expired: boolean;
  slidMaxAgeSeconds?: number;
}

export interface StoredMachine {
  owner: string;
  machineId: string;
}

export interface CredentialStore {
  findSession(hash: string, kind: 'session' | 'client'): Promise<StoredSession | null>;
  findMachine(hash: string): Promise<StoredMachine | null>;
}

export const emptyCredentialStore: CredentialStore = {
  findSession: async () => null,
  findMachine: async () => null,
};
