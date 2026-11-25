import {
  bindings,
  decodeDataKey,
  deriveKeys,
  generateDataKey,
  open as openEnvelope,
  unwrapSlot,
  wrapSlot,
} from '@agent-board/sealing';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATA_KEYS_NAME, writeStoredKeys } from '../src/keys/stored-keys.js';
import { serverNamespace } from '../src/storage/index.js';
import { fixedRegistry } from './fake-board.js';
import { GOLDEN, KeyBoard, TEST_KDF } from './key-board.js';
import { renderApp } from './render.js';

const HOME = { id: 'srv-1', name: 'Local', url: 'http://localhost/' };
const FORBIDDEN_DETAIL = /attempt|lock(ed|out)|too many|try again in|slot|argon|decrypt|salt/i;

const open = (board: KeyBoard, options: Parameters<typeof renderApp>[0] = {}) => {
  vi.stubGlobal('fetch', board.fetch);
  return renderApp({
    check: 'real',
    inspectKeys: 'real',
    kdf: TEST_KDF,
    registry: fixedRegistry([HOME]),
    ...options,
  });
};

const storedKeys = () => serverNamespace(HOME.id).secrets.get(DATA_KEYS_NAME);

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unlocking', () => {
  it('[web-020] a client with no stored key asks for the passphrase and opens the board with the right one', async () => {
    const board = new KeyBoard();
    const { user } = open(board);
    await user.type(await screen.findByLabelText('Passphrase'), GOLDEN.passphrase);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
  });

  it('[web-020] a wrong passphrase only says it is wrong', async () => {
    const board = new KeyBoard();
    const { user } = open(board);
    await user.type(await screen.findByLabelText('Passphrase'), `${GOLDEN.passphrase} but wrong`);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Wrong passphrase\.$/);
    expect(alert.textContent).not.toMatch(FORBIDDEN_DETAIL);
    expect(screen.queryByText(FORBIDDEN_DETAIL)).toBeNull();
    expect(await storedKeys()).toBeUndefined();
  });

  it('[web-020] the keys a passphrase opens read a golden envelope', async () => {
    const dataKey = decodeDataKey(GOLDEN.sealed.dataKey);
    const board = new KeyBoard({
      setup: {
        keyId: GOLDEN.sealed.keyId,
        slots: [
          await wrapSlot(dataKey, { kind: 'passphrase', passphrase: GOLDEN.passphrase }, TEST_KDF),
        ],
      },
    });
    const { user } = open(board);
    await user.type(await screen.findByLabelText('Passphrase'), GOLDEN.passphrase);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('heading', { name: 'Board' });
    const stored = (await storedKeys()) as Parameters<typeof openEnvelope>[0];
    expect(stored.keyId).toBe(GOLDEN.sealed.keyId);
    expect(stored.owner).toBe(GOLDEN.owner);
    await expect(
      openEnvelope(stored, bindings.title({ task: GOLDEN.title.task }), GOLDEN.title.envelope),
    ).resolves.toBe(GOLDEN.title.plaintext);
  });
});

describe('after one unlock', () => {
  it('[web-026] a restart of the client opens the server unlocked', async () => {
    const board = new KeyBoard();
    const first = open(board);
    await first.user.type(await screen.findByLabelText('Passphrase'), GOLDEN.passphrase);
    await first.user.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('heading', { name: 'Board' });
    first.unmount();

    open(board);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
  });
});

const unlock = async (user: ReturnType<typeof open>['user'], passphrase = GOLDEN.passphrase) => {
  await user.type(await screen.findByLabelText('Passphrase'), passphrase);
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
};

const passphraseOpens = async (board: KeyBoard, passphrase: string): Promise<boolean> =>
  unwrapSlot(board.setup?.slots ?? [], { kind: 'passphrase', passphrase }).then(
    () => true,
    () => false,
  );

