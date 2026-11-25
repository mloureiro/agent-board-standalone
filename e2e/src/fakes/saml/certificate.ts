import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OID = 0x06;
const NULL = 0x05;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const [first = 0, second = 0, ...rest] = parts;
  const bytes: number[] = [first * 40 + second];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(OID, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(UTC_TIME, Buffer.from(`${text}Z`, 'ascii'));
}

function commonName(name: string): Buffer {
  return tlv(
    SEQUENCE,
    tlv(SET, tlv(SEQUENCE, oid('2.5.4.3'), tlv(UTF8_STRING, Buffer.from(name)))),
  );
}

const SHA256_WITH_RSA = tlv(SEQUENCE, oid('1.2.840.113549.1.1.11'), tlv(NULL));

export interface SigningIdentity {
  readonly privateKey: KeyObject;
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}

export function createSigningIdentity(subject: string, now = new Date()): SigningIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = commonName(subject);
  const notAfter = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);
  const serial = Buffer.concat([Buffer.from([0x01]), Buffer.from(String(now.getTime()), 'ascii')]);
  const tbs = tlv(
    SEQUENCE,
    tlv(0xa0, tlv(INTEGER, Buffer.from([0x02]))),
    tlv(INTEGER, serial),
    SHA256_WITH_RSA,
    name,
    tlv(SEQUENCE, utcTime(new Date(now.getTime() - 3600 * 1000)), utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = tlv(
    SEQUENCE,
    tbs,
    SHA256_WITH_RSA,
    tlv(BIT_STRING, Buffer.from([0x00]), signature),
  );
  const base64 =
    certificate
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return {
    privateKey,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificatePem: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}
