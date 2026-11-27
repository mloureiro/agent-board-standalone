import { CONTRACT, MIN_CLIENT, MIN_SERVER, FEATURES } from '@rumo/contract';
import { deriveKeys, encodeDataKey, generateDataKey } from '@rumo/sealing';

import { startServer, type Answer, type FakeServer, type SeenRequest } from './server.js';

export const TEST_TOKEN = 'abm_testtoken';
export const OWNER = 'test-owner';
export const MACHINE = 'test-machine';

export interface FakeBoardOptions {
  readonly contract?: number;
  readonly minClient?: number;
  readonly requestSignature?: boolean;
  readonly features?: readonly string[];
  readonly extra?: (request: SeenRequest) => Answer | undefined | Promise<Answer | undefined>;
  readonly keyId?: string | null;
  readonly machineVersion?: () => Record<string, unknown>;
}

export interface FakeBoard extends FakeServer {
  readonly dataKey: string;
  readonly keyId: string;
}

export async function startBoard(options: FakeBoardOptions = {}): Promise<FakeBoard> {
  const dataKeyBytes = generateDataKey();
  const dataKey = encodeDataKey(dataKeyBytes);
  const keyId = (await deriveKeys(dataKeyBytes, OWNER)).keyId;
  const features = options.features ?? FEATURES;
  const contract = options.contract ?? CONTRACT;
  const minClient = options.minClient ?? MIN_CLIENT.cli;
  const signature = options.requestSignature === true;
  let bound = false;

  const server = await startServer((request) => {
    if (request.path === '/api/version') {
      return {
        body: {
          contract,
          minClient: { cli: minClient, web: minClient },
          features,
          server: { version: '1.2.3', commit: null },
          modules: { signIn: [], requestSignature: signature, scheduling: true, feeds: true },
          session: 'none',
        },
      };
    }
    if (request.path === '/api/machine/register-key') {
      if (bound)
        return {
          status: 409,
          body: { error: { code: 'conflict', message: 'a key is already bound' } },
        };
      bound = true;
      return { body: { keyId: 'a'.repeat(16) } };
    }
    if (request.path === '/api/machine/version') {
      if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
        return { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } };
      }
      if (signature && bound && request.headers['x-board-sig'] === undefined) {
        return { status: 401, body: { error: { code: 'signature-invalid', message: 'unsigned' } } };
      }
      return {
        body: {
          contract,
          minClient: { cli: minClient, web: minClient },
          minServer: MIN_SERVER,
          features,
          server: { version: '1.2.3', commit: null },
          owner: OWNER,
          keyId: options.keyId === undefined ? keyId : options.keyId,
          machine: MACHINE,
          cli: null,
          catalogIndex: null,
          usageIndex: null,
          feedsIndex: null,
          feedRequests: [],
          agentsVersion: null,
          legacyDirs: false,
          grant: false,
          requestSignature: signature,
          ...options.machineVersion?.(),
        },
      };
    }
    return options.extra?.(request);
  });
  return { ...server, dataKey, keyId };
}
