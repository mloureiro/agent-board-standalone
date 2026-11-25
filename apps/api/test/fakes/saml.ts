import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

import { signingIdentity } from './certificate.js';
import { listen, type FakeServer } from './http.js';

export interface SamlAnswerOptions {
  nameId?: string;
  groups?: string[];
  signAssertion?: boolean;
  signWithOtherKey?: boolean;
  inResponseTo?: string | null;
  audience?: string;
}

export interface FakeSaml extends FakeServer {
  entityId: string;
  entryPoint: string;
  requestId(authorizeUrl: string): string;
  answer(authorizeUrl: string, options?: SamlAnswerOptions): { SAMLResponse: string; id: string };
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const startFakeSaml = async (spEntityId: string, acsUrl: string): Promise<FakeSaml> => {
  const identity = signingIdentity();
  const stranger = signingIdentity();
  const { server, url } = await listen((issuer) => (_request, response, target) => {
    if (target.pathname !== '/metadata') return void response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/samlmetadata+xml' });
    response.end(
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${issuer}">` +
        `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${identity.certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${issuer}/sso"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`,
    );
  });

  const sign = (xml: string, key: string, reference: string, after: string): string => {
    const signer = new SignedXml({
      privateKey: key,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    signer.addReference({
      xpath: reference,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(xml, { location: { reference: after, action: 'after' } });
    return signer.getSignedXml();
  };

  const requestOf = (authorizeUrl: string) => {
    const encoded = new URL(authorizeUrl).searchParams.get('SAMLRequest') ?? '';
    return new DOMParser().parseFromString(
      inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
      'text/xml',
    ).documentElement;
  };

  return {
    ...server,
    requestId: (authorizeUrl) => requestOf(authorizeUrl)?.getAttribute('ID') ?? '',
    entityId: url,
    entryPoint: `${url}/sso`,
    answer: (authorizeUrl, options = {}) => {
      const encoded = new URL(authorizeUrl).searchParams.get('SAMLRequest') ?? '';
      const request = new DOMParser().parseFromString(
        inflateRawSync(Buffer.from(encoded, 'base64')).toString(),
        'text/xml',
      ).documentElement;
      const requestId =
        options.inResponseTo === undefined ? request?.getAttribute('ID') : options.inResponseTo;
      const inResponseTo = requestId ? ` InResponseTo="${escapeXml(requestId)}"` : '';
      const now = new Date();
      const instant = now.toISOString();
      const expires = new Date(now.getTime() + 300_000).toISOString();
      const assertionId = `_${randomBytes(8).toString('hex')}`;
      const issuer = `<saml:Issuer>${escapeXml(url)}</saml:Issuer>`;
      const groups = (options.groups ?? ['board-users'])
        .map((group) => `<saml:AttributeValue>${escapeXml(group)}</saml:AttributeValue>`)
        .join('');
      const assertion =
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${instant}">${issuer}` +
        `<saml:Subject><saml:NameID>${escapeXml(options.nameId ?? 'Grace@Example.test')}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${expires}" Recipient="${escapeXml(acsUrl)}"${inResponseTo}/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${instant}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${escapeXml(options.audience ?? spEntityId)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${instant}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement><saml:Attribute Name="groups">${groups}</saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
      const signed =
        options.signAssertion === false
          ? assertion
          : sign(
              assertion,
              options.signWithOtherKey === true ? stranger.privateKey : identity.privateKey,
              "/*[local-name(.)='Assertion']",
              "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
            );
      const response =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${instant}" Destination="${escapeXml(acsUrl)}"${inResponseTo}>` +
        `${issuer}<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
      return { SAMLResponse: Buffer.from(response).toString('base64'), id: assertionId };
    },
  };
};
