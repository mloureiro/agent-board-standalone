import type {
  RouteRequest,
  RouteResponse,
  authPasskeyLoginOptionsRoute,
  authPasskeyLoginRoute,
  authPasskeySignupOptionsRoute,
  authPasskeySignupRoute,
} from '@rumo/contract';

type CreationOptions = RouteResponse<typeof authPasskeySignupOptionsRoute>['options'];
type RequestOptions = RouteResponse<typeof authPasskeyLoginOptionsRoute>['options'];
type RegistrationResponse = RouteRequest<typeof authPasskeySignupRoute>['response'];
type AuthenticationResponse = RouteRequest<typeof authPasskeyLoginRoute>['response'];

export const webAuthnAvailable = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential !== 'undefined' &&
  typeof navigator.credentials?.create === 'function';

export const decodeBase64Url = (value: string): ArrayBuffer => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
};

export const encodeBase64Url = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

const descriptors = (
  list: readonly { type: string; id: string; transports?: readonly string[] | undefined }[],
): PublicKeyCredentialDescriptor[] =>
  list.map((entry) => ({
    type: entry.type as PublicKeyCredentialType,
    id: decodeBase64Url(entry.id),
    ...(entry.transports === undefined
      ? {}
      : { transports: [...entry.transports] as AuthenticatorTransport[] }),
  }));

export const creationOptionsOf = (options: CreationOptions): PublicKeyCredentialCreationOptions =>
  ({
    ...options,
    challenge: decodeBase64Url(options.challenge),
    user: { ...options.user, id: decodeBase64Url(options.user.id) },
    ...(options.excludeCredentials === undefined
      ? {}
      : { excludeCredentials: descriptors(options.excludeCredentials) }),
  }) as unknown as PublicKeyCredentialCreationOptions;

export const requestOptionsOf = (options: RequestOptions): PublicKeyCredentialRequestOptions =>
  ({
    ...options,
    challenge: decodeBase64Url(options.challenge),
    ...(options.allowCredentials === undefined
      ? {}
      : { allowCredentials: descriptors(options.allowCredentials) }),
  }) as unknown as PublicKeyCredentialRequestOptions;

const attachmentOf = (
  credential: PublicKeyCredential,
): { authenticatorAttachment?: 'platform' | 'cross-platform' } =>
  credential.authenticatorAttachment === 'platform' ||
  credential.authenticatorAttachment === 'cross-platform'
    ? { authenticatorAttachment: credential.authenticatorAttachment }
    : {};

export const registrationResponseOf = (credential: PublicKeyCredential): RegistrationResponse => {
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey?.() ?? null;
  const authenticatorData = response.getAuthenticatorData?.();
  const algorithm = response.getPublicKeyAlgorithm?.();
  const transports = response.getTransports?.() ?? [];
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
      ...(authenticatorData === undefined
        ? {}
        : { authenticatorData: encodeBase64Url(authenticatorData) }),
      ...(transports.length === 0 ? {} : { transports }),
      ...(algorithm === undefined ? {} : { publicKeyAlgorithm: algorithm }),
      ...(publicKey === null ? {} : { publicKey: encodeBase64Url(publicKey) }),
    },
    ...attachmentOf(credential),
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
  };
};

export const authenticationResponseOf = (
  credential: PublicKeyCredential,
): AuthenticationResponse => {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      authenticatorData: encodeBase64Url(response.authenticatorData),
      signature: encodeBase64Url(response.signature),
      ...(response.userHandle === null || response.userHandle.byteLength === 0
        ? {}
        : { userHandle: encodeBase64Url(response.userHandle) }),
    },
    ...attachmentOf(credential),
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
  };
};

export class PasskeyCancelled extends Error {
  constructor() {
    super('The passkey request was cancelled.');
    this.name = 'PasskeyCancelled';
  }
}

export const createPasskey = async (options: CreationOptions): Promise<RegistrationResponse> => {
  const credential = await navigator.credentials.create({ publicKey: creationOptionsOf(options) });
  if (credential === null) throw new PasskeyCancelled();
  return registrationResponseOf(credential as PublicKeyCredential);
};

export const getPasskey = async (options: RequestOptions): Promise<AuthenticationResponse> => {
  const credential = await navigator.credentials.get({ publicKey: requestOptionsOf(options) });
  if (credential === null) throw new PasskeyCancelled();
  return authenticationResponseOf(credential as PublicKeyCredential);
};
