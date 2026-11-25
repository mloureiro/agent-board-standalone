import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { inflateRawSync } from 'node:zlib';

import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

import { readBody, sendJson, sendText, type Handler } from '../http.ts';
import { createSigningIdentity } from './certificate.ts';

export interface SamlUser {
  readonly email: string;
  readonly name: string;
  readonly groups: readonly string[];
}

export const DEFAULT_SAML_USER: SamlUser = {
  email: 'saml.user@example.test',
  name: 'Saml User',
  groups: ['board-users', 'board-admins'],
};

export interface SamlIdpOptions {
  readonly issuer: string;
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly user?: SamlUser;
}

export interface SamlIdp {
  readonly handler: Handler;
  readonly certificatePem: string;
}

const VALIDITY_MS = 5 * 60 * 1000;
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function newId(): string {
  return `_${randomBytes(16).toString('hex')}`;
}

function attribute(name: string, values: readonly string[]): string {
  const items = values
    .map((value) => `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>`)
    .join('');
  return `<saml:Attribute Name="${name}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${items}</saml:Attribute>`;
}

function certificateBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

function formPage(acsUrl: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeXml(value)}"/>`)
    .join('');
  return `<!doctype html><html><body onload="document.forms[0].submit()"><form method="post" action="${escapeXml(acsUrl)}">${inputs}<noscript><button type="submit">Continue</button></noscript></form></body></html>`;
}

export function createSamlIdp(options: SamlIdpOptions): SamlIdp {
  const user = options.user ?? DEFAULT_SAML_USER;
  const identity = createSigningIdentity(`${new URL(options.issuer).host} fake SAML IdP`);
  let nextError: { message: string } | null = null;

  const sign = (xml: string, referenceXpath: string, issuerXpath: string): string => {
    const signer = new SignedXml({
      privateKey: identity.privateKeyPem,
      publicCert: identity.certificatePem,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    signer.addReference({
      xpath: referenceXpath,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(xml, { location: { reference: issuerXpath, action: 'after' } });
    return signer.getSignedXml();
  };

  const buildResponse = (requestId: string | null, failure: string | null): string => {
    const now = new Date();
    const instant = now.toISOString();
    const expires = new Date(now.getTime() + VALIDITY_MS).toISOString();
    const inResponseTo = requestId === null ? '' : ` InResponseTo="${escapeXml(requestId)}"`;
    const issuerElement = `<saml:Issuer>${escapeXml(options.issuer)}</saml:Issuer>`;
    const head = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${newId()}" Version="2.0" IssueInstant="${instant}" Destination="${escapeXml(options.acsUrl)}"${inResponseTo}>`;
    const issuerXpath = "/*[local-name(.)='Response']/*[local-name(.)='Issuer']";
    const responseXpath = "/*[local-name(.)='Response']";

    if (failure !== null) {
      const status = `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"/></samlp:StatusCode><samlp:StatusMessage>${escapeXml(failure)}</samlp:StatusMessage></samlp:Status>`;
      return sign(`${head}${issuerElement}${status}</samlp:Response>`, responseXpath, issuerXpath);
    }

    const assertionId = newId();
    const confirmationData = `<saml:SubjectConfirmationData NotOnOrAfter="${expires}" Recipient="${escapeXml(options.acsUrl)}"${inResponseTo}/>`;
    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${instant}">${issuerElement}` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(user.email)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">${confirmationData}</saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${instant}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${escapeXml(options.spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement>${attribute('email', [user.email])}${attribute('name', [user.name])}${attribute('groups', user.groups)}</saml:AttributeStatement>` +
      `</saml:Assertion>`;
    const signedAssertion = sign(
      assertion,
      "/*[local-name(.)='Assertion']",
      "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
    );
    const status = `<samlp:Status><samlp:StatusCode Value="${SUCCESS}"/></samlp:Status>`;
    return sign(
      `${head}${issuerElement}${status}${signedAssertion}</samlp:Response>`,
      responseXpath,
      issuerXpath,
    );
  };

  const metadata = (): string =>
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${escapeXml(options.issuer)}">` +
    `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificateBody(identity.certificatePem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escapeXml(options.issuer)}/sso"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`;

  const sso = (url: URL, response: http.ServerResponse): void => {
    const encoded = url.searchParams.get('SAMLRequest');
    if (encoded === null) {
      sendJson(response, 400, { error: 'missing SAMLRequest' });
      return;
    }
    let requestId: string | null;
    let requestedAcs: string | null;
    try {
      const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
      const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
      requestId = root?.getAttribute('ID') ?? null;
      requestedAcs = root?.getAttribute('AssertionConsumerServiceURL') || null;
    } catch {
      sendJson(response, 400, { error: 'unreadable SAMLRequest' });
      return;
    }
    if (requestId === null || requestId === '') {
      sendJson(response, 400, { error: 'AuthnRequest has no ID' });
      return;
    }
    if (requestedAcs !== null && requestedAcs !== options.acsUrl) {
      sendJson(response, 400, { error: 'unknown AssertionConsumerServiceURL' });
      return;
    }
    const failure = nextError;
    nextError = null;
    const fields: Record<string, string> = {
      SAMLResponse: Buffer.from(
        buildResponse(requestId, failure === null ? null : failure.message),
      ).toString('base64'),
    };
    const relayState = url.searchParams.get('RelayState');
    if (relayState !== null) fields.RelayState = relayState;
    sendText(response, 200, 'text/html; charset=utf-8', formPage(options.acsUrl, fields));
  };

  const handler: Handler = async (request, response) => {
    const url = new URL(request.url ?? '/', options.issuer);
    const method = request.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/metadata') {
      sendText(response, 200, 'application/samlmetadata+xml', metadata());
    } else if (method === 'GET' && url.pathname === '/sso') {
      sso(url, response);
    } else if (method === 'POST' && url.pathname === '/control/next-error') {
      const body = (await readBody(request)).trim();
      const given = body === '' ? {} : (JSON.parse(body) as { description?: string });
      nextError = { message: given.description ?? 'The user denied access' };
      sendJson(response, 200, { armed: nextError });
    } else {
      sendJson(response, 404, { error: 'not_found' });
    }
  };

  return { handler, certificatePem: identity.certificatePem };
}
