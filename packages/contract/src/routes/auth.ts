import { z } from 'zod';

import { SAML_FORM_BODY_LIMIT } from '../limits.js';
import { emptyResult } from '../schemas/common.js';
import {
  authConfig,
  handoffDescribed,
  handoffFinish,
  handoffFinished,
  handoffFlow,
  handoffStarted,
  oidcFinish,
  passkeySignupRequest,
  redirectStart,
  redirectStarted,
  samlAcsForm,
  samlFinish,
  signedIn,
  signupName,
} from '../schemas/auth.js';
import {
  passkeyFlow,
  uiAuthenticationResponse,
  uiPasskeyCreationOptions,
} from '../schemas/passkey.js';
import { uiPasskeyRequestOptions, uiRegistrationResponse } from '../schemas/passkey.js';
import { publicKeyString } from '../schemas/ids.js';
import { defineRoute } from './route.js';

const none = z.object({}).strict();

export const authConfigRoute = defineRoute({
  name: 'auth.config',
  method: 'GET',
  path: '/api/auth/config',
  auth: 'public',
  request: none,
  response: authConfig,
  errors: [],
});

export const authLogoutRoute = defineRoute({
  name: 'auth.logout',
  method: 'POST',
  path: '/api/auth/logout',
  auth: 'client',
  request: none,
  response: emptyResult,
  errors: [],
});

export const authOidcStartRoute = defineRoute({
  name: 'auth.oidc.start',
  method: 'POST',
  path: '/api/auth/oidc/start',
  auth: 'public',
  request: redirectStart,
  response: redirectStarted,
  errors: ['not-enabled', 'too-many-requests'],
});

export const authOidcFinishRoute = defineRoute({
  name: 'auth.oidc.finish',
  method: 'POST',
  path: '/api/auth/oidc/finish',
  auth: 'public',
  request: oidcFinish,
  response: signedIn,
  errors: ['not-enabled', 'forbidden', 'too-many-requests'],
  issuesCredential: true,
});

export const authSamlStartRoute = defineRoute({
  name: 'auth.saml.start',
  method: 'POST',
  path: '/api/auth/saml/start',
  auth: 'public',
  request: redirectStart,
  response: redirectStarted,
  errors: ['not-enabled', 'too-many-requests'],
});

export const authSamlFinishRoute = defineRoute({
  name: 'auth.saml.finish',
  method: 'POST',
  path: '/api/auth/saml/finish',
  auth: 'public',
  request: samlFinish,
  response: signedIn,
  errors: ['not-enabled', 'forbidden', 'too-many-requests'],
  issuesCredential: true,
});

export const authSamlAcsRoute = defineRoute({
  name: 'auth.saml.acs',
  method: 'POST',
  path: '/api/auth/saml/acs',
  auth: 'public',
  request: samlAcsForm,
  response: z.never(),
  errors: ['not-enabled', 'too-many-requests'],
  bodyType: 'form',
  bodyLimit: SAML_FORM_BODY_LIMIT,
});

export const authPasskeyLoginOptionsRoute = defineRoute({
  name: 'auth.passkey.login-options',
  method: 'POST',
  path: '/api/auth/passkey/login-options',
  auth: 'public',
  request: none,
  response: z.object({ options: uiPasskeyRequestOptions, flow: passkeyFlow }).strict(),
  errors: ['not-enabled', 'too-many-requests'],
});

export const authPasskeyLoginRoute = defineRoute({
  name: 'auth.passkey.login',
  method: 'POST',
  path: '/api/auth/passkey/login',
  auth: 'public',
  request: z
    .object({
      flow: passkeyFlow,
      response: uiAuthenticationResponse,
      publicKey: publicKeyString.optional(),
    })
    .strict(),
  response: signedIn,
  errors: ['not-enabled', 'forbidden', 'too-many-requests'],
  issuesCredential: true,
});

export const authPasskeySignupOptionsRoute = defineRoute({
  name: 'auth.passkey.signup-options',
  method: 'POST',
  path: '/api/auth/passkey/signup-options',
  auth: 'public',
  request: passkeySignupRequest,
  response: z.object({ options: uiPasskeyCreationOptions, flow: passkeyFlow }).strict(),
  errors: ['not-enabled', 'forbidden', 'too-many-requests'],
});

export const authPasskeySignupRoute = defineRoute({
  name: 'auth.passkey.signup',
  method: 'POST',
  path: '/api/auth/passkey/signup',
  auth: 'public',
  request: z
    .object({
      flow: passkeyFlow,
      response: uiRegistrationResponse,
      name: signupName.optional(),
      publicKey: publicKeyString.optional(),
    })
    .strict(),
  response: signedIn,
  errors: ['not-enabled', 'forbidden', 'too-many-requests'],
  issuesCredential: true,
});

export const authHandoffStartRoute = defineRoute({
  name: 'auth.handoff.start',
  method: 'POST',
  path: '/api/auth/handoff/start',
  auth: 'public',
  request: redirectStart,
  response: handoffStarted,
  errors: ['not-enabled', 'too-many-requests'],
});

export const authHandoffDescribeRoute = defineRoute({
  name: 'auth.handoff.describe',
  method: 'GET',
  path: '/api/auth/handoff/describe',
  auth: 'client',
  request: handoffFlow,
  response: handoffDescribed,
  errors: ['not-found'],
});

export const authHandoffApproveRoute = defineRoute({
  name: 'auth.handoff.approve',
  method: 'POST',
  path: '/api/auth/handoff/approve',
  auth: 'client',
  request: handoffFlow,
  response: signedIn,
  errors: ['forbidden', 'not-found'],
  issuesCredential: true,
});

export const authHandoffFinishRoute = defineRoute({
  name: 'auth.handoff.finish',
  method: 'POST',
  path: '/api/auth/handoff/finish',
  auth: 'public',
  request: handoffFinish,
  response: handoffFinished,
  errors: ['not-enabled', 'forbidden', 'too-many-requests'],
  issuesCredential: true,
});

export const authRouteList = [
  authConfigRoute,
  authLogoutRoute,
  authOidcStartRoute,
  authOidcFinishRoute,
  authSamlStartRoute,
  authSamlFinishRoute,
  authSamlAcsRoute,
  authPasskeyLoginOptionsRoute,
  authPasskeyLoginRoute,
  authPasskeySignupOptionsRoute,
  authPasskeySignupRoute,
  authHandoffStartRoute,
  authHandoffDescribeRoute,
  authHandoffApproveRoute,
  authHandoffFinishRoute,
] as const;
