import {
  ACCOUNT_TABLES,
  BOARD_EXPORT_FORMAT,
  BOARD_EXPORT_VERSION,
  exportClientAccountRoute,
  getClientKeysRoute,
  type AccountTable,
} from '@rumo/contract';

import type { Page } from '../../pages/index.js';

const DOCUMENT_KINDS: Partial<Record<AccountTable, 'agents' | 'links' | 'titles' | 'settings'>> = {
  shared_agents: 'agents',
  link_rules: 'links',
  title_rules: 'titles',
  setting: 'settings',
};

export const EXPORT_FILE = 'rumo-export.ndjson';
export const EXPORT_MEDIA_TYPE = 'application/x-ndjson';

const recordOf = (owner: string, table: AccountTable, row: Record<string, unknown>) => {
  const kind = DOCUMENT_KINDS[table];
  return kind === undefined
    ? { owner, table, row }
    : { owner, table: 'document', row: { kind, ...row } };
};

export async function buildAccountExport(
  page: Page,
  owner: string,
  serverVersion: string,
  now: Date,
): Promise<string> {
  const { setup } = await page.call(getClientKeysRoute, {});
  const lines: unknown[] = [
    {
      format: BOARD_EXPORT_FORMAT,
      version: BOARD_EXPORT_VERSION,
      createdAt: now.toISOString(),
      source: { kind: 'api', version: serverVersion },
    },
    {
      owner,
      table: 'user',
      row: {
        createdAt: now.toISOString(),
        keyId: setup?.keyId ?? null,
        keySlots: setup?.slots ?? null,
        source: null,
      },
    },
  ];
  for (const table of ACCOUNT_TABLES) {
    let cursor: string | undefined;
    do {
      const answer = await page.call(exportClientAccountRoute, {
        table,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const row of answer.rows) lines.push(recordOf(owner, table, row));
      cursor = answer.next ?? undefined;
    } while (cursor !== undefined);
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
