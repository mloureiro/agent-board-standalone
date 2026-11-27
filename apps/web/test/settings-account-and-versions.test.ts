import { BOARD_EXPORT_FORMAT, BOARD_EXPORT_VERSION, parseBoardExportLine } from '@rumo/contract';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILD_COMMIT } from '../src/build-info.js';
import { PART_VERSION } from '../src/version.js';
import { OWNER_KEYS, frozenClock } from './board-world.js';
import { openTab, rowOf } from './page-helpers.js';
import { PagesWorld } from './pages-world.js';
import { renderApp, serverVersion } from './render.js';

let world: PagesWorld;

const render = (check = world.check) => {
  vi.stubGlobal('fetch', world.fetch);
  return renderApp({ path: '/settings', check, clock: frozenClock });
};

beforeEach(() => {
  world = new PagesWorld({ session: 'not-required' });
  world.features = ['board-export'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stubPasskeys = () => {
  const create = vi.fn(async () => ({
    id: 'new-credential',
    rawId: new Uint8Array([1, 2, 3]).buffer,
    type: 'public-key',
    response: {
      clientDataJSON: new Uint8Array([4]).buffer,
      attestationObject: new Uint8Array([5]).buffer,
    },
    getClientExtensionResults: () => ({}),
  }));
  vi.stubGlobal('PublicKeyCredential', class {});
  Object.defineProperty(navigator, 'credentials', { value: { create }, configurable: true });
  return create;
};

describe('Settings › Account passkeys', () => {
  it('[web-075] lists the passkeys and adds one under the name given', async () => {
    world.passkeys = [{ id: 'cred-1', name: 'Laptop key' }];
    const create = stubPasskeys();
    const { user } = render();
    await openTab(user, 'Account');
    expect(await rowOf('Laptop key')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add passkey' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(dialog.getByLabelText('Name'), 'Phone key');
    await user.click(dialog.getByRole('button', { name: 'Save' }));

    expect(await rowOf('Phone key')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(world.passkeys.map((passkey) => passkey.name)).toEqual(['Laptop key', 'Phone key']);
  });

  it('[web-075] removes a passkey only after the confirmation', async () => {
    world.passkeys = [{ id: 'cred-1', name: 'Laptop key' }];
    stubPasskeys();
    const { user } = render();
    await openTab(user, 'Account');
    await user.click(within(await rowOf('Laptop key')).getByRole('button', { name: 'Remove' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(world.passkeys).toHaveLength(1);
    await user.click(dialog.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByText('Laptop key')).not.toBeInTheDocument());
    expect(world.passkeys).toEqual([]);
  });

  it('[web-075] says so when the browser cannot register a passkey', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    const { user } = render();
    await openTab(user, 'Account');
    expect(await screen.findByText('This browser cannot register a passkey.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeDisabled();
  });
});

describe('Settings › Account export and import', () => {
  const capture = () => {
    const blobs: Blob[] = [];
    const names: string[] = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return 'blob:export';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    return { blobs, names };
  };

  it('[web-075] exports the key setup and every table as one file', async () => {
    const setup = await world.seedKeySetup();
    world.exportRows.task = [{ id: 'one' }, { id: 'two' }];
    world.exportRows.setting = [
      { document: 'abe1.x', version: 1, updatedAt: '2026-11-25T10:00:00Z' },
    ];
    const saved = capture();
    const { user } = render();
    await openTab(user, 'Account');
    await user.click(await screen.findByRole('button', { name: 'Export' }));

    expect(await screen.findByRole('status')).toHaveTextContent('The export was saved.');
    expect(saved.names).toEqual(['rumo-export.ndjson']);
    const lines = (await saved.blobs[0]!.text()).split('\n').filter((line) => line !== '');
    const header = parseBoardExportLine(lines[0] ?? '', 0);
    expect(header).toMatchObject({ format: BOARD_EXPORT_FORMAT, version: BOARD_EXPORT_VERSION });
    const records = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      owner: 'owner',
      table: 'user',
      row: { keyId: setup.keyId, keySlots: setup.slots },
    });
    expect(records.filter((record) => record.table === 'task').map((record) => record.row)).toEqual(
      [{ id: 'one' }, { id: 'two' }],
    );
    expect(records.find((record) => record.table === 'document')?.row).toMatchObject({
      kind: 'settings',
      version: 1,
    });
    expect(world.exportPages.get('task')).toEqual(['', 'page-2']);
  });

  const exportFile = async (keyId: string): Promise<File> => {
    const setup = await world.seedKeySetup();
    const lines = [
      {
        format: BOARD_EXPORT_FORMAT,
        version: BOARD_EXPORT_VERSION,
        createdAt: '2026-11-25T10:00:00.000Z',
        source: { kind: 'api', version: '1.0.0' },
      },
      {
        owner: 'owner',
        table: 'user',
        row: {
          createdAt: '2026-11-25T10:00:00.000Z',
          keyId,
          keySlots: setup.slots,
          source: null,
        },
      },
      {
        owner: 'owner',
        table: 'project',
        row: {
          id: '11111111-1111-4111-8111-111111111111',
          name: null,
          icon: null,
          position: 0,
          isDefault: true,
          archivedAt: null,
          createdAt: '2026-11-25T10:00:00.000Z',
          updatedAt: '2026-11-25T10:00:00.000Z',
        },
      },
    ];
    return new File([lines.map((line) => JSON.stringify(line)).join('\n')], 'export.ndjson');
  };

  it('[web-075] imports the rows of an export made with the same key', async () => {
    const keys = await OWNER_KEYS;
    const file = await exportFile(keys.keyId);
    const { user } = render();
    await openTab(user, 'Account');
    await screen.findByRole('button', { name: 'Import' });
    await user.upload(screen.getByLabelText('Import file'), file);

    expect(await screen.findByRole('status')).toHaveTextContent('Imported 1 rows.');
    expect(world.imports).toHaveLength(1);
    expect(world.imports[0]).toMatchObject({ table: 'project', keyId: keys.keyId });
  });

  it('[web-075] refuses an export made with another key and imports nothing', async () => {
    const file = await exportFile('f'.repeat(16));
    const { user } = render();
    await openTab(user, 'Account');
    await screen.findByRole('button', { name: 'Import' });
    await user.upload(screen.getByLabelText('Import file'), file);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file was exported with a different encryption key.',
    );
    expect(world.imports).toEqual([]);
  });

  it('[web-075] refuses a file that is not an export', async () => {
    const { user } = render();
    await openTab(user, 'Account');
    await screen.findByRole('button', { name: 'Import' });
    await user.upload(screen.getByLabelText('Import file'), new File(['hello'], 'notes.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This file is not an account export.',
    );
    expect(world.imports).toEqual([]);
  });

  it('[web-075] offers no export or import on a server without it', async () => {
    world.features = [];
    const { user } = render();
    await openTab(user, 'Account');
    expect(await screen.findByText('This server does not offer board export.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });
});

describe('Settings › Account deletion', () => {
  it('[web-075] deletes the account only once the username is typed', async () => {
    const { user } = render();
    await openTab(user, 'Account');
    await user.click(await screen.findByRole('button', { name: 'Delete account' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByText(/0 tasks, 0 schedules/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Delete account' });
    expect(confirm).toBeDisabled();

    await user.type(dialog.getByLabelText('Type your username'), 'owne');
    expect(confirm).toBeDisabled();
    await user.type(dialog.getByLabelText('Type your username'), 'r');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(world.deleted).toBe('owner'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('Settings › Versions', () => {
  it('[web-076] shows the client and server versions with their commits', async () => {
    const check = async () => ({
      state: 'up' as const,
      server: serverVersion({ server: { version: '2.3.4', commit: 'abc1234' } }),
    });
    const { user } = render(check);
    await openTab(user, 'Versions');
    const table = await screen.findByRole('table', { name: 'Versions' });
    const client = within(
      within(table).getByRole('rowheader', { name: 'Browser client' }).closest('tr')!,
    );
    expect(client.getByText(PART_VERSION)).toBeInTheDocument();
    expect(client.getByText(BUILD_COMMIT ?? 'not reported')).toBeInTheDocument();
    const server = within(within(table).getByRole('rowheader', { name: 'Server' }).closest('tr')!);
    expect(server.getByText('2.3.4')).toBeInTheDocument();
    expect(server.getByText('abc1234')).toBeInTheDocument();
  });

  it('[web-076] says when the server reports no commit', async () => {
    const { user } = render();
    await openTab(user, 'Versions');
    const table = await screen.findByRole('table', { name: 'Versions' });
    const row = within(within(table).getByRole('rowheader', { name: 'Server' }).closest('tr')!);
    expect(row.getByText('1.0.0')).toBeInTheDocument();
    expect(row.getByText('not reported')).toBeInTheDocument();
  });
});
