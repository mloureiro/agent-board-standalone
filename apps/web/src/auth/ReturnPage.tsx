import { authOidcFinishRoute, authSamlFinishRoute } from '@rumo/contract';
import { Loader, Stack, Text, Title } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { usePageTitle } from '../components/page-title.js';
import { useServers } from '../servers/index.js';
import { clearPending, readPending, type PendingSignIn } from '../session/pending.js';
import { useSession } from '../session/SessionProvider.js';
import { callRoute } from './api.js';
import { messageOf } from './messages.js';
import { signingKeyForSignIn } from './sign-in-key.js';

export const OIDC_RETURN_PATH = '/auth/callback';
export const SAML_RETURN_PATH = '/auth/saml';
export const NOT_STARTED_HERE = 'This sign-in was not started in this tab. Start it again.';

export function ReturnPage({ kind }: { readonly kind: PendingSignIn['kind'] }): ReactNode {
  const { ready, clientOf } = useServers();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const started = useRef(false);
  usePageTitle('Signing in');

  const client = (() => {
    const pending = readPending(kind);
    return pending === null ? null : clientOf(pending.serverId);
  })();

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const params = new URLSearchParams(location.search);
    const pending = readPending(kind);
    const providerError = params.get('error_description') ?? params.get('error');
    const back = (message: string): void => {
      clearPending();
      void navigate(pending?.returnTo ?? '/', { replace: true, state: { signInError: message } });
    };
    if (providerError !== null) return back(providerError);
    if (pending === null || client === null) return back(NOT_STARTED_HERE);
    const finish = signingKeyForSignIn(client, pending.serverId).then(async (key) => {
      const publicKey = key === null ? {} : { publicKey: key.publicKey };
      if (kind === 'oidc') {
        await callRoute(client, authOidcFinishRoute, {
          code: params.get('code') ?? '',
          state: params.get('state') ?? '',
          verifier: pending.verifier,
          ...(params.get('iss') === null ? {} : { iss: params.get('iss') as string }),
          ...publicKey,
        });
      } else {
        await callRoute(client, authSamlFinishRoute, {
          flow: params.get('flow') ?? '',
          verifier: pending.verifier,
          ...publicKey,
        });
      }
      await key?.commit();
    });
    finish.then(
      () => {
        clearPending();
        session.signedIn(pending.serverId);
        void navigate(pending.returnTo, { replace: true });
      },
      (cause: unknown) => back(messageOf(cause)),
    );
  }, [ready, client, kind, location.search, navigate, session]);

  return (
    <Stack align="center" p="xl" role="status" aria-label="Signing in">
      <Title order={1}>Signing in</Title>
      <Loader />
      <Text c="dimmed">Finishing the sign-in.</Text>
    </Stack>
  );
}
