import { z } from 'zod';

import { SESSION_STATES, SIGN_IN_METHODS } from '../enums.js';
import { SAML_FORM_BODY_LIMIT } from '../limits.js';
import { pairingCode, publicKeyString } from './ids.js';
import { passkeyFlow } from './passkey.js';
import { minClientLevels, serverBuild } from './machine.js';

export const pkceChallenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const pkceVerifier = z.string().regex(/^[A-Za-z0-9._~-]{32,128}$/);
export const clientToken = z.string().regex(/^abc_[A-Za-z0-9_-]{43}$/);

export const SIGN_IN_TOKEN_KINDS = ['cookie', 'client'] as const;

export const signedIn = z.object({ ok: z.literal(true) }).strict();

const label = z.string().min(1).max(256);

export const authConfig = z.discriminatedUnion('login', [
  z.object({ login: z.literal(false) }).strict(),
  z
    .object({
      login: z.literal(true),
      passkeys: z.boolean(),
      signup: z.boolean(),
      oidc: z.object({ label }).strict().nullable(),
      saml: z.object({ label }).strict().nullable(),
    })
    .strict(),
]);

export const redirectStart = z.object({ challenge: pkceChallenge }).strict();
export const redirectStarted = z.object({ url: z.url().max(4096) }).strict();

export const oidcFinish = z
  .object({
    code: z.string().min(1).max(4096),
    state: passkeyFlow,
    verifier: pkceVerifier,
    iss: z.string().max(2048).optional(),
    publicKey: publicKeyString.optional(),
  })
  .strict();

export const samlFinish = z
  .object({ flow: passkeyFlow, verifier: pkceVerifier, publicKey: publicKeyString.optional() })
  .strict();

export const samlAcsForm = z
  .object({
    SAMLResponse: z.string().min(1).max(SAML_FORM_BODY_LIMIT),
    RelayState: z.string().optional(),
  })
  .strict();

export const handoffStarted = z.object({ flow: passkeyFlow, code: pairingCode }).strict();

export const handoffFlow = z.object({ flow: passkeyFlow }).strict();

export const handoffDescribed = z.object({ code: pairingCode }).strict();

export const handoffFinish = z
  .object({
    flow: passkeyFlow,
    verifier: pkceVerifier,
    tokenKind: z.enum(SIGN_IN_TOKEN_KINDS).optional(),
    publicKey: publicKeyString.optional(),
  })
  .strict();

export const handoffFinished = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('signed-in'), token: clientToken.optional() }).strict(),
]);

export const passkeySignupRequest = z
  .object({ username: z.string().min(1).max(200), signupToken: z.string().min(1).max(1024) })
  .strict();

export const signupName = z.string().max(200);

export const pairRequest = z
  .object({ code: pairingCode, publicKey: publicKeyString, label: z.string().min(1).max(64) })
  .strict();

export const versionDocument = z
  .object({
    contract: z.number().int().min(1),
    minClient: minClientLevels,
    features: z.array(z.string()),
    server: serverBuild,
    modules: z
      .object({
        signIn: z.array(z.enum(SIGN_IN_METHODS)),
        requestSignature: z.boolean(),
        scheduling: z.boolean(),
        feeds: z.boolean(),
      })
      .strict(),
    session: z.enum(SESSION_STATES),
  })
  .strict();

export const healthAnswer = z.object({ status: z.literal('ok') }).strict();

export type AuthConfig = z.infer<typeof authConfig>;
export type VersionDocument = z.infer<typeof versionDocument>;
export type HandoffFinished = z.infer<typeof handoffFinished>;
