import { decodeDataKey, deriveKeys } from '@rumo/sealing';

import { CliError } from '../errors.js';
import { assertCompatible } from './compatibility.js';
import { parseMachineVersion, type ServerInfo } from './server-info.js';

export type MachineCaller = (command: string, body: unknown) => Promise<unknown>;

export async function assertKeyIdMatches(server: ServerInfo, dataKey: string): Promise<void> {
  if (server.owner === null || server.keyId === null) {
    throw new CliError(
      'the server has no key set up for this board yet: unlock it once in the browser client first',
    );
  }
  const derived = (await deriveKeys(decodeDataKey(dataKey), server.owner)).keyId;
  if (derived !== server.keyId) {
    throw new CliError(
      `the data key's key id ${derived} does not match the server's key id ${server.keyId}: this is not the data key of that board`,
    );
  }
}

export async function handshake(call: MachineCaller, dataKey: string): Promise<ServerInfo> {
  const info = parseMachineVersion(await call('version', {}));
  assertCompatible(info);
  await assertKeyIdMatches(info, dataKey);
  return info;
}
