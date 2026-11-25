import type { Runtime } from '../runtime.js';
import { loadCredentials } from '../profile/credentials.js';
import { readServerFile } from '../profile/files.js';
import type { ProfileDirs } from '../profile/paths.js';
import { loadSigner } from '../profile/signing-key.js';
import { httpDeps, machineCaller } from './session.js';

export interface Revocation {
  readonly revoked: boolean;
  readonly message: string;
}

export async function revokeOwnToken(rt: Runtime, dirs: ProfileDirs): Promise<Revocation> {
  try {
    const server = readServerFile(dirs.config);
    if (server === null) {
      return { revoked: false, message: 'no server is configured, so there is no token to revoke' };
    }
    const credentials = await loadCredentials(rt, dirs);
    const signer = await loadSigner(dirs.config);
    await machineCaller(httpDeps(rt, server.url), credentials.token, signer)('revoke-token', {});
    return { revoked: true, message: `revoked the machine token on ${server.url}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      revoked: false,
      message: `revoking the machine token failed (${reason}); revoke it in the board's machine list`,
    };
  }
}
