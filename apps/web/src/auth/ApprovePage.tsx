import { authHandoffApproveRoute, authHandoffDescribeRoute } from '@rumo/contract';
import { Alert, Button, Code, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { ServerStatePanel, panelFor } from '../components/ServerStatePanel.js';
import { usePageTitle } from '../components/page-title.js';
import { useServers } from '../servers/index.js';
import { callRoute } from './api.js';
import { messageOf } from './messages.js';
import { SignInPage } from './SignInPage.js';

export function ApprovePage(): ReactNode {
  const { active, connectionOf, clientOf } = useServers();
  const [params] = useSearchParams();
  const code = params.get('code');
  const flow = params.get('flow') ?? code;
  const [approved, setApproved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  usePageTitle('Approve sign-in');

  const view = active === null ? null : connectionOf(active.id);
  const client = active === null ? null : clientOf(active.id);
  const signedIn = view?.state === 'up';

  const described = useQuery({
    queryKey: ['handoff-describe', active?.id, flow],
    queryFn: () =>
      callRoute(client as NonNullable<typeof client>, authHandoffDescribeRoute, {
        flow: flow as string,
      }),
    enabled: signedIn && client !== null && flow !== null && params.get('flow') !== null,
  });
  const shownCode = params.get('flow') === null ? code : (described.data?.code ?? null);

  if (active === null || view === null || view.state === 'checking') {
    return <Text p="md">Checking the server.</Text>;
  }
  const panel = panelFor(view);
  if (panel !== null) return <ServerStatePanel content={panel} />;

  if (code === null || flow === null) {
    return (
      <Stack p="md" maw={420} mx="auto">
        <Title order={1}>Approve sign-in</Title>
        <Alert color="red" role="alert">
          This link has no code. Start the sign-in again.
        </Alert>
      </Stack>
    );
  }

  if (view.state === 'signed-out') {
    return (
      <SignInPage
        server={active}
        allowHandoff={false}
        intro={
          <Text>
            Sign in here to approve the code <Code>{code}</Code> for another browser.
          </Text>
        }
      />
    );
  }

  const approve = async (): Promise<void> => {
    if (client === null) return;
    setFailure(null);
    try {
      await callRoute(client, authHandoffApproveRoute, { flow });
      setApproved(true);
    } catch (cause) {
      setFailure(messageOf(cause));
    }
  };

  return (
    <Stack p="md" maw={420} mx="auto" role="region" aria-label="Approve sign-in">
      <Title order={1}>Approve sign-in</Title>
      {approved ? (
        <Text role="status">Approved. The other browser is now signed in.</Text>
      ) : (
        <>
          <Text>
            Another browser asks to sign in to {active.name}. Approve only if it shows this code.
          </Text>
          {shownCode === null ? null : (
            <Code fz="xl" fw={700}>
              {shownCode}
            </Code>
          )}
          {described.isError ? (
            <Alert color="red" role="alert">
              {messageOf(described.error)}
            </Alert>
          ) : null}
          {failure === null ? null : (
            <Alert color="red" role="alert">
              {failure}
            </Alert>
          )}
          <Button disabled={shownCode === null} onClick={() => void approve()}>
            Approve
          </Button>
        </>
      )}
    </Stack>
  );
}
