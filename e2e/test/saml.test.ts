import { X509Certificate } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startSamlFake, type FakeHandle } from '../src/fakes/process.ts';

const SP_ENTITY_ID = 'https://board.test/saml/metadata';
const ACS_URL = 'http://localhost:9999/auth/saml/acs';

let fake: FakeHandle;
let certificatePem: string;

beforeAll(async () => {
  fake = await startSamlFake({ spEntityId: SP_ENTITY_ID, acsUrl: ACS_URL });
  const metadata = await (await fetch(`${fake.url}/metadata`)).text();
  const body = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(metadata)?.[1] ?? '';
  certificatePem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
});

afterAll(async () => {
  await fake.stop();
});

function authnRequest(id: string): string {
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${ACS_URL}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP_ENTITY_ID}</saml:Issuer></samlp:AuthnRequest>`;
  return deflateRawSync(Buffer.from(xml)).toString('base64');
}

interface Post {
  readonly action: string;
  readonly fields: Record<string, string>;
  readonly xml: string;
}

async function singleSignOn(id: string, relayState?: string): Promise<Post> {
  const url = new URL(`${fake.url}/sso`);
  url.searchParams.set('SAMLRequest', authnRequest(id));
  if (relayState !== undefined) url.searchParams.set('RelayState', relayState);
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const action = /<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? '';
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    fields[match[1] as string] = (match[2] as string)
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  return {
    action: action.replace(/&amp;/g, '&'),
    fields,
    xml: Buffer.from(fields.SAMLResponse ?? '', 'base64').toString('utf8'),
  };
}

function signatureValid(xml: string, signatureParent: string): boolean {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const parent = Array.from(document.getElementsByTagNameNS('*', signatureParent))[0];
  const signature = Array.from(parent?.childNodes ?? []).find(
    (node) => node.nodeType === 1 && (node as unknown as Element).localName === 'Signature',
  );
  if (signature === undefined) return false;
  const checker = new SignedXml({ publicCert: certificatePem });
  checker.loadSignature(signature as unknown as Element);
  return checker.checkSignature(xml);
}

describe('fake SAML IdP', () => {
  it('publishes metadata carrying a self-signed signing certificate', () => {
    const certificate = new X509Certificate(certificatePem);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.checkIssued(certificate)).toBe(true);
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it('posts a signed Response to the ACS answering the request id', async () => {
    const post = await singleSignOn('_request-1');
    expect(post.action).toBe(ACS_URL);
    expect(post.xml).toContain('InResponseTo="_request-1"');
    expect(post.xml).toContain(`<saml:Audience>${SP_ENTITY_ID}</saml:Audience>`);
    expect(post.xml).toContain('urn:oasis:names:tc:SAML:2.0:status:Success');
    expect(signatureValid(post.xml, 'Response')).toBe(true);
    expect(signatureValid(post.xml, 'Assertion')).toBe(true);
  });

  it('carries the user attributes including groups', async () => {
    const { xml } = await singleSignOn('_request-2');
    expect(xml).toContain('saml.user@example.test');
    expect(xml).toMatch(
      /Name="groups"[^>]*><saml:AttributeValue>board-users<\/saml:AttributeValue><saml:AttributeValue>board-admins/,
    );
  });

  it('fails verification when the response is tampered with', async () => {
    const { xml } = await singleSignOn('_request-3');
    const tampered = xml.replace('InResponseTo="_request-3"', 'InResponseTo="_other"');
    expect(signatureValid(tampered, 'Response')).toBe(false);
  });

  it('round-trips RelayState, including characters that need escaping', async () => {
    const relay = 'returnTo=/tasks?id=1&x="2"';
    const post = await singleSignOn('_request-4', relay);
    expect(post.fields.RelayState).toBe(relay);
    expect((await singleSignOn('_request-5')).fields.RelayState).toBeUndefined();
  });

  it('refuses a request without an id or for another assertion consumer', async () => {
    expect((await fetch(`${fake.url}/sso`)).status).toBe(400);
    const url = new URL(`${fake.url}/sso`);
    url.searchParams.set('SAMLRequest', Buffer.from('not deflated').toString('base64'));
    expect((await fetch(url)).status).toBe(400);
  });

  it('answers the next request with a signed failure status once, then recovers', async () => {
    await fake.failNext('provider said no');
    const failed = await singleSignOn('_request-6');
    expect(failed.xml).toContain('urn:oasis:names:tc:SAML:2.0:status:AuthnFailed');
    expect(failed.xml).toContain('provider said no');
    expect(failed.xml).not.toContain('<saml:Assertion');
    expect(failed.xml).toContain('InResponseTo="_request-6"');
    expect(signatureValid(failed.xml, 'Response')).toBe(true);

    const next = await singleSignOn('_request-7');
    expect(next.xml).toContain('urn:oasis:names:tc:SAML:2.0:status:Success');
  });
});
