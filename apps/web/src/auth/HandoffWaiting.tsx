import { authHandoffFinishRoute } from '@agent-board/contract';
import { Anchor, Code, Stack, Text } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';

import { CLIENT_TOKEN_NAME, type ServerEntry } from '../servers/index.js';
import { serverNamespace } from '../storage/index.js';
import { ApiError } from '../session/api-error.js';
import type { ServerClient } from '../transport/client.js';
import { callRoute } from './api.js';
import { signingKeyIf } from './sign-in-key.js';
import type { PendingSigningKey } from '../signing/index.js';
import type { AgentBoardBridge } from '../bridge/types.js';

export const HANDOFF_POLL_MS = 2_000;
export const HANDOFF_EXPIRY_MS = 10 * 60_000;

export interface StartedHandoff {
  readonly flow: string;
  readonly code: string;
  readonly verifier: string;
  readonly link: string;
  readonly startedAt: number;
}

export type HandoffChannel =
  | { readonly kind: 'native'; readonly bridge: AgentBoardBridge }
  | { readonly kind: 'same-origin' | 'cross-origin'; readonly client: ServerClient };

export const HANDOFF_EXPIRED = 'This sign-in expired or was refused. Start again.';

const isFatal = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;

async function finishOnce(
  channel: HandoffChannel,
  server: ServerEntry,
  handoff: StartedHandoff,
  signingKey: () => Promise<PendingSigningKey | null>,
): Promise<boolean> {
  if (channel.kind === 'native') {
    try {
      await channel.bridge.handoffFinish(server.id, handoff.flow, handoff.verifier);
      return true;
    } catch {
      return false;
    }
  }
  const crossOrigin = channel.kind === 'cross-origin';
  const key = await signingKey();
  const answer = await callRoute(channel.client, authHandoffFinishRoute, {
    flow: handoff.flow,
    verifier: handoff.verifier,
    ...(crossOrigin ? { tokenKind: 'client' as const } : {}),
    ...(key === null ? {} : { publicKey: key.publicKey }),
  });
  if (answer.status === 'pending') return false;
  await key?.commit();
  if (crossOrigin) {
    if (answer.token === undefined) throw new ApiError(0, null, HANDOFF_EXPIRED);
    await serverNamespace(server.id).secrets.put(CLIENT_TOKEN_NAME, answer.token);
  }
  return true;
}

export function HandoffWaiting(props: {
  readonly server: ServerEntry;
  readonly channel: HandoffChannel;
  readonly handoff: StartedHandoff;
  readonly requestSignature: boolean;
  readonly onSignedIn: () => void;
  readonly onFailed: (message: string) => void;
}): ReactNode {
  const { handoff } = props;
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let pendingKey: Promise<PendingSigningKey | null> | null = null;
    const signingKey = (): Promise<PendingSigningKey | null> => {
      const { channel, server } = latest.current;
      if (channel.kind === 'native') return Promise.resolve(null);
      pendingKey ??= signingKeyIf(latest.current.requestSignature, channel.client, server.id);
      return pendingKey;
    };
    const poll = async (): Promise<void> => {
      if (stopped || inFlight) return;
      if (Date.now() - handoff.startedAt > HANDOFF_EXPIRY_MS) {
        stopped = true;
        latest.current.onFailed(HANDOFF_EXPIRED);
        return;
      }
      inFlight = true;
      try {
        if (await finishOnce(latest.current.channel, latest.current.server, handoff, signingKey)) {
          stopped = true;
          latest.current.onSignedIn();
        }
      } catch (error) {
        if (isFatal(error)) {
          stopped = true;
          latest.current.onFailed(HANDOFF_EXPIRED);
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), HANDOFF_POLL_MS);
    const onFocus = (): void => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [handoff]);

  return (
    <Stack gap="xs" role="status" aria-label="Waiting for approval">
      <Text>Open the link below in a browser where you are signed in and approve this code.</Text>
      <Code fz="xl" fw={700} style={{ letterSpacing: '0.1em' }}>
        {handoff.code}
      </Code>
      <Anchor href={handoff.link} target="_blank" rel="noopener noreferrer">
        Open the approval page
      </Anchor>
      <Text size="sm" c="dimmed">
        This page signs in as soon as the code is approved.
      </Text>
    </Stack>
  );
}
