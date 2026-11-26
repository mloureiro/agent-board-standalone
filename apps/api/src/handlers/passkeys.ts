import { and, asc, eq } from 'drizzle-orm';

import {
  DEFAULT_PASSKEY_NAME,
  admitUser,
  loginOptionsFor,
  passkeyLabelOf,
  registrationOptionsFor,
  signupNameOf,
  signupTokenMatches,
  startFlow,
  takeFlow,
  verifyAuthentication,
  verifyRegistration,
  type VerifiedPasskey,
} from '../auth/index.js';
import type { ServerContext } from '../context.js';
import * as schema from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';
import type { LoginConfig } from '../modules/sign-in/index.js';
import { startCookieSession } from './sign-in.js';

const SIGN_IN_FAILED = 'sign-in failed';
const NAME_TAKEN = 'That name is taken. Pick another.';
const ALREADY_REGISTERED = 'That passkey is already registered.';
const LAST_PASSKEY = 'This is your only way to sign in: add another passkey before removing it.';
const REGISTRATION_EXPIRED = 'This registration has expired. Start again.';
const NEEDS_NAME = 'Give the passkey a name.';

const passkeyConfig = (context: ServerContext): LoginConfig => {
  const { signIn } = context.config;
  if (signIn.mode !== 'login' || !signIn.passkeys)
    throw new ApiError('not-enabled', 'Passkeys are switched off on this board.');
  return signIn;
};

const ONLY_CLAIMED = 'Sign-up on this board is open only to the account being set up.';

const refuseOtherThanClaimed = (login: LoginConfig, username: string): void => {
  if (login.claimUser !== null && username !== login.claimUser)
    throw new ApiError('forbidden', ONLY_CLAIMED);
};

const claimable = (login: LoginConfig, username: string, source: string | null): boolean =>
  username === login.claimUser && source === null;

const challengeOf = (data: Record<string, unknown>): string =>
  typeof data.challenge === 'string' ? data.challenge : '';

const labelOrRefuse = (raw: string | undefined, fallback?: string): string => {
  const label = passkeyLabelOf(raw, fallback);
  if (label === null) throw new ApiError('bad-request', NEEDS_NAME);
  return label;
};

const refuseUnverified = async <T>(
  work: Promise<T>,
  code: 'forbidden' | 'bad-request',
  message: string,
): Promise<T> => {
  try {
    return await work;
  } catch {
    throw new ApiError(code, message);
  }
};

