import { eq } from 'drizzle-orm';

import {
  clearedSessionCookie,
  DAY_MS,
  endSession,
  issueSession,
  newPairingCode,
  readCredential,
  readFlow,
  sessionCookie,
  startFlow,
  takeFlow,
  updateFlow,
  verifierMatches,
  type SessionDeps,
  type SessionMethod,
} from '../auth/index.js';
import * as schema from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';
import { DEFAULT_SESSION_DAYS } from '../modules/sign-in/index.js';
import type { ServerContext } from '../context.js';

export const OIDC_LABEL = 'OpenID Connect';
export const SAML_LABEL = 'SAML';

const SIGN_IN_FAILED = 'sign-in failed';

export const sessionDepsOf = (context: ServerContext): SessionDeps => ({
  database: context.services.database,
  clock: context.clock,
  sessionDays:
    context.config.signIn.mode === 'login'
      ? context.config.signIn.sessionDays
      : DEFAULT_SESSION_DAYS,
});

const handoffData = (data: Record<string, unknown>): { code: string; method: SessionMethod } => ({
  code: String(data.code),
  method: data.method as SessionMethod,
});

export const signInHandlers: HandlerSet = (context) => ({
  'client.me': async ({ principal }) => {
    const rows = await context.services.database.withOwner(principal.owner, (tx) =>
      tx
        .select({ keyId: schema.appUser.keyId })
        .from(schema.appUser)
        .where(eq(schema.appUser.username, principal.owner)),
    );
    return { username: principal.owner, keyId: rows[0]?.keyId ?? null };
  },

  'auth.config': () => {
    const { signIn } = context.config;
    if (signIn.mode === 'no-login') return { login: false };
    return {
      login: true,
      passkeys: signIn.passkeys,
      signup: signIn.signupToken !== null,
      oidc: signIn.oidc ? { label: OIDC_LABEL } : null,
      saml: signIn.saml ? { label: SAML_LABEL } : null,
    };
  },

  'auth.logout': async ({ request, reply }) => {
    const { signIn } = context.config;
    if (signIn.mode === 'no-login') return {};
    const credential = await readCredential(request, signIn.scheme);
    if (credential !== null && credential.kind !== 'machine' && request.principal !== null)
      await endSession(sessionDepsOf(context), request.principal.owner, credential.hash);
    reply.header('set-cookie', clearedSessionCookie(signIn.scheme));
    return {};
  },

  'auth.handoff.start': async ({ input }) => {
    const code = newPairingCode();
    const started = await startFlow(context, {
      kind: 'handoff',
      challenge: input.challenge,
      data: { code },
      code,
    });
    return { flow: started.id, code };
  },

  'auth.handoff.describe': async ({ input }) => {
    const flow = await readFlow(context, input.flow, 'handoff');
    if (flow === null)
      throw new ApiError('not-found', 'this sign-in code is unknown or has expired');
    return { code: handoffData(flow.data).code };
  },

  'auth.handoff.approve': async ({ input, principal, request }) => {
    const flow = await readFlow(context, input.flow, 'handoff');
    if (flow === null)
      throw new ApiError('not-found', 'this sign-in code is unknown or has expired');
    if (flow.owner !== null)
      throw new ApiError('forbidden', 'this sign-in code is already approved');
    const { signIn } = context.config;
    const credential =
      signIn.mode === 'login' ? await readCredential(request, signIn.scheme) : null;
    const stored =
      credential === null
        ? null
        : await context.services.database.withSystem((system) =>
            system.lookupSession(credential.hash),
          );
    if (stored === null) throw new ApiError('forbidden', 'sign in to approve this code');
    const changed = await updateFlow(context, input.flow, principal.owner, {
      ...flow.data,
      method: stored.method,
    });
    if (!changed) throw new ApiError('not-found', 'this sign-in code is unknown or has expired');
    return { ok: true };
  },

  'auth.handoff.finish': async ({ input, reply }) => {
    const { signIn } = context.config;
    if (signIn.mode !== 'login') throw new ApiError('not-found', 'This board runs without login.');
    const flow = await readFlow(context, input.flow, 'handoff');
    if (flow === null || !verifierMatches(flow, input.verifier))
      throw new ApiError('forbidden', SIGN_IN_FAILED);
    if (flow.owner === null) return { status: 'pending' };
    const taken = await takeFlow(context, input.flow, 'handoff');
    if (taken === null || taken.owner === null) throw new ApiError('forbidden', SIGN_IN_FAILED);
    const deps = sessionDepsOf(context);
    const client = input.tokenKind === 'client';
    const issued = await issueSession(
      deps,
      taken.owner,
      client ? 'client' : 'cookie',
      handoffData(taken.data).method,
    );
    if (client) return { status: 'signed-in', token: issued.token };
    reply.header(
      'set-cookie',
      sessionCookie(signIn.scheme, issued.token, deps.sessionDays * (DAY_MS / 1000)),
    );
    return { status: 'signed-in' };
  },
});
