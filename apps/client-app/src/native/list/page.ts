import { listen } from '@tauri-apps/api/event';
import { ADDRESS_PROBLEM_MESSAGES, BLANK_NAME_MESSAGE, serverNamespace } from '@agent-board/web';

import { h } from '../shared/dom.js';
import {
  command,
  type OpenFailure,
  type ServerEntry,
  type StoreFailure,
  type WindowError,
} from '../shared/invoke.js';

export const DELETION_RETRY_DELAYS_MS: readonly number[] = [200, 500, 1000, 2000, 4000];

export interface ListOptions {
  readonly destroyNamespace?: (serverId: string) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];
}

interface Purge {
  readonly purge: string;
}

const NAMESPACE_DATABASE = /^agent-board:([0-9a-f-]{36})$/;
const NAMESPACE_KEY = /^ab:([0-9a-f-]{36}):/;
const ADDRESS_ERROR = /^address (\w+)$/;
const BLANK_NAME_ERROR = 'the name is blank';

const messageOf = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

function addFormProblem(failure: unknown): string {
  const text = messageOf(failure);
  const code = ADDRESS_ERROR.exec(text)?.[1];
  if (code !== undefined && code in ADDRESS_PROBLEM_MESSAGES) {
    return ADDRESS_PROBLEM_MESSAGES[code as keyof typeof ADDRESS_PROBLEM_MESSAGES];
  }
  return text === BLANK_NAME_ERROR ? BLANK_NAME_MESSAGE : text;
}

export async function mountList(root: HTMLElement, options: ListOptions = {}): Promise<void> {
  const destroyNamespace =
    options.destroyNamespace ?? ((serverId: string) => serverNamespace(serverId).destroy());
  const retryDelays = options.retryDelaysMs ?? DELETION_RETRY_DELAYS_MS;

  const alerts = h('div', { role: 'alert' });
  const rows = h('ul', { 'aria-label': 'Servers' });
  const formProblem = h('p', { role: 'alert', class: 'problem' });

  function showError(text: string, retry?: () => void): void {
    const line = h('p', {}, text);
    const action = h('button', { type: 'button' }, retry ? 'Retry' : 'Dismiss');
    action.addEventListener('click', () => {
      line.remove();
      retry?.();
    });
    line.append(' ', action);
    alerts.append(line);
  }

  async function guarded(job: () => Promise<unknown>): Promise<void> {
    try {
      await job();
    } catch (failure) {
      showError(messageOf(failure));
    }
  }

  async function destroyWithRetry(serverId: string): Promise<boolean> {
    for (const delay of [0, ...retryDelays]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await destroyNamespace(serverId);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async function purgeNamespace(entry: ServerEntry): Promise<void> {
    if (await destroyWithRetry(entry.id)) return;
    showError(`Couldn't delete the stored data of ${entry.name}.`, () => {
      void purgeNamespace(entry);
    });
  }

  async function sweepUnlisted(listed: ReadonlySet<string>): Promise<void> {
    const found = new Set<string>();
    for (const database of await indexedDB.databases()) {
      const id = NAMESPACE_DATABASE.exec(database.name ?? '')?.[1];
      if (id !== undefined) found.add(id);
    }
    for (let index = 0; index < localStorage.length; index += 1) {
      const id = NAMESPACE_KEY.exec(localStorage.key(index) ?? '')?.[1];
      if (id !== undefined) found.add(id);
    }
    for (const id of found) {
      if (!listed.has(id)) await destroyNamespace(id).catch(() => undefined);
    }
  }

  function renameForm(entry: ServerEntry, done: () => void): HTMLFormElement {
    const name = h('input', { name: 'name', 'aria-label': 'Name', value: entry.name });
    const cancel = h('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', done);
    const form = h(
      'form',
      { class: 'inline' },
      name,
      h('button', { type: 'submit' }, 'Save'),
      cancel,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (name.value.trim() === '') {
        showError(BLANK_NAME_MESSAGE);
        return;
      }
      void guarded(async () => {
        try {
          await command('rename_server', { serverId: entry.id, name: name.value });
        } finally {
          await refresh();
        }
      });
    });
    return form;
  }

  function row(entry: ServerEntry): HTMLElement {
    const open = h('button', { type: 'button' }, 'Open');
    const rename = h('button', { type: 'button' }, 'Rename');
    const remove = h('button', { type: 'button' }, 'Remove');
    const item = h('li', {});
    const summary = h(
      'span',
      { class: 'entry' },
      h('strong', {}, entry.name),
      h('small', {}, entry.url),
    );
    const buttons = [open, rename, remove];
    item.append(summary, ...buttons);
    open.addEventListener('click', () => {
      void guarded(() => command('open_server', { serverId: entry.id }));
    });
    rename.addEventListener('click', () => {
      const form = renameForm(entry, () => item.replaceChildren(summary, ...buttons));
      item.replaceChildren(form);
      form.querySelector('input')?.focus();
    });
    remove.addEventListener('click', () => {
      void guarded(async () => {
        const outcome = await command<Purge | null>('list_remove_server', { serverId: entry.id });
        await refresh();
        if (outcome !== null) await purgeNamespace(entry);
      });
    });
    return item;
  }

  async function refresh(): Promise<ServerEntry[]> {
    const servers = await command<ServerEntry[]>('list_servers');
    rows.replaceChildren(...servers.map(row));
    return servers;
  }

  function addForm(): HTMLFormElement {
    const name = h('input', { name: 'name', placeholder: 'Name', 'aria-label': 'Name' });
    const address = h('input', {
      name: 'address',
      placeholder: 'Address',
      'aria-label': 'Address',
    });
    const form = h('form', {}, name, address, h('button', { type: 'submit' }, 'Add server'));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      formProblem.textContent = '';
      if (name.value.trim() === '') {
        formProblem.textContent = BLANK_NAME_MESSAGE;
        return;
      }
      void (async () => {
        try {
          await command('list_add_server', { name: name.value, address: address.value });
          form.reset();
          await refresh();
        } catch (failure) {
          formProblem.textContent = addFormProblem(failure);
        }
      })();
    });
    return form;
  }

  async function showQueuedFailures(): Promise<void> {
    const failures = await command<OpenFailure[]>('take_open_failures').catch(() => []);
    for (const failure of failures) showError(failure.text);
  }

  const all = h('button', { type: 'button' }, 'All servers');
  all.addEventListener('click', () => {
    void guarded(() => command('open_all_servers'));
  });
  root.append(
    h('header', {}, h('h1', {}, 'Agent Board'), all),
    alerts,
    rows,
    addForm(),
    formProblem,
  );

  await listen<StoreFailure>('store-deletion-failed', ({ payload }) => {
    showError(payload.message, () => {
      void guarded(() => command('retry_store_deletion', { serverId: payload.serverId }));
    });
  });
  await listen<WindowError>('window-error', ({ payload }) => {
    showError(payload.message);
  });
  await listen('open-failures-queued', () => {
    void showQueuedFailures();
  });
  await listen('servers-changed', () => {
    void guarded(refresh);
  });
  await guarded(async () => {
    const listed = await refresh();
    if (!(await command<boolean>('list_is_complete').catch(() => false))) return;
    await sweepUnlisted(new Set(listed.map((entry) => entry.id))).catch(() => undefined);
  });
  await showQueuedFailures();
}