export const passkeyHandlers: HandlerSet = (context) => {
  const { database } = context.services;

  const store = (owner: string, label: string, verified: VerifiedPasskey) =>
    database.withOwner(owner, (tx) =>
      tx
        .insert(schema.passkey)
        .values({
          credentialId: verified.credentialId,
          publicKey: verified.publicKey,
          counter: verified.counter,
          transports: verified.transports,
          name: label,
        })
        .onConflictDoNothing()
        .returning({ credentialId: schema.passkey.credentialId }),
    );

  return {
    'auth.passkey.login-options': async () => {
      const login = passkeyConfig(context);
      const options = await loginOptionsFor(login);
      const started = await startFlow(context, {
        kind: 'passkey-login',
        challenge: null,
        data: { challenge: options.challenge },
      });
      return { options, flow: started.id };
    },

    'auth.passkey.login': async ({ input, reply }) => {
      const login = passkeyConfig(context);
      const flow = await takeFlow(context, input.flow, 'passkey-login');
      if (flow === null) throw new ApiError('forbidden', SIGN_IN_FAILED);
      const stored = await database.withSystem((system) => system.lookupPasskey(input.response.id));
      if (stored === null) throw new ApiError('forbidden', SIGN_IN_FAILED);
      const known: VerifiedPasskey = {
        credentialId: input.response.id,
        publicKey: stored.publicKey,
        counter: stored.counter,
        transports: stored.transports,
      };
      const counter = await refuseUnverified(
        verifyAuthentication(login, input.response, challengeOf(flow.data), known),
        'forbidden',
        SIGN_IN_FAILED,
      );
      const advanced = await database.withOwner(stored.owner, (tx) =>
        tx
          .update(schema.passkey)
          .set({ counter, lastUsedAt: context.clock.now() })
          .where(
            and(
              eq(schema.passkey.credentialId, stored.credentialId),
              eq(schema.passkey.counter, stored.counter),
            ),
          )
          .returning({ credentialId: schema.passkey.credentialId }),
      );
      if (advanced.length === 0) throw new ApiError('forbidden', SIGN_IN_FAILED);
      await startCookieSession(
        context,
        reply,
        login.scheme,
        stored.owner,
        'passkey',
        input.publicKey,
      );
      return { ok: true };
    },

    'auth.passkey.signup-options': async ({ input }) => {
      const login = passkeyConfig(context);
      if (login.signupToken === null)
        throw new ApiError('forbidden', 'Sign-up is closed on this board.');
      if (!signupTokenMatches(login.signupToken, input.signupToken))
        throw new ApiError('forbidden', 'The sign-up token is not right.');
      const username = signupNameOf(input.username);
      if (username === null)
        throw new ApiError(
          'bad-request',
          'A name is lower case letters, digits, dots, dashes, underscores and @, up to 64.',
        );
      refuseOtherThanClaimed(login, username);
      const existing = await database.withSystem((system) => system.lookupUser(username));
      if (existing !== null && !claimable(login, username, existing.source))
        throw new ApiError('forbidden', NAME_TAKEN);
      const options = await registrationOptionsFor(login, username, []);
      const started = await startFlow(context, {
        kind: 'passkey-signup',
        challenge: null,
        data: { challenge: options.challenge, username },
      });
      return { options, flow: started.id };
    },

    'auth.passkey.signup': async ({ input, reply }) => {
      const login = passkeyConfig(context);
      const flow = await takeFlow(context, input.flow, 'passkey-signup');
      if (flow === null) throw new ApiError('forbidden', SIGN_IN_FAILED);
      const username = signupNameOf(String(flow.data.username));
      if (username === null) throw new ApiError('forbidden', SIGN_IN_FAILED);
      const label = labelOrRefuse(input.name, DEFAULT_PASSKEY_NAME);
      const verified = await refuseUnverified(
        verifyRegistration(login, input.response, challengeOf(flow.data)),
        'forbidden',
        SIGN_IN_FAILED,
      );
      refuseOtherThanClaimed(login, username);
      await database.withOwner(username, async (tx) => {
        const [existing] = await tx
          .select({ source: schema.appUser.source })
          .from(schema.appUser)
          .where(eq(schema.appUser.username, username));
        if (existing !== undefined && !claimable(login, username, existing.source))
          throw new ApiError('forbidden', NAME_TAKEN);
        await admitUser(tx, username, 'passkey');
        const stored = await tx
          .insert(schema.passkey)
          .values({
            credentialId: verified.credentialId,
            publicKey: verified.publicKey,
            counter: verified.counter,
            transports: verified.transports,
            name: label,
          })
          .onConflictDoNothing()
          .returning({ credentialId: schema.passkey.credentialId });
        if (stored.length === 0) throw new ApiError('forbidden', ALREADY_REGISTERED);
      });
      await startCookieSession(context, reply, login.scheme, username, 'passkey', input.publicKey);
      return { ok: true };
    },

    'client.passkeys.list': async ({ principal }) => {
      const rows = await database.withOwner(principal.owner, (tx) =>
        tx.select().from(schema.passkey).orderBy(asc(schema.passkey.createdAt)),
      );
      return {
        passkeys: rows.map((row) => ({
          id: row.credentialId,
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
        })),
      };
    },

    'client.passkeys.register-options': async ({ principal }) => {
      const login = passkeyConfig(context);
      const existing = await database.withOwner(principal.owner, (tx) =>
        tx
          .select({
            credentialId: schema.passkey.credentialId,
            transports: schema.passkey.transports,
          })
          .from(schema.passkey),
      );
      const options = await registrationOptionsFor(login, principal.owner, existing);
      const started = await startFlow(context, {
        kind: 'passkey-register',
        challenge: null,
        data: { challenge: options.challenge },
        owner: principal.owner,
      });
      return { options, flow: started.id };
    },

    'client.passkeys.register': async ({ input, principal }) => {
      const login = passkeyConfig(context);
      const label = labelOrRefuse(input.name);
      const flow = await takeFlow(context, input.flow, 'passkey-register');
      if (flow === null || flow.owner !== principal.owner)
        throw new ApiError('bad-request', REGISTRATION_EXPIRED);
      const verified = await refuseUnverified(
        verifyRegistration(login, input.response, challengeOf(flow.data)),
        'bad-request',
        'The passkey could not be verified.',
      );
      const stored = await store(principal.owner, label, verified);
      if (stored.length === 0) throw new ApiError('conflict', ALREADY_REGISTERED);
      return {};
    },

    'client.passkeys.rename': async ({ input, principal }) => {
      const label = labelOrRefuse(input.name);
      const renamed = await database.withOwner(principal.owner, (tx) =>
        tx
          .update(schema.passkey)
          .set({ name: label })
          .where(eq(schema.passkey.credentialId, input.id))
          .returning({ credentialId: schema.passkey.credentialId }),
      );
      if (renamed.length === 0) throw new ApiError('not-found', 'No such passkey.');
      return {};
    },

    'client.passkeys.remove': async ({ input, principal }) => {
      await database.withOwner(principal.owner, async (tx) => {
        const [board] = await tx
          .select({ source: schema.appUser.source })
          .from(schema.appUser)
          .for('update');
        const owned = await tx.select({ id: schema.passkey.credentialId }).from(schema.passkey);
        if (!owned.some((row) => row.id === input.id))
          throw new ApiError('not-found', 'No such passkey.');
        if (board?.source === 'passkey' && owned.length <= 1)
          throw new ApiError('conflict', LAST_PASSKEY);
        await tx.delete(schema.passkey).where(eq(schema.passkey.credentialId, input.id));
      });
      return {};
    },
  };
};
