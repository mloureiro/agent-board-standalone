import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { codeHash, FLOW_TTL_MS, newFlowId, newPairingCode } from '../../auth/index.js';
import type { Clock } from '../../clock.js';
import type { HoldableDatabase } from '../database/index.js';
import type { ApiConfig } from '../registry.js';
import type { OpenStreams } from '../../streams.js';
import type { HoldGate } from './hold-gate.js';

export interface ControlTarget {
  config: ApiConfig;
  clock: Clock;
  gate: HoldGate;
  database: HoldableDatabase;
  streams: OpenStreams;
}

export interface ControlSocket {
  close(): Promise<void>;
}

interface Answer {
  status: number;
  body: unknown;
}

const answer = (status: number, body: unknown): Answer => ({ status, body });
const refuse = (status: number, message: string): Answer => answer(status, { error: message });

const pairCode = async (target: ControlTarget): Promise<Answer> => {
  const { config, clock, database } = target;
  if (!config.requestSignature)
    return refuse(409, 'REQUEST_SIGNATURE is off: there is nothing to pair');
  if (config.signIn.mode !== 'no-login')
    return refuse(409, 'pairing codes are for a server without login');
  if (!database.isOpen()) return refuse(503, 'the board is on hold');
  const code = newPairingCode();
  const hashed = await codeHash(code);
  await database.withSystem((system) =>
    system.createAuthFlow({
      id: newFlowId(),
      kind: 'pair',
      codeHash: hashed,
      expiresAt: new Date(clock.now().getTime() + FLOW_TTL_MS),
    }),
  );
  return answer(200, { code });
};

const hold = async (target: ControlTarget): Promise<Answer> => {
  const drained = target.gate.hold();
  target.streams.endAll();
  await drained;
  await target.database.hold();
  return answer(200, { ok: true });
};

const resume = async (target: ControlTarget): Promise<Answer> => {
  await target.database.resume();
  target.gate.release();
  return answer(200, { ok: true });
};

const status = (target: ControlTarget): Answer =>
  answer(200, { ok: true, state: target.gate.isHeld() ? 'held' : 'running' });

const COMMANDS: Record<string, (target: ControlTarget) => Promise<Answer> | Answer> = {
  '/pair-code': pairCode,
  '/hold': hold,
  '/resume': resume,
  '/status': status,
};

const send = (response: ServerResponse, result: Answer): void => {
  const text = JSON.stringify(result.body);
  response.writeHead(result.status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
};

const handle = async (
  target: ControlTarget,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  request.resume();
  const path = (request.url ?? '').split('?')[0] ?? '';
  const command = COMMANDS[path];
  if (command === undefined) return send(response, refuse(404, 'unknown command'));
  if (request.method !== 'POST') return send(response, refuse(405, 'use POST'));
  try {
    send(response, await command(target));
  } catch (error) {
    send(response, refuse(500, error instanceof Error ? error.message : String(error)));
  }
};

const OWNER_ONLY_UMASK = 0o177;

const removeStaleSocket = (path: string): void => {
  let found;
  try {
    found = lstatSync(path);
  } catch {
    return;
  }
  if (!found.isSocket())
    throw new Error(`CONTROL_SOCKET ${path} exists and is not a socket: refusing to replace it`);
  rmSync(path, { force: true });
};

export const startControlSocket = async (
  path: string,
  target: ControlTarget,
): Promise<ControlSocket> => {
  removeStaleSocket(path);
  const server = createServer((request, response) => {
    void handle(target, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const umask = process.umask(OWNER_ONLY_UMASK);
    try {
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      process.umask(umask);
    }
  });
  chmodSync(path, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};
