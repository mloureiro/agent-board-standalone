import { checkServerAddress } from '@agent-board/contract';

import {
  ADDRESS_PROBLEM_MESSAGES,
  checkConnection,
  describeConnection,
  reachesHttpFromHttps,
  type TransportContext,
} from '../servers/index.js';
import { crossOriginTransport, sameOriginTransport } from '../transport/index.js';

export const TEST_UNAVAILABLE_MESSAGE =
  'Testing an address is not available in this app. Add the server and open it to check it.';

export type TestOutcome =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'reported'; readonly message: string };

export async function testAddress(
  address: string,
  context: TransportContext,
): Promise<TestOutcome> {
  const checked = checkServerAddress(address);
  if (!checked.ok) return { kind: 'invalid', message: ADDRESS_PROBLEM_MESSAGES[checked.problem] };
  if (context.bridge !== null) return { kind: 'reported', message: TEST_UNAVAILABLE_MESSAGE };
  const same = new URL(checked.url).origin === context.pageOrigin;
  const transport = same
    ? sameOriginTransport()
    : crossOriginTransport({ baseUrl: checked.url, token: async () => null });
  const state = await checkConnection({ transport, hasBoundKey: async () => false });
  return {
    kind: 'reported',
    message: describeConnection(state, {
      blockedLoopback: reachesHttpFromHttps(context.pageOrigin, checked.url),
    }),
  };
}
