import type { HandlerSet } from '../http/handler.js';
import { announceChange, announceTaskChange } from '../modules/events/index.js';
import { convertLegacyDirs, getLegacyDirs, setDirs } from '../modules/machine-directories/index.js';

export const legacyDirsHandlers: HandlerSet = ({ services }) => ({
  'machine.set-dirs': async ({ input, principal }) => {
    const directories = await services.database.withOwner(principal.owner, (tx) =>
      setDirs(tx, principal.owner, principal.machineId, input.directories),
    );
    await announceChange(services.events, principal.owner);
    return { directories };
  },
  'machine.get-legacy-dirs': ({ principal }) =>
    services.database.withOwner(principal.owner, (tx) =>
      getLegacyDirs(tx, principal.owner, principal.machineId),
    ),
  'machine.convert-legacy-dirs': async ({ input, principal }) => {
    const converted = await services.database.withOwner(principal.owner, (tx) =>
      convertLegacyDirs(tx, principal.owner, principal.machineId, input),
    );
    await announceTaskChange(services.events, principal.owner);
    return converted;
  },
});
