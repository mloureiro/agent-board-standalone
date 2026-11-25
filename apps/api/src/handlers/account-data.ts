import { ApiError } from '../errors.js';
import type { HandlerSet } from '../http/handler.js';
import { exportPage, importRows, userKeyId } from '../modules/board-export/index.js';

export const accountDataHandlers: HandlerSet = ({ services }) => ({
  'client.account.export': ({ input, principal }) =>
    services.database.withOwner(principal.owner, (tx) =>
      exportPage(tx, principal.owner, input.table, input.cursor),
    ),
  'client.account.import': ({ input, principal }) =>
    services.database.withOwner(principal.owner, async (tx) => {
      const stored = await userKeyId(tx, principal.owner);
      if (stored === null || stored !== input.keyId)
        throw new ApiError('forbidden', 'rows import only under the key id this account holds');
      return importRows(tx, principal.owner, input.table, input.rows);
    }),
});
