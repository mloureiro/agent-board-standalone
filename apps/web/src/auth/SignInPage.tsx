import {
  authConfigRoute,
  authHandoffStartRoute,
  authOidcStartRoute,
  authPasskeyLoginOptionsRoute,
  authPasskeyLoginRoute,
  authSamlStartRoute,
} from '@agent-board/contract';
import { Alert, Button, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { usePageTitle } from '../components/page-title.js';
import { useServers, type ServerEntry } from '../servers/index.js';
import { useEnvironment } from '../session/environment.js';
import { savePending } from '../session/pending.js';
import { createPkce } from '../session/pkce.js';
import { useSession } from '../session/SessionProvider.js';
import { callRoute } from './api.js';
import { HandoffWaiting, type HandoffChannel, type StartedHandoff } from './HandoffWaiting.js';
import { messageOf } from './messages.js';
import { SignUpForm } from './SignUpForm.js';
import { getPasskey, webAuthnAvailable } from './webauthn.js';

export const HANDOFF_LABEL = 'Sign in with your browser';
export const PASSKEY_LABEL = 'Sign in with a passkey';
export const PASSKEY_UNAVAILABLE =
  'Passkeys need WebAuthn, which this browser does not provide. Use another method.';

export interface SignInPageProps {
  readonly server: ServerEntry;
  readonly signedOut?: boolean;
  readonly allowHandoff?: boolean;
  readonly intro?: ReactNode;
}

const approvalLink = (server: ServerEntry, started: { code: string; flow: string }): string => {
  const link = new URL('/approve', server.url);
  link.searchParams.set('code', started.code);
  link.searchParams.set('flow', started.flow);
  return link.href;
};

export function SignInPage(props: SignInPageProps): ReactNode {
  const { server, signedOut = false, allowHandoff = true, intro } = props;
  const servers = useServers();
  const session = useSession();
  const environment = useEnvironment();
  const location = useLocation();
  const routed = (location.state as { signInError?: string } | null)?.signInError ?? null;
  const [failure, setFailure] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<StartedHandoff | null>(null);
  const [signingUp, setSigningUp] = useState(false);
  usePageTitle(signedOut ? 'Signed out' : 'Sign in');

  const client = servers.clientOf(server.id);
  const bridge = servers.transportContext.bridge;
  const kind = servers.transportOf(server.id)?.kind ?? 'same-origin';

  const channel = useMemo<HandoffChannel | null>(() => {
    if (kind === 'native') return bridge === null ? null : { kind, bridge };
    return client === null ? null : { kind, client };
  }, [kind, bridge, client]);

  const config = useQuery({
    queryKey: ['auth-config', server.id],
    queryFn: () => callRoute(client as NonNullable<typeof client>, authConfigRoute, {}),
    enabled: client !== null && kind !== 'cross-origin',
  });

  const offered = config.data?.login === true ? config.data : null;
  const sameOrigin = kind === 'same-origin';
  const viaHandoff = kind === 'native';
  const webauthn = webAuthnAvailable();
  const error = failure ?? routed;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setFailure(null);
    try {
      await action();
    } catch (cause) {
      setFailure(messageOf(cause));
    }
  };

  const startHandoff = (): Promise<void> =>
    run(async () => {
      if (client === null) return;
      const pkce = await createPkce();
      const started = await callRoute(client, authHandoffStartRoute, {
        challenge: pkce.challenge,
      });
      const link = approvalLink(server, started);
      setHandoff({ ...started, verifier: pkce.verifier, link, startedAt: Date.now() });
      if (kind === 'native') await bridge?.openLink(link);
      else if (kind === 'cross-origin') environment.openWindow(link);
    });

  const startRedirect = (route: typeof authOidcStartRoute | typeof authSamlStartRoute) => {
    const type = route === authOidcStartRoute ? 'oidc' : 'saml';
    return run(async () => {
      if (client === null) return;
      const pkce = await createPkce();
      const started = await callRoute(client, route, { challenge: pkce.challenge });
      savePending({
        kind: type,
        serverId: server.id,
        verifier: pkce.verifier,
        returnTo: `${location.pathname}${location.search}`,
      });
      environment.assign(started.url);
    });
  };

  const signInWithPasskey = (): Promise<void> =>
    run(async () => {
      if (client === null) return;
      const started = await callRoute(client, authPasskeyLoginOptionsRoute, {});
      const response = await getPasskey(started.options);
      await callRoute(client, authPasskeyLoginRoute, { flow: started.flow, response });
      session.signedIn(server.id);
    });

  const methodAction = (own: () => Promise<void>): (() => void) =>
    viaHandoff ? () => void startHandoff() : () => void own();

  return (
    <Stack role="region" aria-label="Sign in" maw={420} mx="auto" p="md" gap="sm">
      <Title order={1}>{signedOut ? 'Signed out' : 'Sign in'}</Title>
      {signedOut ? <Text>Your session ended. Sign in to continue.</Text> : null}
      {intro}
      {error === null ? null : (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {config.isError ? <Text c="dimmed">The sign-in methods could not be loaded.</Text> : null}
      {offered?.passkeys === true && (sameOrigin || viaHandoff) ? (
        <>
          <Button
            variant="default"
            disabled={sameOrigin && !webauthn}
            aria-describedby={sameOrigin && !webauthn ? 'passkey-unavailable' : undefined}
            onClick={methodAction(signInWithPasskey)}
          >
            {PASSKEY_LABEL}
          </Button>
          {sameOrigin && !webauthn ? (
            <Text id="passkey-unavailable" size="sm" c="dimmed">
              {PASSKEY_UNAVAILABLE}
            </Text>
          ) : null}
        </>
      ) : null}
      {offered?.oidc != null && (sameOrigin || viaHandoff) ? (
        <Button variant="default" onClick={methodAction(() => startRedirect(authOidcStartRoute))}>
          {offered.oidc.label}
        </Button>
      ) : null}
      {offered?.saml != null && (sameOrigin || viaHandoff) ? (
        <Button variant="default" onClick={methodAction(() => startRedirect(authSamlStartRoute))}>
          {offered.saml.label}
        </Button>
      ) : null}
      {allowHandoff ? <Button onClick={() => void startHandoff()}>{HANDOFF_LABEL}</Button> : null}
      {handoff !== null && channel !== null ? (
        <HandoffWaiting
          server={server}
          channel={channel}
          handoff={handoff}
          onSignedIn={() => session.signedIn(server.id)}
          onFailed={(message) => {
            setHandoff(null);
            setFailure(message);
          }}
        />
      ) : null}
      {offered?.signup === true && offered.passkeys && sameOrigin && client !== null ? (
        signingUp ? (
          <SignUpForm client={client} onSignedIn={() => session.signedIn(server.id)} />
        ) : (
          <Button variant="subtle" onClick={() => setSigningUp(true)}>
            Create account
          </Button>
        )
      ) : null}
    </Stack>
  );
}
