import {
  getClientLinksRoute,
  getClientSettingsRoute,
  getClientTitleRulesRoute,
  setClientLinksRoute,
  setClientSettingsRoute,
  setClientTitleRulesRoute,
} from '@agent-board/contract';
import { bindings, open, seal } from '@agent-board/sealing';

import { ApiError } from '../session/index.js';
import type { Page } from './use-page.js';

export type DocumentName = 'settings' | 'links' | 'titles';

export interface LoadedDocument {
  readonly version: number;
  readonly text: string | null;
}

interface Stored {
  readonly document: string;
  readonly version: number;
}

interface Kind {
  readonly feature: string;
  readonly read: (page: Page) => Promise<Stored | null>;
  readonly write: (
    page: Page,
    body: { document: string; version: number; expectedVersion: number },
  ) => Promise<unknown>;
  readonly binding: typeof bindings.settings;
}

export const DOCUMENT_KINDS: Readonly<Record<DocumentName, Kind>> = {
  settings: {
    feature: 'settings-document',
    read: async (page) => (await page.call(getClientSettingsRoute, {})).document,
    write: (page, body) => page.call(setClientSettingsRoute, body),
    binding: bindings.settings,
  },
  links: {
    feature: 'link-rules',
    read: async (page) => (await page.call(getClientLinksRoute, {})).document,
    write: (page, body) => page.call(setClientLinksRoute, body),
    binding: bindings.links,
  },
  titles: {
    feature: 'title-rules',
    read: async (page) => (await page.call(getClientTitleRulesRoute, {})).document,
    write: (page, body) => page.call(setClientTitleRulesRoute, body),
    binding: bindings.titles,
  },
};

export const VERSION_CONFLICT = 'version-conflict';
export const isVersionConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.code === VERSION_CONFLICT;

export async function loadDocument(page: Page, name: DocumentName): Promise<LoadedDocument> {
  const kind = DOCUMENT_KINDS[name];
  const stored = await kind.read(page);
  if (stored === null) return { version: 0, text: null };
  try {
    return {
      version: stored.version,
      text: await open(page.keys, kind.binding(stored.version), stored.document),
    };
  } catch {
    return { version: stored.version, text: null };
  }
}

export async function saveDocument(
  page: Page,
  name: DocumentName,
  text: string,
  expectedVersion: number,
): Promise<void> {
  const kind = DOCUMENT_KINDS[name];
  const version = expectedVersion + 1;
  await kind.write(page, {
    document: await seal(page.keys, kind.binding(version), text),
    version,
    expectedVersion,
  });
}
