import { generateKeyPairSync, sign } from 'node:crypto';

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const size =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.from([0x80 | 2, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), size, body]);
};

const SEQUENCE = 0x30;
const sequence = (...parts: Buffer[]): Buffer => der(SEQUENCE, ...parts);
const oid = (bytes: number[]): Buffer => der(0x06, Buffer.from(bytes));
const time = (date: Date): Buffer =>
  der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

const SHA256_RSA = sequence(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der(0x05));
const COMMON_NAME = oid([0x55, 0x04, 0x03]);

export const signingIdentity = (): { privateKey: string; certificate: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = sequence(der(0x31, sequence(COMMON_NAME, der(0x0c, Buffer.from('fake idp')))));
  const now = new Date();
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    SHA256_RSA,
    name,
    sequence(
      time(new Date(now.getTime() - 3_600_000)),
      time(new Date(now.getTime() + 315_360_000_000)),
    ),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const certificate = sequence(
    tbs,
    SHA256_RSA,
    der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)),
  );
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificate: certificate.toString('base64'),
  };
};
