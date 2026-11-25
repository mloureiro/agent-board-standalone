import { parseServerVersion } from '../servers/index.js';
import { prepareSigningKey, type PendingSigningKey } from '../signing/index.js';
import type { ServerClient } from '../transport/client.js';

export const signingKeyIf = (
  required: boolean,
  client: ServerClient,
  serverId: string,
): Promise<PendingSigningKey | null> =>
  required && client.transport.kind !== 'native'
    ? prepareSigningKey(serverId)
    : Promise.resolve(null);

export const signingKeyForSignIn = async (
  client: ServerClient,
  serverId: string,
): Promise<PendingSigningKey | null> => {
  const answer = await client.request('/api/version').catch(() => null);
  if (answer === null || !answer.ok) return null;
  const version = parseServerVersion(await answer.json().catch(() => null));
  return signingKeyIf(version?.requestSignature === true, client, serverId);
};
