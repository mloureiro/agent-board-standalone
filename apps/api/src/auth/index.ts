export { authenticateClient, authenticateMachine, sessionState } from './authenticate.js';
export { readCredential, type PresentedCredential } from './credentials.js';
export {
  emptyCredentialStore,
  type ClientPrincipal,
  type CredentialStore,
  type MachinePrincipal,
  type Principal,
  type StoredMachine,
  type StoredSession,
} from './principal.js';
