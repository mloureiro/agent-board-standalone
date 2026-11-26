import { eq } from 'drizzle-orm';

import { machine } from '../db/schema/index.js';
import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';
import {
  accountSummary,
  deleteAccount,
  exportPage,
  importRows,
  userKeyId,
} from '../modules/board-export/index.js';
import { announceRevoked, announceTaskChange } from '../modules/events/index.js';

export const accountDataHandlers: HandlerSet = ({ services }) => ({
  'client.account.summary': ({ principal }) =>
    services.database.withOwner(principal.owner, (tx) => accountSummary(tx, principal.owner)),
  'client.account.delete': async ({ input, principal }) => {
    if (input.username !== principal.owner)
      throw new ApiError('forbidden', 'type the signed-in username to delete the account');
    const machines = await services.database.withOwner(principal.owner, async (tx) => {
      const held = await tx
        .select({ id: machine.id })
        .from(machine)
        .where(eq(machine.owner, principal.owner));
      await deleteAccount(tx, principal.owner);
      return held;
    });
    for (const { id } of machines) await announceRevoked(services.events, principal.owner, id);
    return {};
  },
  'client.account.export': ({ input, principal }) =>
    services.database.withOwner(principal.owner, (tx) =>
      exportPage(tx, principal.owner, input.table, input.cursor),
    ),
  'client.account.import': async ({ input, principal }) => {
    const imported = await services.database.withOwner(principal.owner, async (tx) => {
      const stored = await userKeyId(tx, principal.owner);
      if (stored === null || stored !== input.keyId)
        throw new ApiError('forbidden', 'rows import only under the key id this account holds');
      return importRows(tx, principal.owner, input.table, input.rows);
    });
    await announceTaskChange(services.events, principal.owner);
    return imported;
  },
});
