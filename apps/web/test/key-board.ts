import { SIGNATURE_HEADERS, canonicalString, type UiDevice } from '@agent-board/contract';
import {
  contentDigest,
  importPublicKey,
  signingKeyId,
  verify,
  type KdfParams,
  type KeySetup,
} from '@agent-board/sealing';

import { FakeBoard, json, type FakeSession } from './fake-board.js';
import { versionDocument } from './versions.js';

export const TEST_KDF: KdfParams = { m: 8192, t: 1, p: 1 };

const goldenSetup: KeySetup = {
  keyId: 'f72efc14a1f06cc7',
  slots: [
    {
      kind: 'passphrase',
      kdf: 'argon2id',
      m: 8192,
      t: 1,
      p: 1,
      salt: 'b7Qcy0bz7r9C9rwLA01LKg',
      wrapped:
        'abw1.yoOMYSRFCYkarBB43KkTrylfzn2FfE5HoDarlupFiOKv0pUlNtoTbGnZxNlTnDxlsfT_FF9dCRC8uJa1',
    },
    {
      kind: 'recovery',
      wrapped:
        'abw1.M2RXxxueBEXvpnb4J-mPMRPCOfWkq-GSuNSjpWgwWeMjdeAJwpPuxzAHrNAxCJBxvk4I5UQutGvpeipD',
    },
  ],
};

export const GOLDEN = {
  owner: 'vector-owner-2',
  passphrase: 'correct horse battery staple',
  keyId: 'f72efc14a1f06cc7',
  recoveryKey: 'D9ZY-8D07-ST0C-J2KX-G443-4W3Q-QYJ0-WVR0-JMXB-XTE8-HRMW-HER4-9YB0-3SXC',
  setup: goldenSetup,
  sealed: {
    dataKey: 'abk1_0oW3qmoyChN_3S4oX3v23ZxnWOroBVBONYWwXdjHtc0',
    keyId: '51d1c555f3d07852',
  },
  title: {
    task: 'tsk_0001',
    plaintext: 'Fix the flaky login test',
    envelope: 'abe1.Ymn-iyFdLkBxtDTNPwhDo0fxh9VYZBLxTKJTpjBOPAoAr7WEe3rDpTCh_YHhOweRNW1WNw',
  },
} as const;

export const PAIR_CODE = 'ABCD-2345';

export interface KeyBoardOptions {
  readonly setup?: KeySetup | null;
  readonly owner?: string;
  readonly signature?: boolean;
  readonly session?: FakeSession;
  readonly features?: readonly string[];
}

const slice = (setup: KeySetup | null): KeySetup | null =>
  setup === null ? null : (JSON.parse(JSON.stringify(setup)) as KeySetup);

export class KeyBoard extends FakeBoard {
  owner: string;
  setup: KeySetup | null;
  signature: boolean;
  features: readonly string[];
  devices: UiDevice[] = [];
  rejectSignedRequests = false;
  checkHeaders = true;
  readonly bound = new Map<string, string>();
  readonly signingIds = new Map<string, string>();
  readonly imported: { table: string; rows: unknown[]; keyId: string }[] = [];
  readonly signatureFailures: string[] = [];
  private nextDevice = 1;

  constructor(options: KeyBoardOptions = {}) {
    super({ session: options.session ?? 'not-required' });
    this.owner = options.owner ?? GOLDEN.owner;
    this.setup = slice(options.setup === undefined ? GOLDEN.setup : options.setup);
    this.signature = options.signature ?? false;
    this.features = options.features ?? ['pairing', 'devices', 'board-export'];
  }

  versionBody(): unknown {
    return versionDocument({
      features: [...this.features],
      modules: {
        signIn: [],
        requestSignature: this.signature,
        scheduling: true,
        feeds: true,
      },
      session: this.session,
    });
  }

  addDevice(label: string, kind: UiDevice['kind'] = 'paired'): UiDevice {
    const keyId = this.nextDevice.toString(16).padStart(16, '0');
    this.nextDevice += 1;
    const device: UiDevice = {
      keyId,
      label,
      kind,
      createdAt: '2026-11-25T08:00:00.000Z',
      lastUsedAt: null,
    };
    this.devices.push(device);
    return device;
  }

  private async signatureProblem(method: string): Promise<string | null> {
    const { headers, pathWithQuery, raw } = this.current;
    const keyId = headers[SIGNATURE_HEADERS.key];
    const publicKey = keyId === undefined ? undefined : this.bound.get(keyId);
    if (publicKey === undefined) return 'key-unknown';
    const digest = raw === '' ? null : await contentDigest(new TextEncoder().encode(raw));
    if ((headers[SIGNATURE_HEADERS.digest] ?? null) !== digest) return 'digest';
    const canonical = canonicalString({
      method,
      pathWithQuery,
      ts: Number(headers[SIGNATURE_HEADERS.ts]),
      nonce: headers[SIGNATURE_HEADERS.nonce] ?? '',
      digest,
    });
    const ok = await verify(
      await importPublicKey(publicKey),
      canonical,
      headers[SIGNATURE_HEADERS.sig] ?? '',
    );
    return ok ? null : 'signature';
  }

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (this.signature && path.startsWith('/api/client/')) {
      const problem = this.rejectSignedRequests
        ? 'key-unknown'
        : this.checkHeaders
          ? await this.signatureProblem(method)
          : null;
      if (problem !== null) {
        this.signatureFailures.push(problem);
        return json(401, { error: { code: 'key-unknown', message: 'The key is not known.' } });
      }
    }
    switch (`${method} ${path}`) {
      case 'POST /api/auth/handoff/finish': {
        const finished = super.answer(method, path, body);
        if (this.approved && typeof body?.publicKey === 'string') {
          this.bound.set(await signingKeyId(body.publicKey), body.publicKey);
        }
        return finished;
      }
      case 'GET /api/version':
        return json(200, this.versionBody());
      case 'GET /api/client/me':
        return json(200, { username: this.owner, keyId: this.setup?.keyId ?? null });
      case 'GET /api/client/keys/get':
        return json(200, { setup: this.setup });
      case 'POST /api/client/keys/setup':
        if (this.setup !== null)
          return json(409, { error: { code: 'conflict', message: 'Already set up.' } });
        this.setup = body as unknown as KeySetup;
        return json(200, {});
      case 'POST /api/client/keys/replace-slots':
        this.setup = body as unknown as KeySetup;
        return json(200, {});
      case 'POST /api/pair': {
        if (body?.code !== PAIR_CODE)
          return json(403, { error: { code: 'forbidden', message: 'refused' } });
        const device = this.addDevice(String(body.label));
        const signingId = await signingKeyId(String(body.publicKey));
        this.bound.set(signingId, String(body.publicKey));
        this.signingIds.set(device.keyId, signingId);
        return json(200, { keyId: device.keyId });
      }
      case 'GET /api/client/devices/list':
        return json(200, { devices: this.devices });
      case 'POST /api/client/devices/revoke':
        this.devices = this.devices.filter((device) => device.keyId !== body?.keyId);
        this.bound.delete(this.signingIds.get(String(body?.keyId)) ?? '');
        return json(200, {});
      case 'POST /api/client/account/import':
        this.imported.push({
          table: String(body?.table),
          rows: (body?.rows as unknown[]) ?? [],
          keyId: String(body?.keyId),
        });
        return json(200, {
          inserted: ((body?.rows as unknown[]) ?? []).length,
          existing: 0,
          invalid: 0,
          orphaned: 0,
        });
      default:
        return super.answer(method, path, body);
    }
  }
}
