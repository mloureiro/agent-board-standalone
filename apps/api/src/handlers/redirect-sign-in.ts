import {
  acceptSamlResponse,
  authorizationUrl,
  claimUsername,
  DAY_MS,
  finishOidc,
  isAccepted,
  issueSession,
  keepUpkeep,
  newOidcChecks,
  readFlow,
  SAML_RETURN_PATH,
  samlAuthorizeUrl,
  sessionCookie,
  startFlow,
  takeFlow,
  verifierMatches,
  type OidcDeps,
} from '../auth/index.js';
import type { ServerContext } from '../context.js';
import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';
import type { LoginConfig } from '../modules/sign-in/index.js';
import { sessionDepsOf } from './sign-in.js';

const SIGN_IN_FAILED = 'sign-in failed';
const SAML_REFUSED = 'The identity provider refused this sign-in.';
const SAML_NO_USERNAME = 'The identity provider sent no usable user name.';

const loginOf = (context: ServerContext): LoginConfig => {
  const { signIn } = context.config;
  if (signIn.mode !== 'login') throw new ApiError('not-found', 'This board runs without login.');
  return signIn;
};

const oidcOf = (context: ServerContext): OidcDeps => {
  const signIn = loginOf(context);
  if (signIn.oidc === null)
    throw new ApiError('not-enabled', 'OpenID Connect sign-in is not set up');
  return {
    database: context.services.database,
    clock: context.clock,
    publicUrl: signIn.publicUrl,
    settings: signIn.oidc,
    allowedGroups: signIn.allowedGroups,
  };
};

const samlOf = (context: ServerContext) => {
  const signIn = loginOf(context);
  if (signIn.saml === null) throw new ApiError('not-enabled', 'SAML sign-in is not set up');
  return { settings: signIn.saml, publicUrl: signIn.publicUrl };
};

export const redirectSignInHandlers: HandlerSet = (context) => ({
  'auth.oidc.start': async ({ input }) => {
    const deps = oidcOf(context);
    const checks = newOidcChecks();
    try {
      const started = await startFlow(context, {
        kind: 'oidc',
        challenge: input.challenge,
        data: { ...checks },
      });
      return { url: await authorizationUrl(deps, started.id, checks) };
    } catch {
      throw new ApiError('unavailable', 'the identity provider could not be reached');
    }
  },

  'auth.oidc.finish': async ({ input, reply }) => {
    const deps = oidcOf(context);
    const signIn = loginOf(context);
    const flow = await readFlow(context, input.state, 'oidc');
    if (flow === null || !verifierMatches(flow, input.verifier))
      throw new ApiError('forbidden', SIGN_IN_FAILED);
    const taken = await takeFlow(context, input.state, 'oidc');
    if (taken === null) throw new ApiError('forbidden', SIGN_IN_FAILED);
    const identity = await finishOidc(deps, taken.data, input).catch((error: unknown) => {
      throw error instanceof ApiError ? error : new ApiError('forbidden', SIGN_IN_FAILED);
    });
    await claimUsername(deps.database, identity.username, 'oidc');
    const sessionDeps = sessionDepsOf(context);
    const issued = await issueSession(sessionDeps, identity.username, 'cookie', 'oidc');
    if (identity.upkeep !== null)
      await keepUpkeep(deps.database, deps.clock, identity.username, issued.token, identity.upkeep);
    reply.header(
      'set-cookie',
      sessionCookie(signIn.scheme, issued.token, sessionDeps.sessionDays * (DAY_MS / 1000)),
    );
    return { ok: true };
  },

  'auth.saml.start': async ({ input }) => {
    const { settings, publicUrl } = samlOf(context);
    try {
      const started = await startFlow(context, {
        kind: 'saml',
        challenge: input.challenge,
      });
      return { url: await samlAuthorizeUrl(context, settings, publicUrl, started.id) };
    } catch {
      throw new ApiError('unavailable', 'the identity provider could not be reached');
    }
  },

  'auth.saml.finish': async ({ input, reply }) => {
    samlOf(context);
    const signIn = loginOf(context);
    const flow = await readFlow(context, input.flow, 'saml');
    if (flow === null || !isAccepted(flow) || !verifierMatches(flow, input.verifier))
      throw new ApiError('forbidden', SIGN_IN_FAILED);
    const taken = await takeFlow(context, input.flow, 'saml');
    if (taken === null || !isAccepted(taken)) throw new ApiError('forbidden', SIGN_IN_FAILED);
    const username = String(taken.data.username);
    await claimUsername(context.services.database, username, 'saml');
    const sessionDeps = sessionDepsOf(context);
    const issued = await issueSession(sessionDeps, username, 'cookie', 'saml');
    reply.header(
      'set-cookie',
      sessionCookie(signIn.scheme, issued.token, sessionDeps.sessionDays * (DAY_MS / 1000)),
    );
    return { ok: true };
  },

  'auth.saml.acs': async ({ input, reply }) => {
    const { settings, publicUrl } = samlOf(context);
    const outcome = await acceptSamlResponse(context, settings, publicUrl, input.SAMLResponse);
    const back = (query: string): never =>
      reply
        .code(303)
        .header('location', `${publicUrl}${SAML_RETURN_PATH}?${query}`)
        .send() as never;
    if ('error' in outcome)
      return back(
        `error=${encodeURIComponent(outcome.error === 'refused' ? SAML_REFUSED : SAML_NO_USERNAME)}`,
      );
    const { flow, username } = outcome;
    await context.services.database.withSystem((system) =>
      system.createAuthFlow({
        id: flow.id,
        kind: 'saml',
        challenge: flow.challenge,
        data: { username },
        expiresAt: flow.expiresAt,
      }),
    );
    return back(`flow=${encodeURIComponent(flow.id)}`);
  },
});
