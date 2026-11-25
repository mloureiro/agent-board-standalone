import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;
const COSE_ES256 = -7;

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor>;

const head = (major: number, value: number): Buffer => {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const wide = Buffer.alloc(3);
  wide[0] = (major << 5) | 25;
  wide.writeUInt16BE(value, 1);
  return wide;
};

const cbor = (value: Cbor): Buffer => {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const text = Buffer.from(value);
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  return Buffer.concat([
    head(5, value.size),
    ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
  ]);
};

const sha256 = (value: Buffer | string): Buffer => createHash('sha256').update(value).digest();

const coseKeyOf = (publicKey: KeyObject): Buffer => {
  const jwk = publicKey.export({ format: 'jwk' });
  return cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, COSE_ES256],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? '', 'base64url')],
      [-3, Buffer.from(jwk.y ?? '', 'base64url')],
    ]),
  );
};

export interface AssertionOptions {
  challenge: string;
  origin?: string;
  counter?: number;
  userVerified?: boolean;
  rpId?: string;
  type?: string;
}

export interface RegistrationOptions {
  challenge: string;
  origin?: string;
  userVerified?: boolean;
  rpId?: string;
}

export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32).toString('base64url');
  counter = 0;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private flags(userVerified: boolean, attested: boolean): number {
    return (
      FLAG_USER_PRESENT | (userVerified ? FLAG_USER_VERIFIED : 0) | (attested ? FLAG_ATTESTED : 0)
    );
  }

  private header(rpId: string, flags: number, counter: number): Buffer {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counterBytes]);
  }

  register(options: RegistrationOptions) {
    const credentialId = Buffer.from(this.credentialId, 'base64url');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      this.header(options.rpId ?? this.rpId, this.flags(options.userVerified ?? true, true), 0),
      Buffer.alloc(16),
      length,
      credentialId,
      coseKeyOf(this.publicKey),
    ]);
    const clientData = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: options.origin ?? this.origin,
      crossOrigin: false,
    });
    const attestation = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: Buffer.from(clientData).toString('base64url'),
        attestationObject: attestation.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  assert(options: AssertionOptions) {
    this.counter = options.counter ?? this.counter + 1;
    const authData = this.header(
      options.rpId ?? this.rpId,
      this.flags(options.userVerified ?? true, false),
      this.counter,
    );
    const clientData = JSON.stringify({
      type: options.type ?? 'webauthn.get',
      challenge: options.challenge,
      origin: options.origin ?? this.origin,
      crossOrigin: false,
    });
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.privateKey,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: Buffer.from(clientData).toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      clientExtensionResults: {},
    };
  }
}
