import { createHash, timingSafeEqual } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import type {
  uiAuthenticationResponse,
  uiPasskeyCreationOptions,
  uiPasskeyRequestOptions,
  uiRegistrationResponse,
} from '@rumo/contract';
import type { z } from 'zod';

import type { LoginConfig } from '../modules/sign-in/index.js';

export const SIGNUP_NAME_RULE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
export const DEFAULT_PASSKEY_NAME = 'Passkey';

type UiRegistrationResponse = z.infer<typeof uiRegistrationResponse>;
type UiAuthenticationResponse = z.infer<typeof uiAuthenticationResponse>;
type CreationOptions = z.infer<typeof uiPasskeyCreationOptions>;
type RequestOptions = z.infer<typeof uiPasskeyRequestOptions>;

const RP_NAME = 'Rumo';
const SUPPORTED_ALGORITHMS = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];
const CONTROL_CHARACTERS = /\p{Cc}/gu;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

export const signupNameOf = (raw: string): string | null => {
  const name = raw.trim().toLowerCase();
  return SIGNUP_NAME_RULE.test(name) ? name : null;
};

export const passkeyLabelOf = (raw: string | undefined, fallback?: string): string | null => {
  const label = (raw ?? '').replace(CONTROL_CHARACTERS, ' ').trim();
  return label === '' ? (fallback ?? null) : label;
};

export const signupTokenMatches = (expected: string, presented: string): boolean =>
  timingSafeEqual(sha256(expected), sha256(presented));

const userHandle = (owner: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(sha256(`rumo-user:${owner}`));

export const registrationOptionsFor = (
  login: LoginConfig,
  owner: string,
  existing: readonly { credentialId: string; transports: string[] }[],
): Promise<CreationOptions> =>
  generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: login.rpId,
    userName: owner,
    userID: userHandle(owner),
    attestationType: 'none',
    excludeCredentials: existing.map(({ credentialId, transports }) => ({
      id: credentialId,
      transports,
    })),
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  }) as Promise<CreationOptions>;

export const loginOptionsFor = (login: LoginConfig): Promise<RequestOptions> =>
  generateAuthenticationOptions({
    rpID: login.rpId,
    userVerification: 'required',
  }) as Promise<RequestOptions>;

export interface VerifiedPasskey {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export const verifyRegistration = async (
  login: LoginConfig,
  response: UiRegistrationResponse,
  challenge: string,
): Promise<VerifiedPasskey> => {
  const result = await verifyRegistrationResponse({
    response: {
      ...response,
      clientExtensionResults: response.clientExtensionResults ?? {},
    } as RegistrationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: login.publicUrl,
    expectedRPID: login.rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
  });
  if (!result.verified) throw new Error('registration not verified');
  const { credential } = result.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: response.response.transports ?? credential.transports ?? [],
  };
};

export const verifyAuthentication = async (
  login: LoginConfig,
  response: UiAuthenticationResponse,
  challenge: string,
  stored: VerifiedPasskey,
): Promise<number> => {
  const result = await verifyAuthenticationResponse({
    response: {
      ...response,
      clientExtensionResults: response.clientExtensionResults ?? {},
    } as AuthenticationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: login.publicUrl,
    expectedRPID: login.rpId,
    requireUserVerification: true,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
      counter: stored.counter,
      transports: stored.transports as never,
    },
  });
  if (!result.verified) throw new Error('authentication not verified');
  return result.authenticationInfo.newCounter;
};
