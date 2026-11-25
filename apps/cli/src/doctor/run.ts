import type { DoctorResult } from '@agent-board/contract';

import type { Context } from '../commands/context.js';
import { configChecks } from './config.js';
import {
  backupCheck,
  credentialChecks,
  folderChecks,
  gitCheck,
  loadedCredentialChecks,
  profileChecks,
  serverFileCheck,
} from './local.js';
import { autoUpdateCheck, migrationCheck } from './operations.js';
import { replacedAgentsCheck, serverChecks } from './server.js';
import { unitChecks } from './units.js';

export async function runChecks(ctx: Context): Promise<DoctorResult[]> {
  const loaded = await loadedCredentialChecks(ctx);
  return [
    ...profileChecks(ctx),
    serverFileCheck(ctx),
    ...credentialChecks(ctx),
    ...loaded.results,
    ...(await serverChecks(ctx, loaded.loaded)),
    replacedAgentsCheck(ctx),
    ...(await configChecks(ctx)),
    ...folderChecks(ctx),
    backupCheck(ctx),
    migrationCheck(ctx),
    autoUpdateCheck(ctx),
    await gitCheck(ctx),
    ...(await unitChecks(ctx)),
  ];
}
