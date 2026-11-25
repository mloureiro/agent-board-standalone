import { decodeDataKey, deriveKeys } from '@agent-board/sealing';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixedRegistry, json } from './fake-board.js';
import { GOLDEN, KeyBoard, TEST_KDF } from './key-board.js';
import { openTab } from './page-helpers.js';
import { TOKEN } from './pages-world.js';
import { renderApp } from './render.js';

const HOME = { id: 'srv-1', name: 'Local', url: 'http://localhost/' };

class MachineBoard extends KeyBoard {
  readonly issued: string[] = [];

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (method === 'GET' && path === '/api/client/machines/list') {
      return json(200, { machines: [] });
    }
    if (method === 'POST' && path === '/api/client/machines/issue') {
      this.issued.push(String(body?.name));
      return json(200, { token: TOKEN });
    }
    return super.answer(method, path, body);
  }
}

const open = (board: MachineBoard) => {
  vi.stubGlobal('fetch', board.fetch);
  return renderApp({
    path: '/settings',
    check: 'real',
    inspectKeys: 'real',
    kdf: TEST_KDF,
    registry: fixedRegistry([HOME]),
  });
};

const unlock = async (user: ReturnType<typeof open>['user']): Promise<void> => {
  await user.type(await screen.findByLabelText('Passphrase'), GOLDEN.passphrase);
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  await screen.findByRole('heading', { name: 'Settings' });
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('data key shown for a machine', () => {
  it('[web-069] a client unlocked with the passphrase shows the data key without asking again', async () => {
    const board = new MachineBoard({ features: ['machine-grant'] });
    const { user } = open(board);
    await unlock(user);
    await openTab(user, 'Machines');
    await user.click(await screen.findByRole('button', { name: 'Add machine' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByLabelText('Passphrase')).not.toBeInTheDocument();
    await user.type(dialog.getByLabelText('Name'), 'build-1');
    await user.click(dialog.getByRole('button', { name: 'Add machine' }));

    expect(await dialog.findByText(TOKEN)).toBeInTheDocument();
    const text = screen.getByRole('dialog').textContent ?? '';
    const dataKey = /abk1_[A-Za-z0-9_-]{43}/.exec(text)?.[0] ?? '';
    expect((await deriveKeys(decodeDataKey(dataKey), GOLDEN.owner)).keyId).toBe(GOLDEN.keyId);
  });

  it('[web-069] a client restored from its stored keys asks for the passphrase first', async () => {
    const board = new MachineBoard({ features: ['machine-grant'] });
    const first = open(board);
    await unlock(first.user);
    first.unmount();

    const { user } = open(board);
    await screen.findByRole('heading', { name: 'Settings' });
    await openTab(user, 'Machines');
    await user.click(await screen.findByRole('button', { name: 'Add machine' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText('Passphrase')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Add machine' })).toBeDisabled();
    await user.type(dialog.getByLabelText('Name'), 'build-2');
    await user.type(dialog.getByLabelText('Passphrase'), GOLDEN.passphrase);
    await user.click(dialog.getByRole('button', { name: 'Add machine' }));

    expect(await dialog.findByText(TOKEN)).toBeInTheDocument();
    expect(board.issued).toEqual(['build-2']);
  });
});