describe('key setup', () => {
  const SETUP_PASSPHRASE = 'first passphrase here';

  const fill = async (
    user: ReturnType<typeof open>['user'],
    passphrase: string,
    confirmation: string,
  ) => {
    await user.type(await screen.findByLabelText('Passphrase'), passphrase);
    await user.type(screen.getByLabelText('Confirm passphrase'), confirmation);
    await user.click(screen.getByRole('checkbox', { name: /first time/i }));
  };

  it('[web-019] two different passphrases are refused and nothing is created', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await fill(user, SETUP_PASSPHRASE, 'a different passphrase');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/match/i);
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
    expect(board.setup).toBeNull();
  });

  it('[web-019] a passphrase that is too short is refused with the length asked for', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await fill(user, 'short', 'short');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 14 characters/);
    expect(board.setup).toBeNull();
  });

  it('[web-019] the first-time box is needed before the key is created', async () => {
    const { user } = open(new KeyBoard({ setup: null }));
    await user.type(await screen.findByLabelText('Passphrase'), SETUP_PASSPHRASE);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('[web-019] the recovery key is shown once and Done waits for the stored box', async () => {
    const board = new KeyBoard({ setup: null });
    const { user, unmount } = open(board);
    await fill(user, SETUP_PASSPHRASE, SETUP_PASSPHRASE);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const field = await screen.findByLabelText('Recovery key');
    const recoveryKey = (field as HTMLInputElement).value;
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
    await expect(
      unwrapSlot(board.setup?.slots ?? [], { kind: 'recovery', recoveryKey }),
    ).resolves.toHaveLength(32);
    await expect(passphraseOpens(board, SETUP_PASSPHRASE)).resolves.toBe(true);

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /stored/i }));
    expect(done).toBeEnabled();
    await user.click(done);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Recovery key')).toBeNull();
    expect(document.body.innerHTML).not.toContain(recoveryKey);
    unmount();

    open(board);
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(recoveryKey);
  });

  it('[web-019] a key another tab already created is reported and the unlock screen follows', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await fill(user, SETUP_PASSPHRASE, SETUP_PASSPHRASE);
    board.setup = JSON.parse(JSON.stringify(GOLDEN.setup));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(screen.getByLabelText('Passphrase')).toBeInTheDocument();
  });
});

