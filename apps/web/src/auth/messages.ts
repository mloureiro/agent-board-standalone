import { PasskeyCancelled } from './webauthn.js';

export const messageOf = (error: unknown): string => {
  if (error instanceof PasskeyCancelled) return error.message;
  if (error instanceof DOMException) return `The passkey request failed: ${error.message}`;
  return error instanceof Error ? error.message : 'Something went wrong.';
};
