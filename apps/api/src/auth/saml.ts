import {
  SAML,
  ValidateInResponseTo,
  type CacheItem,
  type CacheProvider,
  type Profile,
} from '@node-saml/node-saml';
import { DOMParser } from '@xmldom/xmldom';

import type { AuthFlow } from '../db/system.js';
import type { ServerContext } from '../context.js';
import type { SamlSettings } from '../modules/sign-in/index.js';
import { readFlow, takeFlow } from './flows.js';
import { parseProviderUsername } from './provider-user.js';

export const SAML_ACS_PATH = '/api/auth/saml/acs';
export const SAML_RETURN_PATH = '/auth/saml';

const METADATA_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const XMLDSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const CLOCK_SKEW_MS = 60_000;
const METADATA_TIMEOUT_MS = 10_000;

export interface IdpMetadata {
  entityId: string;
  entryPoint: string;
  certificates: string[];
}

const pemOf = (body: string): string =>
  `-----BEGIN CERTIFICATE-----\n${
    body
      .replace(/\s+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  }\n-----END CERTIFICATE-----`;

export const parseIdpMetadata = (xml: string): IdpMetadata => {
  const document = new DOMParser({ onError: () => undefined }).parseFromString(xml, 'text/xml');
  const descriptor = document.getElementsByTagNameNS(METADATA_NS, 'IDPSSODescriptor').item(0);
  const entity = document.documentElement;
  if (descriptor === null || entity === null) throw new Error('the metadata describes no IdP');
  const services = Array.from(
    descriptor.getElementsByTagNameNS(METADATA_NS, 'SingleSignOnService'),
  );
  const service =
    services.find((candidate) => candidate.getAttribute('Binding') === REDIRECT_BINDING) ??
    services[0];
  const entryPoint = service?.getAttribute('Location');
  const certificates = Array.from(descriptor.getElementsByTagNameNS(METADATA_NS, 'KeyDescriptor'))
    .filter((key) => (key.getAttribute('use') ?? 'signing') === 'signing')
    .flatMap((key) => Array.from(key.getElementsByTagNameNS(XMLDSIG_NS, 'X509Certificate')))
    .map((node) => pemOf(node.textContent ?? ''));
  const entityId = entity.getAttribute('entityID');
  if (!entryPoint || !entityId || certificates.length === 0)
    throw new Error('the metadata lacks an entity ID, a sign-on URL or a signing certificate');
  return { entityId, entryPoint, certificates };
};

export const fetchIdpMetadata = async (settings: SamlSettings): Promise<IdpMetadata> => {
  const response = await fetch(settings.metadataUrl, {
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the IdP metadata answered ${response.status}`);
  return parseIdpMetadata(await response.text());
};

export const isAccepted = (flow: AuthFlow): boolean => flow.data.username !== undefined;

class FlowRequests implements CacheProvider {
  consumed: AuthFlow | null = null;

  constructor(private readonly context: ServerContext) {}

  private flowIdOf(requestId: string): string {
    return requestId.startsWith('_') ? requestId.slice(1) : '';
  }

  async saveAsync(_key: string, value: string): Promise<CacheItem> {
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    const flow = await readFlow(this.context, this.flowIdOf(key), 'saml');
    return flow !== null && !isAccepted(flow) ? flow.expiresAt.toISOString() : null;
  }

  async removeAsync(): Promise<string | null> {
    return null;
  }

  async consumeAsync(key: string): Promise<string | null> {
    const flow = await takeFlow(this.context, this.flowIdOf(key), 'saml');
    if (flow === null || isAccepted(flow)) return null;
    this.consumed = flow;
    return key;
  }
}

const serviceProvider = (
  settings: SamlSettings,
  publicUrl: string,
  metadata: IdpMetadata,
  cache: CacheProvider,
  requestId?: string,
): SAML =>
  new SAML({
    entryPoint: metadata.entryPoint,
    issuer: settings.spEntityId,
    audience: settings.spEntityId,
    idpIssuer: metadata.entityId,
    callbackUrl: `${publicUrl}${SAML_ACS_PATH}`,
    idpCert: metadata.certificates,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: CLOCK_SKEW_MS,
    cacheProvider: cache,
    ...(requestId === undefined ? {} : { generateUniqueId: () => requestId }),
  });

export const samlRequestId = (flowId: string): string => `_${flowId}`;

export const samlAuthorizeUrl = async (
  context: ServerContext,
  settings: SamlSettings,
  publicUrl: string,
  flowId: string,
): Promise<string> => {
  const metadata = await fetchIdpMetadata(settings);
  return serviceProvider(
    settings,
    publicUrl,
    metadata,
    new FlowRequests(context),
    samlRequestId(flowId),
  ).getAuthorizeUrlAsync('', {});
};

const usernameOf = (settings: SamlSettings, profile: Profile): string | null => {
  const value =
    settings.usernameAttribute === null ? profile.nameID : profile[settings.usernameAttribute];
  return parseProviderUsername(Array.isArray(value) ? value[0] : value);
};

export type SamlOutcome =
  { flow: AuthFlow; username: string } | { error: 'refused' | 'no-username' };

export const acceptSamlResponse = async (
  context: ServerContext,
  settings: SamlSettings,
  publicUrl: string,
  samlResponse: string,
): Promise<SamlOutcome> => {
  const requests = new FlowRequests(context);
  try {
    const metadata = await fetchIdpMetadata(settings);
    const { profile } = await serviceProvider(
      settings,
      publicUrl,
      metadata,
      requests,
    ).validatePostResponseAsync({ SAMLResponse: samlResponse });
    if (profile === null || requests.consumed === null) return { error: 'refused' };
    const username = usernameOf(settings, profile);
    return username === null ? { error: 'no-username' } : { flow: requests.consumed, username };
  } catch {
    return { error: 'refused' };
  }
};
