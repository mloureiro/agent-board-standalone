import { z } from 'zod';

import { isoTime } from './ids.js';

export const passkeyId = z.string().min(1).max(1024);
export const passkeyName = z.string().min(1).max(200);
export const passkeyFlow = z.string().min(1).max(128);

const base64url = z.string().min(1).max(16_384);
const extensions = z.record(z.string(), z.unknown());
const attachment = z.enum(['platform', 'cross-platform']);

export const uiPasskey = z
  .object({
    id: passkeyId,
    name: z.string().max(200),
    createdAt: isoTime,
    lastUsedAt: isoTime.nullable(),
  })
  .strict();

export const uiCredentialDescriptor = z
  .object({
    type: z.string().max(64),
    id: base64url,
    transports: z.array(z.string().max(32)).max(16).optional(),
  })
  .strict();

export const uiPasskeyCreationOptions = z
  .object({
    user: z
      .object({
        id: base64url,
        name: z.string().max(256),
        displayName: z.string().max(256),
      })
      .strict(),
    challenge: base64url,
    rp: z.object({ name: z.string().max(256), id: z.string().max(256).optional() }).strict(),
    pubKeyCredParams: z
      .array(z.object({ type: z.string().max(64), alg: z.number().int() }).strict())
      .max(32),
    timeout: z.number().int().min(0).optional(),
    hints: z.array(z.string().max(64)).max(8).optional(),
    extensions: extensions.optional(),
    excludeCredentials: z.array(uiCredentialDescriptor).max(256).optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z.string().max(64).optional(),
        userVerification: z.string().max(64).optional(),
        requireResidentKey: z.boolean().optional(),
        residentKey: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    attestation: z.string().max(64).optional(),
    attestationFormats: z.array(z.string().max(64)).max(16).optional(),
  })
  .strict();

export const uiRegistrationResponse = z
  .object({
    id: base64url,
    rawId: base64url,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: base64url,
        attestationObject: base64url,
        authenticatorData: base64url.optional(),
        transports: z.array(z.string().max(32)).max(16).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: base64url.optional(),
      })
      .strict(),
    authenticatorAttachment: attachment.optional(),
    clientExtensionResults: extensions.optional(),
  })
  .strict();

export const uiPasskeyRequestOptions = z
  .object({
    challenge: base64url,
    timeout: z.number().int().min(0).optional(),
    rpId: z.string().max(256).optional(),
    allowCredentials: z.array(uiCredentialDescriptor).max(256).optional(),
    userVerification: z.string().max(64).optional(),
    hints: z.array(z.string().max(64)).max(8).optional(),
    extensions: extensions.optional(),
  })
  .strict();

export const uiAuthenticationResponse = z
  .object({
    id: base64url,
    rawId: base64url,
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: base64url,
        authenticatorData: base64url,
        signature: base64url,
        userHandle: base64url.optional(),
      })
      .strict(),
    authenticatorAttachment: attachment.optional(),
    clientExtensionResults: extensions.optional(),
  })
  .strict();

export type UiPasskey = z.infer<typeof uiPasskey>;
