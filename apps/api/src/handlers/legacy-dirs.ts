import type { HandlerSet } from '../http/handler.js';
import { convertLegacyDirs, getLegacyDirs, setDirs } from '../modules/machine-directories/index.js';

export const legacyDirsHandlers: HandlerSet = ({ services }) => ({
  'machine.set-dirs': async ({ input, principal }) => ({
    directories: await services.database.withOwner(principal.owner, (tx) =>
      setDirs(tx, principal.owner, principal.machineId, input.directories),
    ),
  }),
  'machine.get-legacy-dirs': ({ principal }) =>
    services.database.withOwner(principal.owner, (tx) =>
      getLegacyDirs(tx, principal.owner, principal.machineId),
    ),
  'machine.convert-legacy-dirs': ({ input, principal }) =>
    services.database.withOwner(principal.owner, (tx) =>
      convertLegacyDirs(tx, principal.owner, principal.machineId, input),
    ),
});
