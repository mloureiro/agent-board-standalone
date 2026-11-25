import { listen } from '@tauri-apps/api/event';

import { h } from '../shared/dom.js';
import {
  command,
  type OpenFailure,
  type ServerEntry,
  type StoreFailure,
  type WindowError,
} from '../shared/invoke.js';
import './list.css';

const alerts = h('div', { role: 'alert' });
const rows = h('ul', { 'aria-label': 'Servers' });

function showError(text: string, retry?: () => void): void {
  const line = h('p', {}, text);
  if (retry) {
    line.append(' ', h('button', { type: 'button' }, 'Retry'));
    line.querySelector('button')?.addEventListener('click', () => {
      line.remove();
      retry();
    });
  }
  alerts.append(line);
}

async function guarded(job: () => Promise<unknown>): Promise<void> {
  try {
    await job();
  } catch (failure) {
    showError(failure instanceof Error ? failure.message : String(failure));
  }
}

function row(entry: ServerEntry): HTMLElement {
  const open = h('button', { type: 'button' }, 'Open');
  const remove = h('button', { type: 'button' }, 'Remove');
  open.addEventListener('click', () => {
    void guarded(() => command('open_server', { serverId: entry.id }));
  });
  remove.addEventListener('click', () => {
    void guarded(async () => {
      await command('list_remove_server', { serverId: entry.id });
      await refresh();
    });
  });
  return h(
    'li',
    {},
    h('span', { class: 'entry' }, h('strong', {}, entry.name), h('small', {}, entry.url)),
    open,
    remove,
  );
}

async function refresh(): Promise<void> {
  const servers = await command<ServerEntry[]>('list_servers');
  rows.replaceChildren(...servers.map(row));
}

function addForm(): HTMLFormElement {
  const name = h('input', {
    name: 'name',
    placeholder: 'Name',
    'aria-label': 'Name',
    required: '',
  });
  const address = h('input', {
    name: 'address',
    placeholder: 'Address',
    'aria-label': 'Address',
    required: '',
  });
  const form = h('form', {}, name, address, h('button', { type: 'submit' }, 'Add server'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void guarded(async () => {
      await command('list_add_server', { name: name.value, address: address.value });
      form.reset();
      await refresh();
    });
  });
  return form;
}

async function start(): Promise<void> {
  const all = h('button', { type: 'button' }, 'All servers');
  all.addEventListener('click', () => {
    void guarded(() => command('open_all_servers'));
  });
  document
    .getElementById('root')
    ?.append(h('header', {}, h('h1', {}, 'Agent Board'), all), alerts, rows, addForm());

  await listen<StoreFailure>('store-deletion-failed', ({ payload }) => {
    showError(payload.message, () => {
      void guarded(() => command('retry_store_deletion', { serverId: payload.serverId }));
    });
  });
  await listen<WindowError>('window-error', ({ payload }) => {
    showError(payload.message);
  });
  await guarded(refresh);
  const failures = await command<OpenFailure[]>('take_open_failures').catch(() => []);
  for (const failure of failures) showError(failure.text);
}

void start();