describe('recovery key', () => {
  const NEW_PASSPHRASE = 'a brand new passphrase';

  const openRecovery = async (board: KeyBoard) => {
    const view = open(board);
    await view.user.click(await screen.findByRole('button', { name: /recovery key instead/i }));
    return view;
  };

  it('[web-021] the recovery key opens the data together with a new passphrase', async () => {
    const board = new KeyBoard();
    const { user } = await openRecovery(board);
    await user.type(screen.getByLabelText('Recovery key'), GOLDEN.recoveryKey);
    await user.type(screen.getByLabelText('New passphrase'), NEW_PASSPHRASE);
    await user.type(screen.getByLabelText('Confirm new passphrase'), NEW_PASSPHRASE);
    await user.click(screen.getByRole('button', { name: /set passphrase/i }));

    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    await expect(passphraseOpens(board, NEW_PASSPHRASE)).resolves.toBe(true);
    await expect(passphraseOpens(board, GOLDEN.passphrase)).resolves.toBe(false);
    await expect(
      unwrapSlot(board.setup?.slots ?? [], { kind: 'recovery', recoveryKey: GOLDEN.recoveryKey }),
    ).resolves.toHaveLength(32);
    expect(board.setup?.keyId).toBe(GOLDEN.keyId);
  });

  it('[web-021] the recovery key alone does not unlock: a new passphrase is required', async () => {
    const board = new KeyBoard();
    const { user } = await openRecovery(board);
    await user.type(screen.getByLabelText('Recovery key'), GOLDEN.recoveryKey);
    await user.click(screen.getByRole('button', { name: /set passphrase/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 14 characters/);
    expect(board.calls.some((call) => call.path.endsWith('/keys/replace-slots'))).toBe(false);
    expect(await storedKeys()).toBeUndefined();
  });

  it('[web-021] a new passphrase typed twice differently is refused', async () => {
    const board = new KeyBoard();
    const { user } = await openRecovery(board);
    await user.type(screen.getByLabelText('Recovery key'), GOLDEN.recoveryKey);
    await user.type(screen.getByLabelText('New passphrase'), NEW_PASSPHRASE);
    await user.type(screen.getByLabelText('Confirm new passphrase'), `${NEW_PASSPHRASE}!`);
    await user.click(screen.getByRole('button', { name: /set passphrase/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/match/i);
  });

  it('[web-021] a wrong recovery key changes nothing', async () => {
    const board = new KeyBoard();
    const before = JSON.stringify(board.setup);
    const { user } = await openRecovery(board);
    const wrong = GOLDEN.recoveryKey.replace(/^D9ZY/, 'D9ZZ');
    await user.type(screen.getByLabelText('Recovery key'), wrong);
    await user.type(screen.getByLabelText('New passphrase'), NEW_PASSPHRASE);
    await user.type(screen.getByLabelText('Confirm new passphrase'), NEW_PASSPHRASE);
    await user.click(screen.getByRole('button', { name: /set passphrase/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/recovery key/i);
    expect(JSON.stringify(board.setup)).toBe(before);
  });
});

describe('stored key does not match the server', () => {
  const storeKeyFor = async (owner: string) => {
    await writeStoredKeys(HOME.id, await deriveKeys(generateDataKey(), owner));
  };

  it('[web-022] a key of another key id blocks the board until FORGET is typed', async () => {
    await storeKeyFor(GOLDEN.owner);
    const board = new KeyBoard();
    const { user } = open(board);
    const region = await screen.findByRole('region', { name: /stored key does not match/i });
    expect(region).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Board' })).toBeNull();
    const forget = screen.getByRole('button', { name: 'Forget key' });
    expect(forget).toBeDisabled();

    await user.type(screen.getByLabelText(/type forget/i), 'forget');
    expect(forget).toBeDisabled();
    await user.clear(screen.getByLabelText(/type forget/i));
    await user.type(screen.getByLabelText(/type forget/i), 'FORGET');
    expect(forget).toBeEnabled();
    await user.click(forget);

    expect(await screen.findByLabelText('Passphrase')).toBeInTheDocument();
    expect(await storedKeys()).toBeUndefined();
  });

  it('[web-022] a key of another owner is blocked the same way', async () => {
    await storeKeyFor('somebody-else');
    const { user } = open(new KeyBoard());
    expect(await screen.findByRole('region', { name: /stored key does not match/i })).toBeVisible();
    await user.type(screen.getByLabelText(/type forget/i), 'FORGET');
    await user.click(screen.getByRole('button', { name: 'Forget key' }));
    expect(await screen.findByLabelText('Passphrase')).toBeInTheDocument();
  });

  it('[web-022] a server that holds no key at all also blocks a stored one', async () => {
    await storeKeyFor(GOLDEN.owner);
    open(new KeyBoard({ setup: null }));
    expect(await screen.findByRole('region', { name: /stored key does not match/i })).toBeVisible();
  });

  it('[web-022] the key the server reports opens the board with no screen in between', async () => {
    const dataKey = generateDataKey();
    const keys = await deriveKeys(dataKey, GOLDEN.owner);
    await writeStoredKeys(HOME.id, keys);
    open(
      new KeyBoard({
        setup: {
          keyId: keys.keyId,
          slots: [
            await wrapSlot(
              dataKey,
              { kind: 'passphrase', passphrase: GOLDEN.passphrase },
              TEST_KDF,
            ),
          ],
        },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
  });
});

describe('storage of keys', () => {
  it('[web-025] the derived keys are non-extractable, held per server, and the passphrase and data key are in no store', async () => {
    const dataKey = decodeDataKey(GOLDEN.sealed.dataKey);
    const board = new KeyBoard({
      setup: {
        keyId: GOLDEN.sealed.keyId,
        slots: [
          await wrapSlot(dataKey, { kind: 'passphrase', passphrase: GOLDEN.passphrase }, TEST_KDF),
        ],
      },
    });
    const { user } = open(board);
    await unlock(user);
    await screen.findByRole('heading', { name: 'Board' });

    expect((await indexedDB.databases()).map((entry) => entry.name)).toEqual([
      `agent-board:${HOME.id}`,
    ]);
    const namespace = serverNamespace(HOME.id);
    expect(await namespace.secrets.names()).toEqual([DATA_KEYS_NAME]);
    const stored = (await namespace.secrets.get(DATA_KEYS_NAME)) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'content',
      'index',
      'keyId',
      'owner',
      'transcript',
    ]);
    for (const name of ['content', 'index', 'transcript']) {
      const key = stored[name] as CryptoKey;
      expect(key.extractable).toBe(false);
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    }

    const everything = [
      JSON.stringify(stored),
      ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map((key) => `${key}=${sessionStorage.getItem(key)}`),
    ].join('\n');
    expect(everything).not.toContain(GOLDEN.passphrase);
    expect(everything).not.toContain(GOLDEN.sealed.dataKey.slice('abk1_'.length));
  });

  it('[web-025] a stored key that is extractable is not trusted', async () => {
    const raw = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
    ]);
    await serverNamespace(HOME.id).secrets.put(DATA_KEYS_NAME, {
      owner: GOLDEN.owner,
      keyId: GOLDEN.keyId,
      content: raw,
      transcript: raw,
      index: raw,
    });
    open(new KeyBoard());
    expect(await screen.findByLabelText('Passphrase')).toBeInTheDocument();
  });

  it('[web-025] each server keeps its keys in its own database', async () => {
    const other = serverNamespace('srv-other');
    await other.secrets.put(DATA_KEYS_NAME, 'not this server');
    const { user } = open(new KeyBoard());
    await unlock(user);
    await screen.findByRole('heading', { name: 'Board' });
    expect(await other.secrets.get(DATA_KEYS_NAME)).toBe('not this server');
    expect((await indexedDB.databases()).map((entry) => entry.name).sort()).toEqual([
      'agent-board:srv-1',
      'agent-board:srv-other',
    ]);
  });
});

describe('Settings › Encryption', () => {
  const NEXT = 'a brand new passphrase';
  const openSettings = async (board: KeyBoard) => {
    const view = open(board);
    await unlock(view.user);
    await view.user.click(await screen.findByRole('link', { name: 'Settings' }));
    await view.user.click(await screen.findByRole('tab', { name: 'Encryption' }));
    return view;
  };

  const fillChange = async (
    user: ReturnType<typeof open>['user'],
    current: string,
    next: string,
    confirmation: string = next,
  ) => {
    await user.type(screen.getByLabelText('Current passphrase'), current);
    await user.type(screen.getByLabelText('New passphrase'), next);
    await user.type(screen.getByLabelText('Confirm new passphrase'), confirmation);
    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
  };

  it('[web-024] the passphrase changes with the current one and only the new one opens afterwards', async () => {
    const board = new KeyBoard();
    const { user } = await openSettings(board);
    await fillChange(user, GOLDEN.passphrase, NEXT);
    expect(await screen.findByRole('status')).toHaveTextContent('Passphrase changed.');
    await expect(passphraseOpens(board, NEXT)).resolves.toBe(true);
    await expect(passphraseOpens(board, GOLDEN.passphrase)).resolves.toBe(false);
    expect(board.setup?.slots.map((slot) => slot.kind)).toEqual(['passphrase', 'recovery']);
    expect(board.setup?.keyId).toBe(GOLDEN.keyId);
  });

  it('[web-024] a wrong current passphrase only says it is wrong and changes nothing', async () => {
    const board = new KeyBoard();
    const before = JSON.stringify(board.setup);
    const { user } = await openSettings(board);
    await fillChange(user, 'not the current one', NEXT);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Wrong passphrase\.$/);
    expect(JSON.stringify(board.setup)).toBe(before);
  });

  it('[web-024] a new passphrase confirmed differently is refused before anything is sent', async () => {
    const board = new KeyBoard();
    const { user } = await openSettings(board);
    await fillChange(user, GOLDEN.passphrase, NEXT, `${NEXT}!`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/match/i);
    expect(board.calls.some((call) => call.path.endsWith('/keys/replace-slots'))).toBe(false);
  });

  it('[web-024] a context opened later takes only the new passphrase', async () => {
    const board = new KeyBoard();
    const first = await openSettings(board);
    await fillChange(first.user, GOLDEN.passphrase, NEXT);
    await screen.findByRole('status');
    first.unmount();
    await serverNamespace(HOME.id).destroy();

    const second = open(board);
    await unlock(second.user, GOLDEN.passphrase);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Wrong passphrase\.$/);
    await second.user.clear(screen.getByLabelText('Passphrase'));
    await second.user.type(screen.getByLabelText('Passphrase'), NEXT);
    await second.user.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.queryByLabelText('Passphrase')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
  });
});

describe('account export at setup', () => {
  const NOW = '2026-11-25T08:00:00.000Z';
  const PROJECT = '5b2c7a52-6f0d-4c1e-9f2c-2f0f6a3f3a11';
  const SEALED = 'abe1.Ymn-iyFdLkBxtDTNPwhDo0fxh9VYZBLxTKJTpjBOPAoAr7WEe3rDpTCh_YHhOweRNW1WNw';

  const exportText = (owner: string = GOLDEN.owner, withKey = true): string =>
    [
      {
        format: 'agent-board-export',
        version: 1,
        createdAt: NOW,
        source: { kind: 'api', version: '1.0.0' },
      },
      {
        owner,
        table: 'user',
        row: {
          createdAt: NOW,
          keyId: withKey ? GOLDEN.setup.keyId : null,
          keySlots: withKey ? GOLDEN.setup.slots : null,
          source: null,
        },
      },
      {
        owner,
        table: 'project',
        row: {
          id: PROJECT,
          name: SEALED,
          icon: null,
          position: 0,
          isDefault: true,
          archivedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');

  const chooseExport = async (
    user: ReturnType<typeof open>['user'],
    text: string,
    passphrase: string = GOLDEN.passphrase,
  ) => {
    await user.click(await screen.findByRole('button', { name: /import an account export/i }));
    await user.upload(
      screen.getByLabelText('Account export file'),
      new File([text], 'account.ndjson', { type: 'application/x-ndjson' }),
    );
    await user.type(screen.getByLabelText('Passphrase of the export'), passphrase);
    await user.click(screen.getByRole('button', { name: 'Import' }));
  };

  it('[web-023] setup offers importing an export, which restores the key and the rows', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await chooseExport(user, exportText());
    expect(await screen.findByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(board.setup?.keyId).toBe(GOLDEN.keyId);
    await expect(passphraseOpens(board, GOLDEN.passphrase)).resolves.toBe(true);
    expect(board.imported).toEqual([
      { table: 'project', keyId: GOLDEN.keyId, rows: [expect.objectContaining({ id: PROJECT })] },
    ]);
    const stored = (await storedKeys()) as { keyId: string };
    expect(stored.keyId).toBe(GOLDEN.keyId);
  });

  it('[web-023] a wrong passphrase for the export sets nothing up', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await chooseExport(user, exportText(), 'not the export passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Wrong passphrase\.$/);
    expect(board.setup).toBeNull();
    expect(board.imported).toEqual([]);
  });

  it('[web-023] an export of another account is refused', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await chooseExport(user, exportText('somebody-else'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not belong to/i);
    expect(board.setup).toBeNull();
  });

  it('[web-023] a file that is not an export is refused', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await chooseExport(user, 'this is not an export');
    expect(await screen.findByRole('alert')).toHaveTextContent(/not an account export/i);
    expect(board.setup).toBeNull();
  });

  it('[web-023] an export with no key is refused', async () => {
    const board = new KeyBoard({ setup: null });
    const { user } = open(board);
    await chooseExport(user, exportText(GOLDEN.owner, false));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no encryption key/i);
    expect(board.setup).toBeNull();
  });
});
