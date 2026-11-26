import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { tokenHash } from '@agent-board/sealing';

import type { ServerContext } from '../context.js';
import type { AuthFlow, AuthFlowKind, Json } from '../db/system.js';

export const FLOW_TTL_MS = 10 * 60 * 1000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_HALF = 4;
const FLOW_ID_BYTES = 32;

export const newFlowId = (): string => randomBytes(FLOW_ID_BYTES).toString('base64url');

export const newPairingCode = (): string => {
  const half = (): string =>
    Array.from({ length: CODE_HALF }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(
      '',
    );
  return `${half()}-${half()}`;
};

export const codeHash = (code: string): Promise<string> => tokenHash(code.toUpperCase());

export const verifierMatches = (flow: Pick<AuthFlow, 'challenge'>, verifier: string): boolean => {
  if (flow.challenge === null) return false;
  const expected = Buffer.from(flow.challenge);
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export interface StartedFlow {
  id: string;
  expiresAt: Date;
}

export const startFlow = async (
  context: ServerContext,
  input: {
    kind: AuthFlowKind;
    challenge: string | null;
    data?: Json;
    code?: string;
    owner?: string | null;
  },
): Promise<StartedFlow> => {
  const id = newFlowId();
  const expiresAt = new Date(context.clock.now().getTime() + FLOW_TTL_MS);
  const hashed = input.code === undefined ? null : await codeHash(input.code);
  await context.services.database.withSystem((system) =>
    system.createAuthFlow({
      id,
      kind: input.kind,
      challenge: input.challenge,
      codeHash: hashed,
      data: input.data ?? {},
      owner: input.owner ?? null,
      expiresAt,
    }),
  );
  return { id, expiresAt };
};

const live = (
  context: ServerContext,
  flow: AuthFlow | null,
  kind: AuthFlowKind,
): AuthFlow | null =>
  flow !== null && flow.kind === kind && flow.expiresAt.getTime() > context.clock.now().getTime()
    ? flow
    : null;

export const readFlow = async (
  context: ServerContext,
  id: string,
  kind: AuthFlowKind,
): Promise<AuthFlow | null> =>
  live(
    context,
    await context.services.database.withSystem((system) => system.getAuthFlow(id)),
    kind,
  );

const PAIRING_CODE = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;

export const readHandoffFlow = async (
  context: ServerContext,
  reference: string,
): Promise<AuthFlow | null> =>
  PAIRING_CODE.test(reference)
    ? live(
        context,
        await context.services.database.withSystem(async (system) =>
          system.getAuthFlowByCode(await codeHash(reference)),
        ),
        'handoff',
      )
    : readFlow(context, reference, 'handoff');

export const takeFlow = async (
  context: ServerContext,
  id: string,
  kind: AuthFlowKind,
): Promise<AuthFlow | null> =>
  live(
    context,
    await context.services.database.withSystem((system) => system.takeAuthFlow(id)),
    kind,
  );

export const approveFlow = (
  context: ServerContext,
  id: string,
  owner: string,
  data: Json,
): Promise<boolean> =>
  context.services.database.withSystem((system) => system.approveAuthFlow(id, owner, data));
